'use strict';
const crypto = require('crypto');
const { db, tx } = require('../db');
const { newId } = require('../ids');
const { nowIso } = require('../clock');
const { badRequest, conflict } = require('../errors');
const meetings = require('./meetings');
const tasksSvc = require('./tasks');

// 构造自包含快照：块 + 任务(含当时负责人沿革与"当前"签收标记) + 决议(含引用)。
// 一旦生成不可变；导出/正式渲染只读快照，因此事后改负责人不会污染历史纪要。
function buildSnapshotData(meetingId) {
  const m = meetings.getMeeting(meetingId);
  const rev = meetings.getRevision(meetingId, m.head_rev);
  const blocks = JSON.parse(rev.blocks_json);

  const tasks = tasksSvc.listTasks(meetingId).map(t => ({
    id: t.id, title: t.title, detail: t.detail, status: t.status,
    due_kind: t.due_kind, due_date: t.due_date, due_at_utc: t.due_at_utc, due_tz: t.due_tz,
    assignee: t.assignee,                       // 冻结"当时"负责人
    assignment_id: t.assignment_id,
    acknowledged_at_current: (t.acknowledgements || []).filter(a => a.assignment_id === t.assignment_id)
      .map(a => a.acknowledged_at),
    assignments: (t.assignments || []).map(a => ({ // 负责人沿革整体入快照
      id: a.id, assignee: a.assignee, change_type: a.change_type, reason: a.reason,
      changed_by: a.changed_by, changed_at: a.changed_at, superseded_at: a.superseded_at,
      acks: (t.acknowledgements || []).filter(k => k.assignment_id === a.id).map(k => ({
        by: k.acknowledged_by, at: k.acknowledged_at, note: k.note,
      })),
    })),
  }));

  const decisions = db().prepare('SELECT * FROM decisions WHERE meeting_id=? ORDER BY created_at,rowid').all(meetingId)
    .map(d => ({
      id: d.id, code: d.code, content: d.content, status: d.status,
      withdrawn_at: d.withdrawn_at, withdraw_reason: d.withdraw_reason,
      task_ids: db().prepare('SELECT task_id FROM decision_task_refs WHERE decision_id=? AND dropped_at IS NULL')
        .all(d.id).map(r => r.task_id),
    }));

  return {
    format: 'meeting-minutes-snapshot/1',
    captured_at: nowIso(),
    meeting: { id: m.id, title: m.title, timezone: m.timezone, status: m.status },
    revision: { id: rev.id, rev: rev.rev },
    blocks, tasks, decisions,
  };
}

function hashSnapshot(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function createSnapshot(meetingId, { kind, trigger, by, note }) {
  return tx(() => {
    const m = meetings.getMeeting(meetingId);
    const data = buildSnapshotData(meetingId);
    const hash = hashSnapshot(data);
    const seqRow = db().prepare('SELECT COALESCE(MAX(seq),0)+1 seq FROM snapshots WHERE meeting_id=?').get(meetingId);
    const id = newId('snap');
    const ts = nowIso();
    db().prepare(`INSERT INTO snapshots(id,meeting_id,kind,revision_id,seq,trigger,snapshot_json,content_hash,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, meetingId, kind, data.revision.id, seqRow.seq, trigger, JSON.stringify(data), hash, ts);
    return { id, seq: seqRow.seq, content_hash: hash, kind, captured_at: data.captured_at, note };
  });
}

// 定稿：幂等（同 idempotency_key 重放返回既有快照）；
// 校验负责人缺失（可选择 strict）；任务 provisional -> established 只发生一次。
// 部分失败恢复：若 established 转换与快照写入之间崩溃，重放时会复用/补建，绝不重复建任务。
function finalize(meetingId, { idempotency_key, by, allow_missing_assignees }) {
  if (!idempotency_key) throw badRequest('idempotency_key 必填（定稿重放防重）');
  return tx(() => {
    const m = meetings.getMeeting(meetingId);
    const existingKey = db().prepare('SELECT * FROM finalize_keys WHERE meeting_id=? AND idempotency_key=?')
      .get(meetingId, idempotency_key);

    // 同一幂等键重放：返回首次定稿产物，绝不二次转换/二次建快照（客户端重试安全）
    if (existingKey) {
      const snap = db().prepare('SELECT * FROM snapshots WHERE id=?').get(existingKey.snapshot_id);
      return { finalized: true, idempotent_replay: true, conflict: false,
               snapshot_id: existingKey.snapshot_id, snapshot_seq: snap && snap.seq,
               established_task_ids: [], rev: m.head_rev };
    }

    if (m.status !== 'draft') {
      // 已定稿且换了新 key：拒绝二次定稿
      const snap = db().prepare('SELECT * FROM snapshots WHERE meeting_id=? ORDER BY seq DESC LIMIT 1').get(meetingId);
      throw conflict('会议已定稿（如需相同结果请复用原 idempotency_key）', {
        already_finalized: true, snapshot_id: snap && snap.id,
      });
    }

    // 负责人缺失校验
    const missing = tasksSvc.missingAssignees(meetingId);
    if (missing.length && !allow_missing_assignees) {
      throw badRequest(`存在 ${missing.length} 个任务缺少负责人，无法定稿（可显式 allow_missing_assignees=true 接受）`,
        { missing });
    }

    const blocks = meetings.headBlocks(meetingId);
    const blockTaskIds = new Set(tasksSvc.referencedTaskIds(blocks));
    const allTasks = tasksSvc.listTasks(meetingId);
    const dangling = [...blockTaskIds].filter(id => !allTasks.some(t => t.id === id));
    if (dangling.length) throw badRequest('正文待办引用了不存在的任务', { dangling });

    // 1) 幂等建立任务：只把仍 provisional 的转 established（重复定稿不会重复转换）
    const ts = nowIso();
    const established = [];
    for (const t of allTasks) {
      if (t.status === 'provisional') {
        db().prepare("UPDATE tasks SET status='established', established_in_rev=?, updated_at=? WHERE id=? AND status='provisional'")
          .run(m.head_rev, ts, t.id);
        established.push(t.id);
      }
    }

    // 2) 定稿版本
    const revId = newId('rev');
    const newRev = m.head_rev + 1;
    db().prepare(`INSERT INTO meeting_revisions(id,meeting_id,rev,base_rev,change_type,author,blocks_json,note,created_at)
                  VALUES (?,?,?,?, 'finalize', ?,?,?,?)`)
      .run(revId, meetingId, newRev, m.head_rev, by || 'anonymous', JSON.stringify(blocks), '定稿', ts);

    // 3) 快照
    const snap = createSnapshot(meetingId, { kind: 'final', trigger: 'finalize', by });

    // 4) 会议状态翻转
    db().prepare(`UPDATE meetings SET status='finalized', head_rev=?, finalized_at=?, finalized_by=?, final_revision_id=?, updated_at=? WHERE id=?`)
      .run(newRev, ts, by || 'anonymous', revId, ts, meetingId);

    db().prepare('INSERT OR IGNORE INTO finalize_keys(meeting_id,idempotency_key,snapshot_id,created_at) VALUES (?,?,?,?)')
      .run(meetingId, idempotency_key, snap.id, ts);

    return { finalized: true, snapshot_id: snap.id, snapshot_seq: snap.seq, rev: newRev,
             established_task_ids: established, missing_assignees: missing, idempotent_replay: false };
  });
}

function getSnapshot(id) {
  const row = db().prepare('SELECT * FROM snapshots WHERE id=?').get(id);
  if (!row) throw badRequest(`快照不存在: ${id}`);
  return { ...row, data: JSON.parse(row.snapshot_json) };
}

function latestSnapshot(meetingId) {
  const row = db().prepare('SELECT * FROM snapshots WHERE meeting_id=? ORDER BY seq DESC LIMIT 1').get(meetingId);
  return row ? getSnapshot(row.id) : null;
}

function listSnapshots(meetingId) {
  return db().prepare('SELECT id,kind,seq,trigger,content_hash,created_at FROM snapshots WHERE meeting_id=? ORDER BY seq').all(meetingId);
}

module.exports = { buildSnapshotData, createSnapshot, finalize, getSnapshot, latestSnapshot, listSnapshots };
