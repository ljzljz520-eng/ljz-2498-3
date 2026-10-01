'use strict';
const express = require('express');
const path = require('path');
const { HttpError } = require('./errors');
const meetings = require('./services/meetings');
const tasks = require('./services/tasks');
const decisions = require('./services/decisions');
const snapshots = require('./services/snapshots');
const renderer = require('./services/renderer');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../../web')));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const actor = req => req.get('x-actor') || req.body?.actor || 'anonymous';

// ---- 会议 ----
app.post('/api/meetings', wrap((req, res) =>
  res.status(201).json(meetings.createMeeting({ ...req.body, author: actor(req) }))));
app.get('/api/meetings', wrap((req, res) => res.json(meetings.listMeetings())));
app.get('/api/meetings/:id', wrap((req, res) => res.json(meetings.getMeeting(req.params.id))));
app.get('/api/meetings/:id/head', wrap((req, res) =>
  res.json({ meeting: meetings.getMeeting(req.params.id), blocks: meetings.headBlocks(req.params.id) })));
app.post('/api/meetings/:id/edit', wrap((req, res) =>
  res.json(meetings.applyEdit(req.params.id, { ...req.body, author: actor(req) }))));
app.get('/api/meetings/:id/revisions', wrap((req, res) => res.json(meetings.listRevisions(req.params.id))));

// ---- 任务（编辑即创建：provisional）----
app.put('/api/meetings/:id/tasks', wrap((req, res) =>
  res.status(200).json(tasks.batchUpsertTasks(req.params.id, req.body.items || []))));
app.put('/api/meetings/:id/tasks/:tid', wrap((req, res) => {
  const r = tasks.upsertTask(req.params.id, { ...req.body, id: req.params.tid });
  if (!r.ok) return res.status(400).json(r.error);
  res.json(r.data);
}));
app.get('/api/meetings/:id/tasks', wrap((req, res) => res.json(tasks.listTasks(req.params.id))));
app.get('/api/meetings/:id/tasks/missing', wrap((req, res) => res.json({ missing: tasks.missingAssignees(req.params.id) })));
app.get('/api/meetings/:id/tasks/references', wrap((req, res) => res.json(tasks.referenceReport(req.params.id))));

// ---- 负责人独立变更 & 签收 ----
app.post('/api/meetings/:id/tasks/:tid/assignee', wrap((req, res) =>
  res.json(tasks.changeAssignee(req.params.id, req.params.tid, { ...req.body, by: actor(req) }))));
app.post('/api/meetings/:id/tasks/:tid/acknowledge', wrap((req, res) =>
  res.json(tasks.acknowledge(req.params.id, req.params.tid, { ...req.body, by: actor(req) }))));
app.post('/api/meetings/:id/tasks/:tid/status', wrap((req, res) =>
  res.json(tasks.setStatus(req.params.id, req.params.tid, { ...req.body, by: actor(req) }))));

// ---- 决议（业务接口维护引用）----
app.post('/api/meetings/:id/decisions', wrap((req, res) =>
  res.status(201).json(decisions.createDecision(req.params.id, { ...req.body, by: actor(req) }))));
app.get('/api/meetings/:id/decisions', wrap((req, res) => res.json(decisions.listDecisions(req.params.id))));
app.post('/api/meetings/:id/decisions/:did/link', wrap((req, res) =>
  res.json(decisions.linkTask(req.params.id, req.params.did, { ...req.body, by: actor(req) }))));
app.delete('/api/meetings/:id/decisions/:did/link/:tid', wrap((req, res) =>
  res.json(decisions.unlinkTask(req.params.id, req.params.did, req.params.tid))));
app.post('/api/meetings/:id/decisions/:did/withdraw', wrap((req, res) =>
  res.json(decisions.withdrawDecision(req.params.id, req.params.did, { ...req.body, by: actor(req) }))));

// ---- 定稿（幂等）----
app.post('/api/meetings/:id/finalize', wrap((req, res) => {
  try {
    res.json(snapshots.finalize(req.params.id, {
      idempotency_key: req.body.idempotency_key,
      allow_missing_assignees: !!req.body.allow_missing_assignees,
      by: actor(req),
    }));
  } catch (e) {
    if (e.status === 409 && e.details?.already_finalized) return res.status(200).json({ ...e.details, conflict: true });
    throw e;
  }
}));
app.get('/api/meetings/:id/snapshots', wrap((req, res) => res.json(snapshots.listSnapshots(req.params.id))));
app.get('/api/meetings/:id/snapshots/:sid', wrap((req, res) => res.json(snapshots.getSnapshot(req.params.sid))));

// ---- 渲染服务 ----
app.post('/api/meetings/:id/render', wrap((req, res) => {
  try {
    const r = renderer.runJob(req.params.id, req.body.client_token, { snapshotId: req.body.snapshot_id });
    res.json({ status: r.job.status, resumed: r.resumed, reused: r.reused, result_md: r.result_md });
  } catch (e) {
    if (e.code === 'render_interrupted') return res.status(503).json({ code: e.code, ...e.details, message: e.message });
    throw e;
  }
}));
app.get('/api/meetings/:id/render/:token', wrap((req, res) => res.json(renderer.getJob(req.params.id, req.params.token))));
app.get('/api/meetings/:id/render', wrap((req, res) => res.json(renderer.listJobs(req.params.id))));
// 测试用故障注入
app.post('/api/_test/fail-next-render', wrap((req, res) => { renderer.failNextAt(req.body.stage); res.json({ fail_at: req.body.stage }); }));

// ---- 导出（只从快照还原）----
app.get('/api/meetings/:id/export', wrap((req, res) => {
  const out = renderer.exportSnapshot(req.params.id, req.query.snapshot_id);
  res.type('text/markdown; charset=utf-8').set('X-Snapshot-Id', out.snapshot_id).send(out.markdown);
}));
app.get('/api/meetings/:id/export.json', wrap((req, res) =>
  res.json(renderer.exportSnapshot(req.params.id, req.query.snapshot_id))));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code || 'internal', message: err.message, details: err.details });
});

module.exports = app;
