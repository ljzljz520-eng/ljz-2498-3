'use strict';
const { db, tx } = require('../db');
const { newId } = require('../ids');
const { nowIso } = require('../clock');
const { badRequest, notFound } = require('../errors');
const snapshots = require('./snapshots');
const { explainDeadline } = require('./deadline');

// 正式纪要渲染管线。每个阶段产出确定性片段并落检查点；
// 任何阶段中断（崩溃/被注入故障）后，用同一 client_token 重跑即可从断点续跑，已完成阶段不重复计算。
const STAGES = ['collect', 'assemble', 'render_todo_table', 'render_decisions', 'finalize_doc'];

// 故障注入点：renderer.failAt(jobId?) 便于验收"生成表格中断"
let _failStage = null;
function failNextAt(stage) { _failStage = stage; }

function createOrGetJob(meetingId, snapshotId, clientToken) {
  if (!clientToken) throw badRequest('client_token 必填（渲染幂等键）');
  return tx(() => {
    const existing = db().prepare('SELECT * FROM render_jobs WHERE meeting_id=? AND client_token=?').get(meetingId, clientToken);
    if (existing) return { job: existing, reused: true };
    const id = newId('job');
    const ts = nowIso();
    db().prepare(`INSERT INTO render_jobs(id,meeting_id,snapshot_id,client_token,status,stage,stage_seq,checkpoints_json,attempts,created_at,updated_at)
                  VALUES (?,?,?,?,'queued','collect',0,'{}',1,?,?)`)
      .run(id, meetingId, snapshotId, clientToken, ts, ts);
    return { job: db().prepare('SELECT * FROM render_jobs WHERE id=?').get(id), reused: false };
  });
}

// ---- 纯函数：各阶段（不碰活数据，只吃快照 data）----
function stageCollect(data) {
  return { title: data.meeting.title, timezone: data.meeting.timezone,
           captured: data.captured_at, rev: data.revision.rev,
           block_count: data.blocks.length, task_count: data.tasks.length, decision_count: data.decisions.length };
}
function stageAssemble(data) {
  return data.blocks.map(b => {
    if (b.type === 'heading') return `## ${b.content}`;
    if (b.type === 'todo') return `- [ ] ${b.content}${b.task_id ? `  ⟶ task:${b.task_id}` : ''}`;
    return b.content;
  }).join('\n\n');
}
function stageRenderTodoTable(data) {
  const tz = data.meeting.timezone;
  const rows = data.tasks.map(t => {
    const dl = explainDeadline(t, tz);
    const acks = (t.assignments || []).find(a => a.id === t.assignment_id);
    const ackText = acks && acks.acks && acks.acks.length
      ? acks.acks.map(x => `${x.by}@${x.at}`).join('; ') : '未签收';
    return `| ${t.id} | ${md(t.title)} | ${md(t.assignee) || '（缺失）'} | ${t.status} | ${md(dl.text)} | ${ackText} |`;
  });
  return [
    '### 待办汇总表',
    '',
    '| 任务 | 事项 | 定稿时负责人 | 状态 | 截止时点 | 该负责人签收 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
function stageRenderDecisions(data) {
  const out = ['### 决议'];;
  for (const d of data.decisions) {
    const tag = d.status === 'withdrawn' ? ' _（已撤回）_' : '';
    out.push(`- **${d.code}**${tag}: ${d.content}` +
      (d.task_ids.length ? `  （关联待办: ${d.task_ids.join(', ')}）` : ''));
  }
  return out.join('\n');
}
function stageFinalizeDoc(data, cps) {
  const meta = cps.collect;
  return [
    `# 会议纪要（正式）：${meta.title}`,
    '',
    `> 本文件由快照 seq@rev ${meta.rev} 于 ${meta.captured} 生成；会议时区 ${meta.timezone}。`,
    '> 负责人/截止时点均为定稿当时状态，事后变更不回改本文件。',
    '',
    '---', '',
    cps.assemble,
    '',
    cps.render_todo_table,
    '',
    cps.render_decisions,
    '',
  ].join('\n');
}
const md = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function runJob(meetingId, clientToken, { snapshotId } = {}) {
  let job = db().prepare('SELECT * FROM render_jobs WHERE meeting_id=? AND client_token=?').get(meetingId, clientToken);
  if (!job) {
    const snap = snapshotId ? snapshots.getSnapshot(snapshotId) : snapshots.latestSnapshot(meetingId);
    if (!snap) throw badRequest('尚无快照可渲染（会议可能未定稿）');
    job = createOrGetJob(meetingId, snap.id, clientToken).job;
  }
  if (job.status === 'done') return { job, reused: true, resumed: false, result_md: job.result_md };

  const snap = snapshots.getSnapshot(job.snapshot_id);
  const data = snap.data;

  // 断点续跑：从 stage_seq 之后继续，checkpoints 已完成片段直接复用
  let cps = JSON.parse(job.checkpoints_json);
  let resumed = job.stage_seq > 0;
  const runners = { collect: stageCollect, assemble: stageAssemble, render_todo_table: stageRenderTodoTable,
    render_decisions: stageRenderDecisions };

  for (let i = job.stage_seq; i < STAGES.length; i++) {
    const stage = STAGES[i];
    markRunning(job.id, stage, i);
    if (_failStage === stage) {
      _failStage = null;
      db().prepare("UPDATE render_jobs SET status='interrupted', error=?, updated_at=? WHERE id=?")
        .run(`模拟故障@${stage}（检查点已保留至第 ${i} 阶段，可用同一 client_token 续跑）`, nowIso(), job.id);
      const interrupted = db().prepare('SELECT * FROM render_jobs WHERE id=?').get(job.id);
      const err = new Error(`render interrupted at ${stage}`);
      err.interruptedJob = interrupted;
      throw Object.assign(err, { status: 503, code: 'render_interrupted', details: { stage, stage_seq: i, job_id: job.id, client_token: clientToken } });
    }
    if (stage === 'finalize_doc') {
      cps[stage] = stageFinalizeDoc(data, cps);
    } else {
      cps[stage] = runners[stage](data);
    }
    // 每阶段完成即落检查点
    db().prepare("UPDATE render_jobs SET stage_seq=?, checkpoints_json=?, attempts=attempts+1, updated_at=? WHERE id=?")
      .run(i + 1, JSON.stringify(cps), nowIso(), job.id);
  }

  const result_md = cps.finalize_doc;
  db().prepare("UPDATE render_jobs SET status='done', result_md=?, updated_at=? WHERE id=?")
    .run(result_md, nowIso(), job.id);
  job = db().prepare('SELECT * FROM render_jobs WHERE id=?').get(job.id);
  return { job, reused: false, resumed, result_md };
}

function markRunning(jobId, stage, seq) {
  db().prepare("UPDATE render_jobs SET status='running', stage=?, updated_at=? WHERE id=? AND status!='done'")
    .run(stage, nowIso(), jobId);
}

function getJob(meetingId, clientToken) {
  const job = db().prepare('SELECT * FROM render_jobs WHERE meeting_id=? AND client_token=?').get(meetingId, clientToken);
  if (!job) throw notFound('渲染任务不存在');
  return job;
}

function listJobs(meetingId) {
  return db().prepare('SELECT id,client_token,status,stage,stage_seq,attempts,created_at FROM render_jobs WHERE meeting_id=? ORDER BY rowid').all(meetingId);
}

// 导出：直接对指定快照同步渲染（不走任务表），保证还原当时负责人，不混入后来任务状态
function exportSnapshot(meetingId, snapshotId) {
  const snap = snapshotId ? snapshots.getSnapshot(snapshotId) : snapshots.latestSnapshot(meetingId);
  if (!snap) throw badRequest('无可导出快照');
  const data = snap.data;
  const cps = {
    collect: stageCollect(data),
    assemble: stageAssemble(data),
    render_todo_table: stageRenderTodoTable(data),
    render_decisions: stageRenderDecisions(data),
  };
  return { snapshot_id: snap.id, seq: snap.seq, content_hash: snap.content_hash, markdown: stageFinalizeDoc(data, cps) };
}

module.exports = { createOrGetJob, runJob, getJob, listJobs, exportSnapshot, failNextAt, STAGES };
