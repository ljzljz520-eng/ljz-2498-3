'use strict';
const { db, tx } = require('../db');
const { newId } = require('../ids');
const { nowIso } = require('../clock');
const { badRequest, notFound, conflict } = require('../errors');
const meetings = require('./meetings');
const tasksSvc = require('./tasks');

function createDecision(meetingId, { code, content, task_ids, by }) {
  const m = meetings.getMeeting(meetingId);
  if (m.status !== 'draft') throw conflict('会议已定稿，不能新增决议（撤回请用独立接口）');
  if (!code || !content) throw badRequest('决议编号与内容必填');
  const ids = [...new Set(task_ids || [])];
  return tx(() => {
    const ts = nowIso();
    const id = newId('dec');
    try {
      db().prepare(`INSERT INTO decisions(id,meeting_id,code,content,status,created_in_rev,created_at)
                    VALUES (?,?,?,?,'active',?,?)`).run(id, meetingId, code, content, m.head_rev, ts);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict(`决议编号 ${code} 已存在`);
      throw e;
    }
    const linked = [];
    for (const tid of ids) {
      const t = db().prepare('SELECT * FROM tasks WHERE id=? AND meeting_id=?').get(tid, meetingId);
      if (!t) throw badRequest(`引用的任务不存在: ${tid}`);
      db().prepare(`INSERT INTO decision_task_refs(id,decision_id,task_id,created_by,created_at)
                    VALUES (?,?,?,?,?)`).run(newId('ref'), id, tid, by || 'anonymous', ts);
      linked.push(tid);
    }
    // 同一任务可被多个决议引用（UNIQUE 仅防同一决议重复）
    return decisionView(id);
  });
}

// 业务接口维护引用：加挂
function linkTask(meetingId, decisionId, { task_id, by }) {
  const d = mustGet(meetingId, decisionId);
  if (d.status !== 'active') throw conflict('决议已撤回，不能再挂引用');
  const t = db().prepare('SELECT * FROM tasks WHERE id=? AND meeting_id=?').get(task_id, meetingId);
  if (!t) throw badRequest(`任务不存在: ${task_id}`);
  try {
    db().prepare('INSERT INTO decision_task_refs(id,decision_id,task_id,created_by,created_at) VALUES (?,?,?,?,?)')
      .run(newId('ref'), decisionId, task_id, by || 'anonymous', nowIso());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      // 引用曾被 dropped（撤回又恢复场景不支持），这里直接返回现状
      throw conflict('该任务已挂在此决议下');
    }
    throw e;
  }
  return decisionView(decisionId);
}

function unlinkTask(meetingId, decisionId, taskId) {
  mustGet(meetingId, decisionId);
  const r = db().prepare('SELECT * FROM decision_task_refs WHERE decision_id=? AND task_id=? AND dropped_at IS NULL')
    .get(decisionId, taskId);
  if (r) db().prepare('UPDATE decision_task_refs SET dropped_at=? WHERE id=?').run(nowIso(), r.id);
  return decisionView(decisionId);
}

function mustGet(meetingId, id) {
  const d = db().prepare('SELECT * FROM decisions WHERE id=? AND meeting_id=?').get(id, meetingId);
  if (!d) throw notFound('决议不存在');
  return d;
}

function decisionView(id) {
  const d = db().prepare('SELECT * FROM decisions WHERE id=?').get(id);
  const refs = db().prepare('SELECT task_id FROM decision_task_refs WHERE decision_id=? AND dropped_at IS NULL').all(id);
  return { ...d, task_ids: refs.map(r => r.task_id) };
}

function listDecisions(meetingId) {
  meetings.getMeeting(meetingId);
  return db().prepare('SELECT id FROM decisions WHERE meeting_id=? ORDER BY created_at,rowid').all(meetingId)
    .map(r => decisionView(r.id));
}

// 决议撤回：定稿前后均可。只标记决议与其引用（dropped，不删行，可追溯）；
// 已建立的任务绝不因此自动取消；若已定稿则产生一条 amendment 快照。
function withdrawDecision(meetingId, decisionId, { reason, by }) {
  const d = mustGet(meetingId, decisionId);
  const snapshots = require('./snapshots');
  return tx(() => {
    const ts = nowIso();
    if (d.status === 'withdrawn') return { decision_id: decisionId, unchanged: true };
    db().prepare('UPDATE decisions SET status=?, withdrawn_at=?, withdrawn_by=?, withdraw_reason=? WHERE id=?')
      .run('withdrawn', ts, by || 'anonymous', reason || null, decisionId);
    db().prepare('UPDATE decision_task_refs SET dropped_at=? WHERE decision_id=? AND dropped_at IS NULL').run(ts, decisionId);

    const m = meetings.getMeeting(meetingId);
    let amendment = null;
    const newRev = m.head_rev + 1;
    const head = meetings.headBlocks(meetingId);
    db().prepare(`INSERT INTO meeting_revisions(id,meeting_id,rev,base_rev,change_type,author,blocks_json,note,created_at)
                  VALUES (?,?,?,?, 'decision_withdraw', ?,?,?,?)`)
      .run(newId('rev'), meetingId, newRev, m.head_rev, by || 'anonymous', JSON.stringify(head),
           `撤回决议 ${d.code}`, ts);
    db().prepare('UPDATE meetings SET head_rev=?, updated_at=? WHERE id=?').run(newRev, ts, meetingId);

    if (m.status === 'finalized' || m.status === 'amended') {
      db().prepare("UPDATE meetings SET status='amended' WHERE id=?").run(meetingId);
      amendment = snapshots.createSnapshot(meetingId, { kind: 'amendment', trigger: 'decision_withdraw', by, note: `撤回决议 ${d.code}` });
    }
    return { decision_id: decisionId, withdrawn: true, amendment_snapshot_id: amendment && amendment.id };
  });
}

module.exports = { createDecision, linkTask, unlinkTask, withdrawDecision, listDecisions, decisionView };
