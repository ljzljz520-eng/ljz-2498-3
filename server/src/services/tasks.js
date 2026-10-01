'use strict';
const { db, tx } = require('../db');
const { newId } = require('../ids');
const { nowIso } = require('../clock');
const { badRequest, notFound, conflict } = require('../errors');
const { normalizeDeadline } = require('./deadline');
const meetings = require('./meetings');

function assertDraft(m) {
  if (m.status !== 'draft') throw conflict('会议已定稿，任务内容不可修改（仅可通过独立通道变更负责人）', { status: m.status });
}

// 单任务幂等 upsert。task.id 由页面生成（稳定），重复提交不会产生第二条待办。
// 返回 { ok, data | error }，供批量接口做部分失败收集。
function upsertTask(meetingId, input, { allowEstablished = false } = {}) {
  const m = meetings.getMeeting(meetingId);
  if (!allowEstablished) assertDraft(m);
  if (!input.id) return { ok: false, error: { index: input.__index, code: 'missing_id', message: '任务缺少稳定 id（幂等关联必需）' } };
  if (!input.title || !String(input.title).trim())
    return { ok: false, error: { id: input.id, code: 'missing_title', message: '任务标题必填' } };

  try {
    const dl = normalizeDeadline(input.due, m.timezone);
    const result = tx(() => {
      const ts = nowIso();
      const existing = db().prepare('SELECT * FROM tasks WHERE id=?').get(input.id);
      if (existing && existing.meeting_id !== meetingId)
        throw conflict(`任务 ${input.id} 属于其他会议`);

      let taskId;
      let created = false;
      if (existing) {
        if (existing.status === 'established' && !allowEstablished)
          throw conflict('任务已定稿建立，内容不可修改', { id: existing.id });
        taskId = existing.id;
        db().prepare(`UPDATE tasks SET title=?, detail=?, due_kind=?, due_date=?, due_at_utc=?, due_tz=?, updated_at=?
                      WHERE id=?`)
          .run(String(input.title).trim(), input.detail || null, dl.due_kind, dl.due_date, dl.due_at_utc, dl.due_tz, ts, taskId);
      } else {
        taskId = input.id;
        created = true;
        db().prepare(`INSERT INTO tasks(id,meeting_id,title,detail,status,due_kind,due_date,due_at_utc,due_tz,created_in_rev,created_by,created_at,updated_at)
                      VALUES (?,?,?,?,'provisional',?,?,?,?,?,?,?,?)`)
          .run(taskId, meetingId, String(input.title).trim(), input.detail || null,
               dl.due_kind, dl.due_date, dl.due_at_utc, dl.due_tz, m.head_rev, input.author || 'anonymous', ts, ts);
      }

      // 初稿编辑阶段：upsert 可携带 assignee，仅在当前没有生效分派或值变化时追加沿革行
      if (input.assignee !== undefined) {
        const cur = currentAssignment(taskId);
        if ((cur ? cur.assignee : null) !== (input.assignee || null)) {
          addAssignmentRow(taskId, input.assignee || null, {
            change_type: !cur ? (input.assignee ? 'assign' : 'clear') : (input.assignee ? 'reassign' : 'clear'),
            reason: input.assignee_reason || (created ? '建任务时分派' : '编辑期调整'),
            by: input.author,
          });
        }
      }
      return { taskId, created };
    });
    return { ok: true, data: { id: result.taskId, created: result.created } };
  } catch (e) {
    return { ok: false, error: { id: input.id, code: e.code || 'error', message: e.message, details: e.details } };
  }
}

// 批量部分失败：每条独立落库（savepoint 语义由每条自己的事务保证），汇总成功/失败，绝不整批回滚导致全丢。
function batchUpsertTasks(meetingId, items) {
  if (!Array.isArray(items)) throw badRequest('items 必须是数组');
  const succeeded = [], failed = [];
  items.forEach((it, i) => {
    const r = upsertTask(meetingId, { ...it, __index: i });
    if (r.ok) succeeded.push({ index: i, ...r.data });
    else failed.push({ index: i, ...r.error });
  });
  return { meeting_id: meetingId, total: items.length, succeeded_count: succeeded.length, failed_count: failed.length, succeeded, failed };
}

function addAssignmentRow(taskId, assignee, { change_type, reason, by }) {
  const ts = nowIso();
  const cur = db().prepare("SELECT id FROM task_assignments WHERE task_id=? AND superseded_at IS NULL").get(taskId);
  if (cur) db().prepare('UPDATE task_assignments SET superseded_at=? WHERE id=?').run(ts, cur.id);
  db().prepare(`INSERT INTO task_assignments(id,task_id,assignee,reason,change_type,changed_by,changed_at)
                VALUES (?,?,?,?,?,?,?)`)
    .run(newId('asn'), taskId, assignee, reason || null, change_type, by || 'anonymous', ts);
}

function currentAssignment(taskId) {
  return db().prepare("SELECT * FROM task_assignments WHERE task_id=? AND superseded_at IS NULL ORDER BY changed_at DESC, rowid DESC LIMIT 1").get(taskId);
}

function listAssignments(taskId) {
  return db().prepare('SELECT * FROM task_assignments WHERE task_id=? ORDER BY changed_at, rowid').all(taskId);
}

// 独立的负责人变更通道：定稿前后都可用；它只追加沿革，不改正文、不改定稿内容。
// 新分派下旧签收不再代表确认（查询按 assignment_id 隔离）。
function changeAssignee(meetingId, taskId, { assignee, reason, by }) {
  const task = getTask(taskId);
  if (task.meeting_id !== meetingId) throw notFound('任务不属于该会议');
  return tx(() => {
    const cur = currentAssignment(taskId);
    const from = cur ? cur.assignee : null;
    if ((assignee || null) === (from || null)) {
      return { task_id: taskId, unchanged: true, assignee: from, assignment_id: cur ? cur.id : null };
    }
    addAssignmentRow(taskId, assignee || null, {
      change_type: assignee ? (cur ? 'reassign' : 'assign') : 'clear',
      reason: reason || '负责人独立变更', by,
    });
    db().prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(nowIso(), taskId);
    const m = meetings.getMeeting(meetingId);
    // 留一条会议版本痕迹（正文不变）
    const ts = nowIso();
    const newRev = m.head_rev + 1;
    const head = meetings.headBlocks(meetingId);
    db().prepare(`INSERT INTO meeting_revisions(id,meeting_id,rev,base_rev,change_type,author,blocks_json,note,created_at)
                  VALUES (?,?,?,?, 'owner_change', ?,?,?,?)`)
      .run(newId('rev'), meetingId, newRev, m.head_rev, by || 'anonymous', JSON.stringify(head),
           `任务 ${taskId} 负责人: ${from || '（空）'} -> ${assignee || '（空）'}`, ts);
    db().prepare('UPDATE meetings SET head_rev=?, updated_at=? WHERE id=?').run(newRev, ts, meetingId);
    return { task_id: taskId, changed: true, from, to: assignee || null, assignment_id: currentAssignment(taskId).id };
  });
}

// 签收针对当前（或指定）分派版本
function acknowledge(meetingId, taskId, { assignment_id, by, note }) {
  const task = getTask(taskId);
  if (task.meeting_id !== meetingId) throw notFound('任务不属于该会议');
  const target = assignment_id
    ? db().prepare('SELECT * FROM task_assignments WHERE id=? AND task_id=?').get(assignment_id, taskId)
    : currentAssignment(taskId);
  if (!target) throw conflict('该任务尚无分派，无法签收（负责人缺失）', { task_id: taskId });
  if (assignment_id) {
    const cur = currentAssignment(taskId);
    if (!cur || cur.id !== target.id) {
      throw conflict('该签收针对的是已被取代的旧分派；新分派需重新签收，旧签收不会确认新负责人',
        { requested_assignment: assignment_id, current_assignment: cur ? cur.id : null });
    }
  }
  const ts = nowIso();
  try {
    db().prepare(`INSERT INTO task_acknowledgements(id,assignment_id,task_id,acknowledged_by,acknowledged_at,note)
                  VALUES (?,?,?,?,?,?)`)
      .run(newId('ack'), target.id, taskId, by || target.assignee || 'anonymous', ts, note || null);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw conflict('该分派已被此人签收', { assignment_id: target.id });
    throw e;
  }
  return { task_id: taskId, assignment_id: target.id, acknowledged_at: ts };
}

function getTask(id) {
  const t = db().prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) throw notFound(`任务不存在: ${id}`);
  return t;
}

function taskView(id) {
  const t = getTask(id);
  const cur = currentAssignment(id);
  const acks = db().prepare('SELECT * FROM task_acknowledgements WHERE task_id=? ORDER BY acknowledged_at').all(id);
  return { ...t, assignee: cur ? cur.assignee : null, assignment_id: cur ? cur.id : null,
           ack_required: cur ? !!cur.assignee : false,
           acknowledged: cur ? acks.some(a => a.assignment_id === cur.id) : false,
           assignments: listAssignments(id), acknowledgements: acks };
}

function listTasks(meetingId) {
  meetings.getMeeting(meetingId);
  const ids = db().prepare('SELECT id FROM tasks WHERE meeting_id=? ORDER BY created_at, rowid').all(meetingId).map(r => r.id);
  return ids.map(taskView);
}

// 定稿后的任务状态独立通道：只改活任务状态（取消/完成），不改正文、不改任何快照。
// 与"删段落不自动取消""改负责人独立"同构：业务动作显式发生才变更。
function setStatus(meetingId, taskId, { status, by }) {
  const t = getTask(taskId);
  if (t.meeting_id !== meetingId) throw notFound('任务不属于该会议');
  if (!['established', 'cancelled', 'done'].includes(status)) throw badRequest('非法状态');
  return tx(() => {
    db().prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), taskId);
    return { task_id: taskId, status };
  });
}

// 负责人缺失检测（验收点）
function missingAssignees(meetingId) {
  return listTasks(meetingId)
    .filter(t => t.status !== 'cancelled' && !t.assignee)
    .map(t => ({ id: t.id, title: t.title, status: t.status }));
}

// 从正文块解析被引用的任务 id（正文 todo 块通过 task_id 关联同一实体）
function referencedTaskIds(blocks) {
  return blocks.filter(b => b.type === 'todo' && b.task_id).map(b => b.task_id);
}

// 同一任务多处引用检测（验收点）：正文多处 + 多个决议引用
function referenceReport(meetingId) {
  const blocks = meetings.headBlocks(meetingId);
  const bodyRefs = new Map();
  blocks.forEach(b => { if (b.type === 'todo' && b.task_id) bodyRefs.set(b.task_id, (bodyRefs.get(b.task_id) || 0) + 1); });
  const decRefs = db().prepare(`SELECT r.task_id, d.id decision_id, d.code FROM decision_task_refs r JOIN decisions d ON d.id=r.decision_id
                                WHERE d.meeting_id=? AND r.dropped_at IS NULL`).all(meetingId);
  const byTask = new Map();
  for (const r of decRefs) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push({ decision_id: r.decision_id, code: r.code });
  }
  return listTasks(meetingId).map(t => ({
    task_id: t.id, title: t.title,
    body_mentions: bodyRefs.get(t.id) || 0,
    decision_mentions: byTask.get(t.id) || [],
    total_refs: (bodyRefs.get(t.id) || 0) + (byTask.get(t.id) || []).length,
  }));
}

module.exports = { upsertTask, batchUpsertTasks, changeAssignee, acknowledge, setStatus, listTasks, taskView,
  listAssignments, currentAssignment, missingAssignees, referencedTaskIds, referenceReport, addAssignmentRow };
