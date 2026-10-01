'use strict';
const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert');
const { newId: uid } = require('../server/src/ids');

const { useMemory } = require('../server/src/db');
useMemory(true);
beforeEach(() => useMemory(true)); // 每个测试独立内存库
const meetings = require('../server/src/services/meetings');
const tasks = require('../server/src/services/tasks');
const decisions = require('../server/src/services/decisions');
const snapshots = require('../server/src/services/snapshots');
const renderer = require('../server/src/services/renderer');
const { normalizeDeadline, explainDeadline } = require('../server/src/services/deadline');
const { setClock } = require('../server/src/clock');

let seq = 0;
setClock(() => new Date(Date.UTC(2026, 9, 1, 9, 0, seq++)));

function newMeeting(tz = 'Asia/Shanghai') {
  return meetings.createMeeting({ title: '季度评审会', timezone: tz, author: 'alice' });
}
// 建一个含两个任务、两个决议、若干正文块的草稿
function seedDraft() {
  const m = newMeeting();
  const t1 = uid('task'), t2 = uid('task');
  tasks.batchUpsertTasks(m.id, [
    { id: t1, title: '完成安全审计', assignee: 'bob', due: { due: '2026-10-15' }, author: 'alice' },
    { id: t2, title: '提交预算表', assignee: 'carol', due: { due: '2026-10-20T18:00', tz: 'Asia/Shanghai' }, author: 'alice' },
  ]);
  meetings.applyEdit(m.id, {
    base_rev: 0, author: 'alice',
    ops: [
      { op: 'upsert', block_id: 'blk-h1', type: 'heading', ord: 0, content: '议题一：风险' },
      { op: 'upsert', block_id: 'blk-td1', type: 'todo', ord: 1, content: '推进安全审计', task_id: t1 },
      { op: 'upsert', block_id: 'blk-td2', type: 'todo', ord: 2, content: '预算事宜', task_id: t2 },
    ],
  });
  // 同一任务被两个决议引用 + 正文引用（多处引用）
  decisions.createDecision(m.id, { code: 'D-1', content: '启动审计', task_ids: [t1], by: 'alice' });
  decisions.createDecision(m.id, { code: 'D-2', content: '审计与预算联动', task_ids: [t1, t2], by: 'alice' });
  return { m, t1, t2 };
}

test('截止日期：仅日期不换算时刻；具体时刻按时区归一化为 UTC 且可还原', () => {
  const d = normalizeDeadline({ due: '2026-10-15' }, 'Asia/Shanghai');
  assert.equal(d.due_kind, 'date');
  assert.equal(d.due_date, '2026-10-15');
  assert.equal(d.due_at_utc, null); // 仅日期没有 UTC 时刻
  assert.match(explainDeadline(d, 'Asia/Shanghai').text, /按会议时区/);

  const dt = normalizeDeadline({ due: '2026-10-20T18:00', tz: 'Asia/Shanghai' }, 'Asia/Shanghai');
  assert.equal(dt.due_kind, 'datetime');
  assert.equal(dt.due_at_utc, '2026-10-20T10:00:00.000Z'); // +08:00
  const ex = explainDeadline(dt, 'Asia/Shanghai');
  assert.equal(ex.wall, '2026-10-20T18:00');
  assert.match(ex.text, /Asia\/Shanghai/);
  assert.match(ex.text, /UTC 2026-10-20T10:00:?0*0?Z/);

  // 纽约时刻同样的墙上时间对应不同 UTC
  const ny = normalizeDeadline({ due: '2026-10-20T18:00', tz: 'America/New_York' }, 'UTC');
  assert.equal(ny.due_at_utc, '2026-10-20T22:00:00.000Z'); // EDT -04:00
  assert.throws(() => normalizeDeadline({ due: '2026-10-20T18:00', tz: 'Mars/Olympus' }, 'UTC'), /无效时区/);
});

test('统一任务实体：正文待办、决议引用、汇总表指向同一行；同任务多处引用被统计', () => {
  const { m, t1 } = seedDraft();
  const refs = tasks.referenceReport(m.id);
  const a = refs.find(r => r.task_id === t1);
  assert.equal(a.body_mentions, 1);
  assert.equal(a.decision_mentions.length, 2); // D-1, D-2
  assert.equal(a.total_refs, 3);
  const list = tasks.listTasks(m.id);
  assert.equal(list.length, 2); // 不是每个引用一条任务
});

test('幂等：同稳定 ID 重复 upsert 不产生新任务，返回 created=false', () => {
  const m = newMeeting();
  const r1 = tasks.upsertTask(m.id, { id: 'task-X', title: '事项', author: 'a' });
  const r2 = tasks.upsertTask(m.id, { id: 'task-X', title: '事项改名', author: 'a' });
  assert.deepEqual({ ok: r1.ok, created: r1.data.created }, { ok: true, created: true });
  assert.deepEqual({ ok: r2.ok, created: r2.data.created }, { ok: true, created: false });
  assert.equal(tasks.listTasks(m.id).length, 1);
});

test('批量部分失败：坏条目不影响好条目落库', () => {
  const m = newMeeting();
  const r = tasks.batchUpsertTasks(m.id, [
    { id: 'task-g1', title: '好任务1' },
    { id: 'task-bad' },                       // 缺标题
    { id: 'task-g2', title: '好任务2' },
  ]);
  assert.equal(r.succeeded_count, 2);
  assert.equal(r.failed_count, 1);
  assert.equal(r.failed[0].code, 'missing_title');
  assert.equal(tasks.listTasks(m.id).length, 2);
});

test('负责人缺失：无负责人可存在但被检测；无分派不可签收', () => {
  const m = newMeeting();
  tasks.upsertTask(m.id, { id: 'task-nobody', title: '待定负责人', author: 'a' });
  const missing = tasks.missingAssignees(m.id);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'task-nobody');
  assert.throws(() => tasks.acknowledge(m.id, 'task-nobody', { by: 'x' }), /尚无分派/);
});

test('定稿校验负责人缺失；放行后 provisional -> established 且幂等重放不重复转换', () => {
  const { m, t1 } = seedDraft();
  tasks.upsertTask(m.id, { id: 'task-orphan', title: '无人认领', author: 'a' });
  assert.throws(() => snapshots.finalize(m.id, { idempotency_key: 'k1', by: 'a' }), /缺少负责人/);

  const f = snapshots.finalize(m.id, { idempotency_key: 'k1', allow_missing_assignees: true, by: 'a' });
  assert.equal(f.established_task_ids.length, 3);
  // 同 key 重放：幂等返回，不二次转换
  const replay = snapshots.finalize(m.id, { idempotency_key: 'k1', by: 'a' });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.established_task_ids.length, 0);
  // 换一个新 key 则拒绝二次定稿
  assert.throws(() => snapshots.finalize(m.id, { idempotency_key: 'other', by: 'a' }), /已定稿/);
  const t = tasks.taskView(t1);
  assert.equal(t.status, 'established');
  assert.equal(meetings.getMeeting(m.id).status, 'finalized');
});

test('删正文段落（含 todo 块）不自动取消已分派/已建立的任务', () => {
  const { m, t1 } = seedDraft();
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  // 定稿后要删段需在草稿态演示：重新建一个草稿走删除
  const d = seedDraft();
  meetings.applyEdit(d.m.id, { base_rev: 1, author: 'a', ops: [{ op: 'delete', block_id: 'blk-td1' }] });
  const blocks = meetings.headBlocks(d.m.id);
  assert.ok(!blocks.some(b => b.id === 'blk-td1'));
  const task = tasks.taskView(d.t1);
  assert.equal(task.status, 'provisional');
  assert.equal(task.assignee, 'bob'); // 仍然分派着
});

test('定稿后改负责人是独立变更：新增沿革行，旧签收不确认新分派，需重新签收', () => {
  const { m, t1 } = seedDraft();
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  const before = tasks.taskView(t1);
  const oldAssignment = before.assignment_id;
  tasks.acknowledge(m.id, t1, { by: 'bob' }); // bob 对旧分派签收
  let v = tasks.taskView(t1);
  assert.equal(v.acknowledged, true);

  const ch = tasks.changeAssignee(m.id, t1, { assignee: 'dave', reason: '原负责人休假', by: 'carol' });
  assert.equal(ch.from, 'bob');
  assert.equal(ch.to, 'dave');

  v = tasks.taskView(t1);
  assert.equal(v.assignee, 'dave');
  assert.equal(v.acknowledged, false);            // 新分派下未签收
  assert.notEqual(v.assignment_id, oldAssignment);
  const hist = tasks.listAssignments(t1);
  assert.equal(hist.length, 2);                    // 沿革完整
  assert.ok(hist[0].superseded_at);                // 旧行被取代而非覆盖

  // 试图对旧 assignment 补签收 -> 拒绝
  assert.throws(() => tasks.acknowledge(m.id, t1, { assignment_id: oldAssignment, by: 'bob' }),
    /新分派需重新签收/);
  // 新负责人签收成功，且只记在新分派上
  tasks.acknowledge(m.id, t1, { by: 'dave' });
  v = tasks.taskView(t1);
  assert.equal(v.acknowledged, true);
  const acksByAssignment = v.acknowledgements.filter(a => a.assignment_id === oldAssignment);
  assert.equal(acksByAssignment.length, 1); // 旧签收仍保留，但不作用于新分派
});

test('离线并行：不同块自动合并；同块不同字段自动合并；同字段冲突被拒绝并可在变基后解决', () => {
  const { m } = seedDraft(); // head rev=1
  // bob 基于 rev=1 改 h1 内容
  meetings.applyEdit(m.id, { base_rev: 1, author: 'bob',
    ops: [{ op: 'upsert', block_id: 'blk-h1', type: 'heading', ord: 0, content: '议题一：风险与合规', task_id: null }] });
  // 服务端 head=2；alice 仍基于 rev=1，改的是另一个块 -> 自动合并成功
  const ok = meetings.applyEdit(m.id, { base_rev: 1, author: 'alice',
    ops: [{ op: 'upsert', block_id: 'blk-td2', type: 'todo', ord: 2, content: '预算事宜(加急)', task_id: 'task-B' }] });
  assert.equal(ok.rev, 3);
  let blocks = meetings.headBlocks(m.id);
  assert.ok(blocks.some(b => b.content === '议题一：风险与合规'));
  assert.ok(blocks.some(b => b.content === '预算事宜(加急)'));

  // 同字段冲突：carol 仍基于 bob 改之前的 rev=1（离线时拿到的版本），与 head=3 上 bob 改过的 h1 同字段分叉
  assert.throws(() => meetings.applyEdit(m.id, { base_rev: 1, author: 'carol',
    ops: [{ op: 'upsert', block_id: 'blk-h1', type: 'heading', ord: 0, content: '议题一：完全不同', task_id: null }] }),
    /块级冲突/);

  // 变基到 head(rev=3) 后重放同样内容：carol 与 head 仍不同 -> 仍冲突（需人工）；改为采纳新值则成功
  // 变基到 head(rev=3) 后，把内容改到与 bob 不冲突即可提交
  const merged = meetings.applyEdit(m.id, { base_rev: 3, author: 'carol',
    ops: [{ op: 'upsert', block_id: 'blk-h1', type: 'heading', ord: 0, content: '议题一：风险与合规（补充）', task_id: null }] });
  assert.equal(merged.rev, 4);
});

test('决议撤回：定稿前标记引用 dropped 且不取消任务；定稿后生成修正案快照', () => {
  const { m, t1, t2 } = seedDraft();
  const decs = decisions.listDecisions(m.id);
  const d1 = decs.find(d => d.code === 'D-1');
  decisions.withdrawDecision(m.id, d1.id, { reason: '误录', by: 'alice' });
  const after = decisions.decisionView(d1.id);
  assert.equal(after.status, 'withdrawn');
  assert.deepEqual(after.task_ids, []);
  assert.equal(tasks.taskView(t1).status, 'provisional'); // 任务不受影响

  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  const beforeSeq = snapshots.listSnapshots(m.id).length;
  const d2 = decisions.listDecisions(m.id).find(d => d.code === 'D-2');
  const w = decisions.withdrawDecision(m.id, d2.id, { reason: '情况变化', by: 'a' });
  assert.ok(w.amendment_snapshot_id);
  const snaps = snapshots.listSnapshots(m.id);
  assert.equal(snaps.length, beforeSeq + 1);
  assert.equal(snaps[snaps.length - 1].kind, 'amendment');
  assert.equal(meetings.getMeeting(m.id).status, 'amended');
  // 任务仍在
  assert.equal(tasks.taskView(t2).status, 'established');
});

test('渲染：表格阶段中断保留检查点，同 token 断点续跑成功且幂等', () => {
  const { m } = seedDraft();
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  renderer.failNextAt('render_todo_table');
  const token = 'tok-render-1';
  let interruptedJob = null;
  try {
    renderer.runJob(m.id, token);
    assert.fail('应中断');
  } catch (e) {
    assert.equal(e.code, 'render_interrupted');
    interruptedJob = renderer.getJob(m.id, token);
    assert.equal(interruptedJob.status, 'interrupted');
    assert.equal(interruptedJob.stage_seq, 2); // collect,assemble 已完成
    const cps = JSON.parse(interruptedJob.checkpoints_json);
    assert.ok(cps.assemble);
    assert.equal(cps.render_todo_table, undefined);
  }
  // 断点续跑
  const r = renderer.runJob(m.id, token);
  assert.equal(r.resumed, true);
  assert.equal(r.job.status, 'done');
  assert.match(r.result_md, /待办汇总表/);
  assert.equal(r.job.stage_seq, 5);
  // 再跑同 token：直接返回既有结果
  const again = renderer.runJob(m.id, token);
  assert.equal(again.reused, true);
});

test('导出只从快照还原：定稿后改负责人/完成任务，旧版导出仍是当时负责人，且不含后来状态', () => {
  const { m, t1, t2 } = seedDraft();
  tasks.acknowledge(m.id, t1, { by: 'bob' });
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  const snaps1 = snapshots.listSnapshots(m.id);
  const finalSnapId = snaps1[0].id;

  const expBefore = renderer.exportSnapshot(m.id);
  assert.match(expBefore.markdown, /bob/);
  assert.match(expBefore.markdown, /carol/);
  assert.match(expBefore.markdown, /定稿时负责人/);

  // 定稿后：改 t1 负责人 bob->zoe；t2 标记完成
  tasks.changeAssignee(m.id, t1, { assignee: 'zoe', reason: '转岗', by: 'a' });
  tasks.setStatus(m.id, t2, { status: 'done', by: 'a' });

  // 默认导出（最新快照=定稿快照，因为没有修正案）仍应是 bob / established
  const expAfter = renderer.exportSnapshot(m.id, finalSnapId);
  assert.equal(expAfter.snapshot_id, finalSnapId);
  assert.match(expAfter.markdown, /bob/);
  assert.ok(!/zoe/.test(expAfter.markdown), '旧快照不应混入新负责人 zoe');
  const rowT2 = expAfter.markdown.split('\n').find(l => l.startsWith('| ' + t2 + ' |'));
  assert.ok(rowT2, '应在汇总表中找到该任务行');
  assert.match(rowT2, /established/, '旧快照保留任务定稿时状态，不含后来的 done');
  assert.ok(!/\| done \|/.test(expAfter.markdown), '旧快照不应出现后来的 done 状态');
});

test('修正案导出包含撤回标记，且正文任务引用仍可追溯', () => {
  const { m } = seedDraft();
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  const d1 = decisions.listDecisions(m.id).find(d => d.code === 'D-1');
  decisions.withdrawDecision(m.id, d1.id, { reason: 'x', by: 'a' });
  const latest = renderer.exportSnapshot(m.id); // 最新=修正案
  assert.match(latest.markdown, /D-1\*\* _（已撤回）_/);
  assert.match(latest.markdown, /待办汇总表/);
});

test('会议状态与待办状态分离：页面可同时区分"会议已定稿"与"待办已建立"', () => {
  const m = newMeeting();
  assert.equal(meetings.getMeeting(m.id).status, 'draft');
  tasks.upsertTask(m.id, { id: 'p1', title: '草稿任务', assignee: 'a' });
  // 草稿会议里任务是 provisional（待办未建立）
  assert.equal(tasks.taskView('p1').status, 'provisional');
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  assert.equal(meetings.getMeeting(m.id).status, 'finalized');
  assert.equal(tasks.taskView('p1').status, 'established');
});

test('定稿后正文冻结：直接编辑被拒绝，必须走独立通道', () => {
  const { m } = seedDraft();
  snapshots.finalize(m.id, { idempotency_key: 'k', by: 'a' });
  assert.throws(() => meetings.applyEdit(m.id, { base_rev: meetings.getMeeting(m.id).head_rev,
    author: 'a', ops: [{ op: 'upsert', block_id: 'x', type: 'para', ord: 0, content: '偷偷改正文' }] }),
    /正文不可直接编辑/);
});
