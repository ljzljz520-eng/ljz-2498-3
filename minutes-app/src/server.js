import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { ApiError } from './util.js';
import * as svc from './services.js';
import { renderMinutes } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ dbFile = ':memory:' } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { req.db = db; next(); });

  const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

  /* ---------- 会议 ---------- */
  app.post('/api/meetings', wrap((req, res) => {
    res.status(201).json(svc.createMeeting(req.db, req.body || {}));
  }));
  app.get('/api/meetings', wrap((req, res) => res.json(svc.listMeetings(req.db))));
  app.get('/api/meetings/:id', wrap((req, res) => res.json(svc.getMeetingState(req.db, req.params.id))));

  app.get('/api/meetings/:id/versions/:no', wrap((req, res) => {
    const v = req.db.prepare('SELECT * FROM meeting_versions WHERE meeting_id = ? AND version_no = ?')
      .get(req.params.id, Number(req.params.no));
    if (!v) throw new ApiError(404, 'version_not_found', '版本不存在');
    res.json({ ...v, content: JSON.parse(v.content_json) });
  }));

  /* ---------- 保存（乐观并发 + 幂等） ---------- */
  app.post('/api/meetings/:id/versions', wrap((req, res) => {
    const { version, idempotent } = svc.saveVersion(req.db, req.params.id, req.body || {});
    res.status(idempotent ? 200 : 201).json({
      version_no: version.version_no, kind: version.kind, idempotent,
      state: svc.getMeetingState(req.db, req.params.id),
    });
  }));

  /* ---------- 定稿（幂等；快照作业可注入失败用于演练中断恢复） ---------- */
  app.post('/api/meetings/:id/finalize', wrap((req, res) => {
    const out = svc.finalizeMeeting(req.db, req.params.id, {
      author: req.body?.author,
      failAfter: req.body?.__test_fail_after,   // 测试钩子：模拟生成表格中断
    });
    res.json(out);
  }));

  /* ---------- 任务分派 / 签收 / 状态 ---------- */
  app.post('/api/tasks/:id/assignment', wrap((req, res) => {
    res.json(svc.changeOwner(req.db, req.params.id, req.body || {}));
  }));
  app.post('/api/tasks/:id/ack', wrap((req, res) => {
    res.json(svc.ackTask(req.db, req.params.id, req.body || {}));
  }));
  app.post('/api/tasks/:id/status', wrap((req, res) => {
    res.json(svc.setTaskStatus(req.db, req.params.id, req.body?.status));
  }));
  app.get('/api/tasks/:id/history', wrap((req, res) => {
    const asgs = req.db.prepare(
      'SELECT * FROM task_assignments WHERE task_id = ? ORDER BY seq'
    ).all(req.params.id).map(a => ({
      ...a,
      ack: req.db.prepare('SELECT * FROM task_acks WHERE assignment_id = ?').get(a.id) || null,
    }));
    res.json({ assignments: asgs });
  }));

  /* ---------- 决议 ---------- */
  app.post('/api/resolutions/:id/withdraw', wrap((req, res) => {
    res.json(svc.withdrawResolution(req.db, req.params.id));
  }));

  /* ---------- 作业恢复（部分失败恢复） ---------- */
  app.post('/api/jobs/run', wrap((req, res) => {
    res.json({ outcomes: svc.runJobs(req.db, { meetingId: req.body?.meeting_id, failAfter: req.body?.__test_fail_after }) });
  }));

  /* ---------- 导出 / 渲染正式纪要 ---------- */
  app.get('/api/meetings/:id/export.json', wrap((req, res) => {
    svc.runJobs(req.db, { meetingId: req.params.id });  // 导出前自动补齐未完成快照
    const model = svc.buildExportModel(req.db, req.params.id,
      req.query.version_no != null ? Number(req.query.version_no) : null);
    res.json(model);
  }));
  app.get('/api/meetings/:id/export', wrap((req, res) => {
    svc.runJobs(req.db, { meetingId: req.params.id });
    const model = svc.buildExportModel(req.db, req.params.id,
      req.query.version_no != null ? Number(req.query.version_no) : null);
    res.type('html').send(renderMinutes(model));
  }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  /* ---------- 静态资源（Vue 页面） ---------- */
  app.use(express.static(path.join(__dirname, '..', 'public')));

  /* ---------- 错误处理 ---------- */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    } else {
      console.error(err);
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  return { app, db };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'minutes.db');
  const { app } = createApp({ dbFile });
  app.listen(port, () => console.log(`会议纪要编辑器: http://localhost:${port}  (db: ${dbFile})`));
}
