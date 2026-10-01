'use strict';
const { db, tx } = require('../db');
const { newId } = require('../ids');
const { nowIso } = require('../clock');
const { badRequest, notFound, conflict } = require('../errors');
const { isValidZone } = require('./deadline');

const BLOCK_TYPES = ['para', 'heading', 'todo', 'decision'];

function createMeeting({ title, timezone, author }) {
  if (!title || !title.trim()) throw badRequest('会议标题必填');
  if (!isValidZone(timezone || '')) throw badRequest(`无效时区: ${timezone}（需 IANA，如 Asia/Shanghai）`);
  const id = newId('mtg');
  const ts = nowIso();
  const revId = newId('rev');
  tx(() => {
    db().prepare(`INSERT INTO meetings(id,title,timezone,status,head_rev,created_at,updated_at)
                  VALUES (?,?,?, 'draft', 0, ?, ?)`).run(id, title.trim(), timezone, ts, ts);
    db().prepare(`INSERT INTO meeting_revisions(id,meeting_id,rev,base_rev,change_type,author,blocks_json,note,created_at)
                  VALUES (?,?,0,NULL,'edit',?,?,'初始版本',?)`)
        .run(revId, id, author || 'anonymous', '[]', ts);
  });
  return getMeeting(id);
}

function getMeeting(id) {
  const m = db().prepare('SELECT * FROM meetings WHERE id=?').get(id);
  if (!m) throw notFound('会议不存在');
  return m;
}

function listMeetings() {
  return db().prepare('SELECT * FROM meetings ORDER BY created_at DESC').all();
}

function getRevision(meetingId, rev) {
  const row = db().prepare('SELECT * FROM meeting_revisions WHERE meeting_id=? AND rev=?').get(meetingId, rev);
  if (!row) throw notFound(`版本 ${rev} 不存在`);
  return row;
}

function headBlocks(meetingId) {
  const m = getMeeting(meetingId);
  const row = getRevision(meetingId, m.head_rev);
  return JSON.parse(row.blocks_json);
}

// 规范化页面提交的块编辑
function normOps(ops) {
  if (!Array.isArray(ops)) throw badRequest('ops 必须是数组');
  return ops.map(op => {
    if (!op.op || !['upsert', 'delete'].includes(op.op)) throw badRequest(`非法 op: ${op.op}`);
    if (!op.block_id) throw badRequest('block_id 必填');
    if (op.op === 'upsert') {
      if (!BLOCK_TYPES.includes(op.type)) throw badRequest(`非法块类型: ${op.type}`);
      return { ...op, ord: Number.isFinite(op.ord) ? op.ord : 0,
               content: op.content ?? '', task_id: op.task_id || null };
    }
    return op;
  });
}

// 块级三路合并：base(客户端所基于版本) -> head(服务端当前) 与 base -> client
// 规则：
//  - 块仅一方修改：采用该方；双方同值也通过
//  - 双方都改同一字段且不同：冲突（返回 409，含冲突细节，调用方处理后可重试）
//  - 一方删除、另一方修改：冲突（修改/删除冲突需人工裁决）
function threeWayMerge(baseBlocks, headBlocks, clientOps) {
  const base = new Map(baseBlocks.map(b => [b.id, b]));
  const head = new Map(headBlocks.map(b => [b.id, b]));
  const clientMut = new Map(); // blockId -> 客户端期望的最终块 或 {__delete:true}
  for (const op of clientOps) {
    clientMut.set(op.block_id, op.op === 'delete'
      ? { __delete: true }
      : { id: op.block_id, type: op.type, ord: op.ord, content: op.content, task_id: op.task_id || null });
  }

  const conflicts = [];
  const merged = new Map(headBlocks.map(b => [b.id, { ...b }]));
  const history = [];

  for (const [bid, want] of clientMut) {
    const b = base.get(bid), h = head.get(bid);
    const clientDeleted = want.__delete;

    if (!b) {
      // 新增块（base 中不存在）
      if (h) { // 服务端也恰好新建了同 id：比较
        if (JSON.stringify(h) !== JSON.stringify({ id: bid, ...want })) {
          conflicts.push({ block_id: bid, reason: '双方分别创建同 ID 块且内容不同' });
        }
      } else if (!clientDeleted) {
        merged.set(bid, { id: bid, type: want.type, ord: want.ord, content: want.content, task_id: want.task_id });
        history.push({ block_id: bid, action: 'insert' });
      }
      continue;
    }

    const headDeleted = !h;
    // 服务端是否改过该块
    const headChanged = h && JSON.stringify({ type: h.type, ord: h.ord, content: h.content, task_id: h.task_id })
      !== JSON.stringify({ type: b.type, ord: b.ord, content: b.content, task_id: b.task_id });
    // 客户端是否改过（相对 base）
    const clientChanged = !clientDeleted &&
      JSON.stringify({ type: want.type, ord: want.ord, content: want.content, task_id: want.task_id })
      !== JSON.stringify({ type: b.type, ord: b.ord, content: b.content, task_id: b.task_id });
    const clientDeletedChanged = clientDeleted; // 删除即变更

    if (clientDeleted) {
      if (headDeleted) { // 双方都删：幂等接受
        continue;
      }
      if (headChanged) { conflicts.push({ block_id: bid, reason: '客户端删除但服务端已修改' }); continue; }
      merged.delete(bid);
      history.push({ block_id: bid, action: 'delete', snapshot_json: JSON.stringify(h) });
      continue;
    }

    if (headDeleted) {
      if (clientChanged) { conflicts.push({ block_id: bid, reason: '服务端已删除但客户端在修改' }); continue; }
      continue;
    }

    if (headChanged && clientChanged) {
      // 字段级比对：仅冲突字段
      for (const f of ['type', 'ord', 'content', 'task_id']) {
        const hv = h[f], cv = want[f], bv = b[f];
        if (hv !== cv && bv !== hv && bv !== cv) {
          conflicts.push({ block_id: bid, field: f, base: bv, head: hv, client: cv, reason: '字段并行修改冲突' });
        }
      }
      if (conflicts.some(c => c.block_id === bid)) continue;
      // 无冲突（改动落在不同字段）：合并两边
      merged.set(bid, { ...h, ...want });
      history.push({ block_id: bid, action: 'update' });
    } else if (clientChanged) {
      merged.set(bid, { ...want });
      history.push({ block_id: bid, action: 'update' });
    }
    // 仅服务端改：保持 head，不记历史
  }

  return { merged: [...merged.values()].sort((a, b2) => a.ord - b2.ord || a.id.localeCompare(b2.id)), conflicts, history };
}

// 提交编辑。定稿后正文冻结，只能走 owner_change / decision_withdraw 通道。
function applyEdit(meetingId, { base_rev, ops, author, note }) {
  const m = getMeeting(meetingId);
  if (m.status !== 'draft') throw conflict('会议已定稿，正文不可直接编辑（负责人变更与决议撤回请走独立通道）', { status: m.status });
  if (!Number.isInteger(base_rev)) throw badRequest('base_rev 必填（整数），用于离线并行检测');

  const clientOps = normOps(ops || []);
  return tx(() => {
    const baseRow = db().prepare('SELECT * FROM meeting_revisions WHERE meeting_id=? AND rev=?').get(meetingId, base_rev);
    if (!baseRow) throw badRequest(`base_rev=${base_rev} 不存在`);
    const headRow = getRevision(meetingId, m.head_rev);
    const baseBlocks = JSON.parse(baseRow.blocks_json);
    const headBlocks = JSON.parse(headRow.blocks_json);

    const { merged, conflicts, history } = threeWayMerge(baseBlocks, headBlocks, clientOps);
    if (conflicts.length) throw conflict('离线并行修改存在块级冲突，请解决后重试', { conflicts });

    const newRev = m.head_rev + 1;
    const revId = newId('rev');
    const ts = nowIso();
    db().prepare(`INSERT INTO meeting_revisions(id,meeting_id,rev,base_rev,change_type,author,blocks_json,note,created_at)
                  VALUES (?,?,?,?, 'edit', ?,?,?,?)`)
      .run(revId, meetingId, newRev, base_rev, author || 'anonymous', JSON.stringify(merged), note || null, ts);
    for (const h of history) {
      db().prepare(`INSERT INTO block_history(id,meeting_id,block_id,revision_id,action,snapshot_json)
                    VALUES (?,?,?,?,?,?)`).run(newId('bh'), meetingId, h.block_id, revId, h.action, h.snapshot_json || null);
    }
    db().prepare('UPDATE meetings SET head_rev=?, updated_at=? WHERE id=?').run(newRev, ts, meetingId);
    return { meeting_id: meetingId, rev: newRev, revision_id: revId, applied: history.length };
  });
}

function listRevisions(meetingId) {
  getMeeting(meetingId);
  return db().prepare('SELECT id,rev,base_rev,change_type,author,note,created_at FROM meeting_revisions WHERE meeting_id=? ORDER BY rev').all(meetingId);
}

module.exports = { createMeeting, getMeeting, listMeetings, getRevision, headBlocks, applyEdit, listRevisions, threeWayMerge };
