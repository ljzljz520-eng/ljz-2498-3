import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let server, base, db;
before(async () => {
  const created = createApp({ dbFile: ':memory:' });
  db = created.db;
  await new Promise((resolve) => { server = created.app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};

const newMeeting = async (title = '周会') => {
  const r = await api('/api/meetings', { method: 'POST', body: { title } });
  assert.equal(r.status, 201);
  return r.data.id;
};
const save = (id, content, base_version_no, extra = {}) =>
  api(`/api/meetings/${id}/versions`, { method: 'POST', body: { base_version_no, content, author: '测试', ...extra } });
const state = (id) => api(`/api/meetings/${id}`).then(r => r.data);
const finalize = (id, body = {}) => api(`/api/meetings/${id}/finalize`, { method: 'POST', body });
const exportJson = (id, qs = '') => api(`/api/meetings/${id}/export.json${qs}`).then(r => ({ status: r.status, model: r.data }));

const todoBlock = (token, over = {}) => ({
  id: `blk-${token}-${Math.random().toString(36).slice(2, 7)}`, type: 'todo', token,
  title: '待办事项', owner: '', due_kind: 'none', resolution_token: null, ...over,
});

/* ---------- 1. 同任务多处引用：正文两处引用同一任务实体，汇总表只列一次 ---------- */
test('同任务多处引用：一个任务实体，正文两处 mention', async () => {
  const id = await newMeeting('多处引用');
  const content = {
    agenda: [{ id: 'a1', title: '议题一' }],
    blocks: [
      { id: 'p1', type: 'paragraph', text: '先讨论。' },
      todoBlock('shared', { id: 't1', title: '跟进合同签署', owner: '张三' }),
      { id: 'p2', type: 'paragraph', text: '再次强调。' },
      todoBlock('shared', { id: 't2', title: '跟进合同签署', owner: '张三' }),
    ],
  };
  const r = await save(id, content, 0);
  assert.equal(r.status, 201);
  assert.equal(r.data.state.tasks.length, 1, '只应创建一个任务实体');
  assert.equal(r.data.state.tasks[0].mention_count, 2, '正文两处引用');

  await finalize(id);
  const { model } = await exportJson(id);
  assert.equal(model.tasks.length, 1, '汇总表只列一行');
  assert.equal(model.tasks[0].mention_blocks.length, 2);
  const todoBlocks = model.blocks.filter(b => b.type === 'todo');
  assert.equal(todoBlocks.length, 2, '正文两处都渲染');
  assert.ok(todoBlocks.every(b => b.task.code === model.tasks[0].code), '两处引用同一任务编号');
});

/* ---------- 2. 负责人缺失：定稿给警告不阻断，导出显示未指派 ---------- */
test('负责人缺失：定稿产生警告，导出显示未指派', async () => {
  const id = await newMeeting('缺负责人');
  await save(id, { agenda: [], blocks: [todoBlock('no-owner', { title: '没人认领的活' })] }, 0);
  const fin = await finalize(id);
  assert.equal(fin.status, 200);
  assert.ok(fin.data.warnings.some(w => w.code === 'owner_missing'), '应有缺负责人警告');
  const { model } = await exportJson(id);
  assert.equal(model.tasks[0].owner, null);
  const html = await (await fetch(`${base}/api/meetings/${id}/export`)).text();
  assert.match(html, /未指派/);
});

/* ---------- 3. 离线并行修改：乐观并发冲突与重试 ---------- */
test('离线并行修改：后到保存收到 409，基于新版本重试成功', async () => {
  const id = await newMeeting('并行修改');
  await save(id, { agenda: [], blocks: [{ id: 'p1', type: 'paragraph', text: 'v1' }] }, 0);
  const a = await save(id, { agenda: [], blocks: [{ id: 'p1', type: 'paragraph', text: 'A 的修改' }] }, 1);
  assert.equal(a.status, 201);
  const b = await save(id, { agenda: [], blocks: [{ id: 'p1', type: 'paragraph', text: 'B 离线修改' }] }, 1);
  assert.equal(b.status, 409);
  assert.equal(b.data.error, 'version_conflict');
  assert.equal(b.data.details.current_version_no, 2);
  assert.equal(b.data.details.content.blocks[0].text, 'A 的修改', '冲突响应带回当前内容供合并');
  const retry = await save(id, { agenda: [], blocks: [{ id: 'p1', type: 'paragraph', text: 'B 合并后' }] }, 2);
  assert.equal(retry.status, 201);
  assert.equal(retry.data.version_no, 3);
  const s = await state(id);
  assert.deepEqual(s.versions.map(v => v.version_no), [1, 2, 3], '版本沿革完整');
});

/* ---------- 4. 决议撤回：任务不级联取消；新待办不得挂已撤回决议；导出标注 ---------- */
test('决议撤回：任务保留，新关联被拒，导出标注已撤回', async () => {
  const id = await newMeeting('决议撤回');
  const content = {
    agenda: [],
    blocks: [
      { id: 'r1', type: 'resolution', token: 'res-1', text: '通过预算方案' },
      todoBlock('t1', { title: '执行预算', owner: '张三', resolution_token: 'res-1' }),
    ],
  };
  const r = await save(id, content, 0);
  const res1 = r.data.state.resolutions[0];
  assert.equal(res1.code, 'R-1');

  const w = await api(`/api/resolutions/${res1.id}/withdraw`, { method: 'POST' });
  assert.equal(w.data.resolution.status, 'withdrawn');
  const w2 = await api(`/api/resolutions/${res1.id}/withdraw`, { method: 'POST' });
  assert.equal(w2.data.idempotent, true, '重复撤回幂等');

  let s = await state(id);
  assert.equal(s.tasks[0].status, 'open', '撤回决议不取消已分派任务');

  // 新待办挂已撤回决议 -> 422
  const bad = await save(id, {
    agenda: [],
    blocks: [
      { id: 'r1', type: 'resolution', token: 'res-1', text: '通过预算方案' },
      todoBlock('t1', { title: '执行预算', owner: '张三', resolution_token: 'res-1' }),
      todoBlock('t2', { title: '新增关联', resolution_token: 'res-1' }),
    ],
  }, 1);
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error, 'resolution_withdrawn');

  await finalize(id);
  const { model } = await exportJson(id);
  assert.equal(model.resolutions[0].status_at_version, 'withdrawn');
  assert.equal(model.tasks[0].resolution_status, 'withdrawn');
  const html = await (await fetch(`${base}/api/meetings/${id}/export`)).text();
  assert.match(html, /已撤回/);
});

/* ---------- 5. 生成表格中断：部分失败可恢复，重跑幂等 ---------- */
test('生成表格中断：快照部分写入，恢复后补齐且不重复', async () => {
  const id = await newMeeting('中断恢复');
  await save(id, {
    agenda: [],
    blocks: [1, 2, 3].map(i => todoBlock(`tk${i}`, { title: `事项${i}`, owner: '张三' })),
  }, 0);
  const fin = await finalize(id, { __test_fail_after: 1 });
  assert.equal(fin.data.snapshot_complete, false, '快照未完成');
  const partial = db.prepare(
    'SELECT COUNT(*) c FROM version_task_snapshots s JOIN meeting_versions v ON s.version_id=v.id WHERE v.meeting_id=?'
  ).get(id).c;
  assert.equal(partial, 1, '中断前已写入 1 行（部分失败）');

  let s = await state(id);
  assert.equal(s.pending_jobs, 1, '存在待恢复作业');

  const run = await api('/api/jobs/run', { method: 'POST', body: {} });
  assert.equal(run.data.outcomes[0].status, 'done');
  const total = db.prepare(
    'SELECT COUNT(*) c FROM version_task_snapshots s JOIN meeting_versions v ON s.version_id=v.id WHERE v.meeting_id=?'
  ).get(id).c;
  assert.equal(total, 3, '恢复后补齐全部任务');

  await api('/api/jobs/run', { method: 'POST', body: {} });
  const total2 = db.prepare(
    'SELECT COUNT(*) c FROM version_task_snapshots s JOIN meeting_versions v ON s.version_id=v.id WHERE v.meeting_id=?'
  ).get(id).c;
  assert.equal(total2, 3, '重复恢复不产生重复行（幂等）');

  const { model } = await exportJson(id);
  assert.equal(model.tasks.length, 3);
});

/* ---------- 6+10. 定稿后改负责人：独立变更单；旧签收不套用新分派；导出还原当时 ---------- */
test('定稿后改负责人需独立变更，旧签收不确认新分派，导出还原当时负责人', async () => {
  const id = await newMeeting('定稿变更');
  await save(id, { agenda: [], blocks: [todoBlock('t1', { title: '发布版本', owner: '张三' })] }, 0);
  let s = await state(id);
  const taskId = s.tasks[0].id;
  await api(`/api/tasks/${taskId}/ack`, { method: 'POST', body: { acked_by: '张三' } });
  await finalize(id);

  // 无变更单 -> 422
  const noTicket = await api(`/api/tasks/${taskId}/assignment`, {
    method: 'POST', body: { owner_name: '李四', change_token: 'ct-0' },
  });
  assert.equal(noTicket.status, 422);
  assert.equal(noTicket.data.error, 'ticket_required');

  // 独立变更（带变更单）
  const chg = await api(`/api/tasks/${taskId}/assignment`, {
    method: 'POST',
    body: { owner_name: '李四', ticket: 'CHG-2026-001', reason: '张三休假', actor: '王五', change_token: 'ct-1' },
  });
  assert.equal(chg.data.assignment.change_type, 'post_finalize');
  assert.equal(chg.data.assignment.ticket, 'CHG-2026-001');

  // 幂等重放
  const replay = await api(`/api/tasks/${taskId}/assignment`, {
    method: 'POST',
    body: { owner_name: '李四', ticket: 'CHG-2026-001', change_token: 'ct-1' },
  });
  assert.equal(replay.data.idempotent, true);

  const h = await api(`/api/tasks/${taskId}/history`);
  assert.equal(h.data.assignments.length, 2, '沿革两条');
  assert.equal(h.data.assignments[0].owner_name, '张三');
  assert.ok(h.data.assignments[0].ack, '旧分派上的签收仍在');
  assert.equal(h.data.assignments[1].ack, null, '新分派没有签收记录');

  s = await state(id);
  assert.equal(s.tasks[0].owner, '李四');
  assert.equal(s.tasks[0].acked, false, '旧签收不会看似确认新分派');

  // 导出定稿版：仍是张三 + 已签收（还原当时，不混入后来状态）
  const { model } = await exportJson(id);
  assert.equal(model.tasks[0].owner, '张三');
  assert.equal(model.tasks[0].acked, true);

  // 之后任务完成、李四签收 —— 导出依旧不变
  await api(`/api/tasks/${taskId}/ack`, { method: 'POST', body: { acked_by: '李四' } });
  await api(`/api/tasks/${taskId}/status`, { method: 'POST', body: { status: 'done' } });
  const again = await exportJson(id);
  assert.equal(again.model.tasks[0].owner, '张三');
  assert.equal(again.model.tasks[0].status, 'open', '导出不混入后来的任务状态');
  s = await state(id);
  assert.equal(s.tasks[0].status, 'done', '实时汇总反映最新状态');
  assert.equal(s.tasks[0].acked, true);
});

/* ---------- 7. 删段落不自动取消已分派事项 ---------- */
test('删段落不取消待办：任务保留，汇总表仍在', async () => {
  const id = await newMeeting('删段落');
  await save(id, { agenda: [], blocks: [todoBlock('t1', { title: '重要待办', owner: '张三' })] }, 0);
  const r2 = await save(id, { agenda: [], blocks: [{ id: 'p1', type: 'paragraph', text: '段落已删' }] }, 1);
  assert.equal(r2.status, 201);
  const s = await state(id);
  assert.equal(s.tasks.length, 1, '任务实体保留');
  assert.equal(s.tasks[0].status, 'open');
  assert.equal(s.tasks[0].mention_count, 0, '正文引用为 0');
  await finalize(id);
  const { model } = await exportJson(id);
  assert.equal(model.tasks.length, 1, '汇总表仍列出该待办');
  assert.equal(model.tasks[0].mention_blocks.length, 0);
});

/* ---------- 8. 幂等：保存重试 / 重复定稿 / 重复签收 ---------- */
test('幂等：save_token 重试、重复定稿、重复签收均不产生重复记录', async () => {
  const id = await newMeeting('幂等');
  const content = { agenda: [], blocks: [todoBlock('t1', { title: '幂等待办', owner: '张三' })] };
  const r1 = await save(id, content, 0, { save_token: 'st-1' });
  const r2 = await save(id, content, 0, { save_token: 'st-1' });
  assert.equal(r2.data.idempotent, true);
  assert.equal(r2.data.version_no, r1.data.version_no);
  let s = await state(id);
  assert.equal(s.versions.length, 1);
  assert.equal(s.tasks.length, 1, '重试不会创建重复任务');

  const f1 = await finalize(id);
  const f2 = await finalize(id);
  assert.equal(f2.data.already, true);
  assert.equal(f2.data.version_no, f1.data.version_no);

  const taskId = s.tasks[0].id;
  await api(`/api/tasks/${taskId}/ack`, { method: 'POST', body: { acked_by: '张三' } });
  const ack2 = await api(`/api/tasks/${taskId}/ack`, { method: 'POST', body: { acked_by: '张三' } });
  assert.equal(ack2.data.idempotent, true);
  const cnt = db.prepare('SELECT COUNT(*) c FROM task_acks WHERE task_id = ?').get(taskId).c;
  assert.equal(cnt, 1);
});

/* ---------- 9. 截止时点：仅日期 vs 具体时刻，时区解释明确 ---------- */
test('截止日期区分仅日期与具体时刻，并明确时区', async () => {
  const id = await newMeeting('截止时点');
  const todaySh = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  await save(id, {
    agenda: [],
    blocks: [
      todoBlock('d1', { title: '今天截止(日期型)', due_kind: 'date', due_date: todaySh, due_tz: 'Asia/Shanghai' }),
      todoBlock('d2', { title: '昨天截止(日期型)', due_kind: 'date', due_date: '2020-01-01', due_tz: 'Asia/Shanghai' }),
      todoBlock('d3', { title: '过去的时刻', due_kind: 'datetime', due_at: '2020-01-01T00:00:00.000Z', due_tz: 'America/New_York' }),
      todoBlock('d4', { title: '未来的时刻', due_kind: 'datetime', due_at: '2999-01-01T00:00:00.000Z', due_tz: 'UTC' }),
    ],
  }, 0);
  const s = await state(id);
  const by = Object.fromEntries(s.tasks.map(t => [t.title, t]));
  assert.equal(by['今天截止(日期型)'].overdue, false, '日期型：当日 23:59 前不算逾期');
  assert.equal(by['昨天截止(日期型)'].overdue, true);
  assert.equal(by['过去的时刻'].overdue, true, '时刻型：按确切时刻判断');
  assert.equal(by['未来的时刻'].overdue, false);
  assert.match(by['昨天截止(日期型)'].due_label, /2020-01-01（日期型，Asia\/Shanghai 当日 23:59 截止）/);
  assert.match(by['过去的时刻'].due_label, /时刻型，America\/New_York/);

  // 非法输入被拒绝
  const bad = await save(id, { agenda: [], blocks: [todoBlock('d5', { title: 'x', due_kind: 'date', due_date: '10月1日' })] }, 1);
  assert.equal(bad.status, 422);
  const badTz = await save(id, { agenda: [], blocks: [todoBlock('d6', { title: 'x', due_kind: 'datetime', due_at: '2026-01-01T00:00:00Z', due_tz: 'Mars/Olympus' })] }, 1);
  assert.equal(badTz.status, 422);
});

/* ---------- 同源：改任务标题后正文与汇总表一致 ---------- */
test('正文待办与汇总表来自同一任务实体', async () => {
  const id = await newMeeting('同源');
  await save(id, { agenda: [], blocks: [todoBlock('t1', { title: '旧标题', owner: '张三' })] }, 0);
  await save(id, { agenda: [], blocks: [todoBlock('t1', { id: 'b1', title: '新标题', owner: '张三' })] }, 1);
  const s = await state(id);
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].title, '新标题', '同一实体被更新而非新建');
  await finalize(id);
  const { model } = await exportJson(id);
  assert.equal(model.tasks[0].title, '新标题');
  assert.equal(model.blocks.find(b => b.type === 'todo').task.title, '新标题', '正文渲染与汇总表同源');
});

/* ---------- 定稿后正文锁定 ---------- */
test('定稿后正文不可再编辑', async () => {
  const id = await newMeeting('锁定');
  await save(id, { agenda: [], blocks: [todoBlock('t1', { title: 'x' })] }, 0);
  await finalize(id);
  const r = await save(id, { agenda: [], blocks: [] }, 2);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'meeting_finalized');
});
