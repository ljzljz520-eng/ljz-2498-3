import { uid, nowIso, ApiError, normalizeDue, isOverdue, dueLabel } from './util.js';

/* ============================== 查询助手 ============================== */

export function getMeeting(db, id) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!m) throw new ApiError(404, 'meeting_not_found', '会议不存在');
  return m;
}

function latestVersion(db, meetingId) {
  return db.prepare(
    'SELECT * FROM meeting_versions WHERE meeting_id = ? ORDER BY version_no DESC LIMIT 1'
  ).get(meetingId);
}

function currentAssignment(db, taskId) {
  return db.prepare(
    'SELECT * FROM task_assignments WHERE task_id = ? AND effective_to IS NULL'
  ).get(taskId);
}

// 时点 T 的负责人分派（负责人沿革按区间还原）
function assignmentAt(db, taskId, isoT) {
  return db.prepare(
    `SELECT * FROM task_assignments
     WHERE task_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
     ORDER BY seq DESC LIMIT 1`
  ).get(taskId, isoT, isoT);
}

function ackForAssignment(db, assignmentId, beforeIso = null) {
  if (beforeIso) {
    return db.prepare(
      'SELECT * FROM task_acks WHERE assignment_id = ? AND acked_at <= ?'
    ).get(assignmentId, beforeIso);
  }
  return db.prepare('SELECT * FROM task_acks WHERE assignment_id = ?').get(assignmentId);
}

// 时点 T 的任务状态（来自状态事件流）
function statusAt(db, taskId, isoT) {
  const row = db.prepare(
    `SELECT status FROM task_status_events
     WHERE task_id = ? AND changed_at <= ? ORDER BY changed_at DESC, rowid DESC LIMIT 1`
  ).get(taskId, isoT);
  return row ? row.status : 'open';
}

function nextCode(db, table, meetingId, prefix) {
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE meeting_id = ?`).get(meetingId);
  return `${prefix}-${c + 1}`;
}

/* ============================== 会议与版本 ============================== */

export function createMeeting(db, { title }) {
  if (!title || !title.trim()) throw new ApiError(422, 'title_required', '会议标题必填');
  const now = nowIso();
  const id = uid();
  db.prepare('INSERT INTO meetings (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id, title.trim(), 'draft', now, now);
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

export function listMeetings(db) {
  return db.prepare('SELECT * FROM meetings ORDER BY created_at DESC').all();
}

/**
 * 保存内容（追加版本）。乐观并发：base_version_no 必须等于当前最大版本号，
 * 否则 409 并带回当前内容（离线并行修改场景：后提交者拿到最新版本再合并重试）。
 * save_token 保证断网重试幂等。
 */
export const saveVersion = (db, meetingId, { base_version_no, content, author, save_token, title }) => {
  const tx = db.transaction(() => {
    const meeting = getMeeting(db, meetingId);
    if (meeting.status === 'finalized') {
      throw new ApiError(409, 'meeting_finalized', '会议已定稿，正文不可再编辑；负责人等变更请走独立变更接口');
    }
    if (save_token) {
      const dup = db.prepare(
        'SELECT * FROM meeting_versions WHERE meeting_id = ? AND save_token = ?'
      ).get(meetingId, save_token);
      if (dup) return { version: dup, idempotent: true };
    }
    const cur = latestVersion(db, meetingId);
    const curNo = cur ? cur.version_no : 0;
    if ((base_version_no ?? 0) !== curNo) {
      throw new ApiError(409, 'version_conflict', '内容已被他人更新，请合并后重试', {
        current_version_no: curNo,
        content: cur ? JSON.parse(cur.content_json) : null,
      });
    }
    if (!content || !Array.isArray(content.blocks)) {
      throw new ApiError(422, 'content_invalid', '内容格式不正确');
    }
    if (title && title.trim()) {
      db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title.trim(), meetingId);
    }
    const version = {
      id: uid(), meeting_id: meetingId, version_no: curNo + 1,
      base_version_no: curNo, kind: 'edit', author: author || null,
      save_token: save_token || null,
      content_json: JSON.stringify(content), created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO meeting_versions (id, meeting_id, version_no, base_version_no, kind, author, save_token, content_json, created_at)
       VALUES (@id, @meeting_id, @version_no, @base_version_no, @kind, @author, @save_token, @content_json, @created_at)`
    ).run(version);
    reconcileContent(db, meeting, version, content, save_token);
    db.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').run(nowIso(), meetingId);
    return { version, idempotent: false };
  });
  return tx();
};

/**
 * 内容对账（编辑即创建策略）：
 *  - 决议块 -> 决议实体（client_token 幂等）
 *  - 待办块 -> 任务实体（client_token 幂等），正文 mention 关联到本版本
 *  - 删除段落只减少 mention，不取消任务
 */
function reconcileContent(db, meeting, version, content, saveToken) {
  const now = nowIso();
  const findRes = db.prepare('SELECT * FROM resolutions WHERE meeting_id = ? AND client_token = ?');
  const insRes = db.prepare(
    'INSERT INTO resolutions (id, meeting_id, client_token, code, text, status, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const updRes = db.prepare('UPDATE resolutions SET text = ? WHERE id = ?');
  const resByToken = new Map();

  for (const b of content.blocks) {
    if (b.type !== 'resolution') continue;
    if (!b.token) throw new ApiError(422, 'resolution_token_required', '决议块缺少 token');
    let r = findRes.get(meeting.id, b.token);
    if (!r) {
      const id = uid();
      insRes.run(id, meeting.id, b.token, nextCode(db, 'resolutions', meeting.id, 'R'),
        (b.text || '').trim() || '（未填写决议内容）', 'active', now);
      r = findRes.get(meeting.id, b.token);
    } else if ((b.text ?? null) !== null && b.text.trim() && b.text !== r.text) {
      updRes.run(b.text.trim(), r.id);
      r = { ...r, text: b.text.trim() };
    }
    resByToken.set(b.token, r);
  }

  const findTask = db.prepare('SELECT * FROM tasks WHERE meeting_id = ? AND client_token = ?');
  const insMention = db.prepare(
    'INSERT OR IGNORE INTO task_mentions (id, version_id, meeting_id, task_id, block_id, created_at) VALUES (?,?,?,?,?,?)'
  );

  for (const b of content.blocks) {
    if (b.type !== 'todo') continue;
    if (!b.token) throw new ApiError(422, 'todo_token_required', '待办块缺少 token');
    const due = normalizeDue(b);
    const title = (b.title || '').trim();
    if (!title) throw new ApiError(422, 'todo_title_required', '待办事项需要标题');

    // 决议引用维护
    let resolutionId = null;
    let resolution = null;
    if (b.resolution_token) {
      resolution = resByToken.get(b.resolution_token)
        || findRes.get(meeting.id, b.resolution_token);
      if (!resolution) throw new ApiError(422, 'resolution_not_found', `引用的决议不存在: ${b.resolution_token}`);
      resolutionId = resolution.id;
    }

    let task = findTask.get(meeting.id, b.token);
    if (!task) {
      // 新建任务不允许挂到已撤回的决议
      if (resolution && resolution.status === 'withdrawn') {
        throw new ApiError(422, 'resolution_withdrawn', `决议 ${resolution.code} 已撤回，不能关联新待办`);
      }
      const id = uid();
      db.prepare(
        `INSERT INTO tasks (id, meeting_id, client_token, code, resolution_id, title, status, due_kind, due_date, due_at, due_tz, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, meeting.id, b.token, nextCode(db, 'tasks', meeting.id, 'T'), resolutionId,
        title, 'open', due.due_kind, due.due_date, due.due_at, due.due_tz, now, now);
      db.prepare('INSERT INTO task_status_events (id, task_id, status, changed_at) VALUES (?,?,?,?)')
        .run(uid(), id, 'open', now);
      const owner = (b.owner || '').trim();
      if (owner) insertAssignment(db, { taskId: id, owner, seq: 1, changeType: 'initial', now });
      task = findTask.get(meeting.id, b.token);
    } else {
      // 已存在任务：更新字段；关联变更不允许指向已撤回决议
      if (resolutionId !== task.resolution_id && resolution && resolution.status === 'withdrawn') {
        throw new ApiError(422, 'resolution_withdrawn', `决议 ${resolution.code} 已撤回，不能关联新待办`);
      }
      db.prepare(
        'UPDATE tasks SET title = ?, resolution_id = ?, due_kind = ?, due_date = ?, due_at = ?, due_tz = ?, updated_at = ? WHERE id = ?'
      ).run(title, resolutionId, due.due_kind, due.due_date, due.due_at, due.due_tz, now, task.id);
      // 草稿期内，正文负责人栏与分派保持同步（定稿后正文已锁定，不会走到这里）
      const cur = currentAssignment(db, task.id);
      const want = (b.owner || '').trim() || null;
      const have = cur ? cur.owner_name : null;
      if (want !== have) {
        if (cur) closeAssignment(db, cur.id, now);
        if (want) {
          insertAssignment(db, {
            taskId: task.id, owner: want, seq: cur ? cur.seq + 1 : 1,
            changeType: cur ? 'reassign' : 'initial',
            changeToken: saveToken ? `save:${saveToken}:${b.id}` : null,
            reason: '编辑修改', now,
          });
        }
      }
    }
    insMention.run(uid(), version.id, meeting.id, task.id, b.id, now);
  }
}

function insertAssignment(db, { taskId, owner, seq, changeType, changeToken = null, ticket = null, reason = null, actor = null, now }) {
  db.prepare(
    `INSERT INTO task_assignments (id, task_id, owner_name, seq, change_type, change_token, ticket, reason, actor, effective_from, effective_to, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(uid(), taskId, owner, seq, changeType, changeToken, ticket, reason, actor, now, now);
}

function closeAssignment(db, assignmentId, now) {
  db.prepare('UPDATE task_assignments SET effective_to = ? WHERE id = ?').run(now, assignmentId);
}

/* ============================== 定稿与快照 ============================== */

/**
 * 定稿：生成 finalize 版本并入队快照作业（幂等）。
 * 快照生成可能部分失败（如生成表格中断），由 jobs 表恢复重入。
 */
export function finalizeMeeting(db, meetingId, { author, failAfter } = {}) {
  const meeting = getMeeting(db, meetingId);
  if (meeting.status === 'finalized') {
    const v = db.prepare('SELECT * FROM meeting_versions WHERE id = ?').get(meeting.finalized_version_id);
    return { already: true, version_no: v.version_no, snapshot_complete: !!v.snapshot_complete, warnings: computeWarnings(db, meetingId) };
  }
  const result = db.transaction(() => {
    const cur = latestVersion(db, meetingId);
    if (!cur) throw new ApiError(422, 'empty_meeting', '会议还没有内容，无法定稿');
    const now = nowIso();
    const version = {
      id: uid(), meeting_id: meetingId, version_no: cur.version_no + 1,
      base_version_no: cur.version_no, kind: 'finalize', author: author || null,
      save_token: null, content_json: cur.content_json, created_at: now,
    };
    db.prepare(
      `INSERT INTO meeting_versions (id, meeting_id, version_no, base_version_no, kind, author, save_token, content_json, created_at)
       VALUES (@id, @meeting_id, @version_no, @base_version_no, @kind, @author, @save_token, @content_json, @created_at)`
    ).run(version);
    // 定稿版本沿用同一正文 -> 正文引用（mention）一并复制，保证汇总表“正文引用数”正确
    db.prepare(
      `INSERT INTO task_mentions (id, version_id, meeting_id, task_id, block_id, created_at)
       SELECT lower(hex(randomblob(16))), ?, meeting_id, task_id, block_id, ? FROM task_mentions WHERE version_id = ?`
    ).run(version.id, now, cur.id);
    db.prepare("UPDATE meetings SET status = 'finalized', finalized_version_id = ?, updated_at = ? WHERE id = ?")
      .run(version.id, now, meetingId);
    db.prepare('INSERT INTO jobs (id, type, meeting_id, version_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid(), 'finalize_snapshot', meetingId, version.id, 'pending', now, now);
    return version;
  })();
  const jobResult = runJobs(db, { meetingId, failAfter });
  const v = db.prepare('SELECT * FROM meeting_versions WHERE id = ?').get(result.id);
  return {
    already: false, version_no: v.version_no, snapshot_complete: !!v.snapshot_complete,
    warnings: computeWarnings(db, meetingId), jobs: jobResult,
  };
}

export function computeWarnings(db, meetingId) {
  const warnings = [];
  const tasks = db.prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY code').all(meetingId);
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
    const cur = currentAssignment(db, t.id);
    if (!cur) warnings.push({ code: 'owner_missing', task_code: t.code, message: `待办 ${t.code}「${t.title}」缺少负责人` });
    if (t.due_kind === 'none') warnings.push({ code: 'due_missing', task_code: t.code, message: `待办 ${t.code}「${t.title}」未设置截止时间` });
    if (t.resolution_id) {
      const r = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(t.resolution_id);
      if (r && r.status === 'withdrawn') warnings.push({ code: 'resolution_withdrawn', task_code: t.code, message: `待办 ${t.code} 关联的决议 ${r.code} 已撤回` });
    }
  }
  return warnings;
}

/** 处理待办作业；failAfter 为测试注入：处理 N 行后模拟中断 */
export function runJobs(db, { meetingId, failAfter } = {}) {
  const jobs = db.prepare(
    "SELECT * FROM jobs WHERE status IN ('pending','failed') AND (? IS NULL OR meeting_id = ?) ORDER BY created_at"
  ).all(meetingId ?? null, meetingId ?? null);
  const outcomes = [];
  for (const job of jobs) {
    db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), job.id);
    try {
      if (job.type === 'finalize_snapshot') processSnapshotJob(db, job, failAfter);
      db.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
      outcomes.push({ job: job.id, type: job.type, status: 'done' });
    } catch (e) {
      db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
        .run(e.message, nowIso(), job.id);
      outcomes.push({ job: job.id, type: job.type, status: 'failed', error: e.message });
    }
  }
  return outcomes;
}

/**
 * 定稿快照：把每个任务在“定稿时点”的负责人/签收/状态/截止/决议写入快照表。
 * 逐行 INSERT OR IGNORE —— 中断后重跑只补缺失行，幂等无重复。
 * 所有取值均按 version.created_at 时点回溯，晚到的恢复不会混入后来的状态。
 */
function processSnapshotJob(db, job, failAfter) {
  const version = db.prepare('SELECT * FROM meeting_versions WHERE id = ?').get(job.version_id);
  const T = version.created_at;
  const tasks = db.prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY code').all(job.meeting_id);
  const insSnap = db.prepare(
    `INSERT OR IGNORE INTO version_task_snapshots
     (version_id, task_id, task_code, title, owner_name, acked, task_status, due_kind, due_date, due_at, due_tz, resolution_code, resolution_status, mention_blocks, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const mentionRows = db.prepare('SELECT block_id FROM task_mentions WHERE version_id = ? AND task_id = ?');
  let processed = 0;
  for (const t of tasks) {
    const asg = assignmentAt(db, t.id, T);
    const ack = asg ? ackForAssignment(db, asg.id, T) : null;
    let resCode = null, resStatus = null;
    if (t.resolution_id) {
      const r = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(t.resolution_id);
      if (r) {
        resCode = r.code;
        resStatus = (r.status === 'withdrawn' && r.withdrawn_at <= T) ? 'withdrawn' : 'active';
      }
    }
    const mentions = mentionRows.all(version.id, t.id).map(x => x.block_id);
    insSnap.run(version.id, t.id, t.code, t.title, asg ? asg.owner_name : null,
      ack ? 1 : 0, statusAt(db, t.id, T), t.due_kind, t.due_date, t.due_at, t.due_tz,
      resCode, resStatus, JSON.stringify(mentions), nowIso());
    processed += 1;
    if (failAfter != null && processed >= failAfter) {
      throw new Error(`模拟中断：快照生成在处理 ${processed} 行后失败`);
    }
  }
  db.prepare('UPDATE meeting_versions SET snapshot_complete = 1 WHERE id = ?').run(version.id);
}

/* ============================== 任务分派 / 签收 / 状态 ============================== */

/**
 * 负责人变更（独立变更接口）。
 * 定稿后必须提供变更单号 ticket；change_token 幂等。
 * 旧分派的签收记录留在旧分派上，不会“看似确认”新分派。
 */
export function changeOwner(db, taskId, { owner_name, change_token, ticket, reason, actor }) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new ApiError(404, 'task_not_found', '待办不存在');
  const meeting = getMeeting(db, task.meeting_id);
  const owner = (owner_name || '').trim();
  if (!owner) throw new ApiError(422, 'owner_required', '负责人必填');
  if (change_token) {
    const dup = db.prepare('SELECT * FROM task_assignments WHERE change_token = ?').get(change_token);
    if (dup) return { assignment: dup, idempotent: true };
  }
  if (meeting.status === 'finalized' && !(ticket || '').trim()) {
    throw new ApiError(422, 'ticket_required', '会议已定稿，变更负责人需独立变更单号');
  }
  return db.transaction(() => {
    const now = nowIso();
    const cur = currentAssignment(db, taskId);
    if (cur && cur.owner_name === owner) return { assignment: cur, no_change: true };
    if (cur) closeAssignment(db, cur.id, now);
    const changeType = meeting.status === 'finalized' ? 'post_finalize' : (cur ? 'reassign' : 'initial');
    const id = uid();
    db.prepare(
      `INSERT INTO task_assignments (id, task_id, owner_name, seq, change_type, change_token, ticket, reason, actor, effective_from, effective_to, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`
    ).run(id, taskId, owner, cur ? cur.seq + 1 : 1, changeType, change_token || null,
      ticket || null, reason || null, actor || null, now, now);
    return { assignment: db.prepare('SELECT * FROM task_assignments WHERE id = ?').get(id), idempotent: false };
  })();
}

/** 签收：绑定当前分派；重复签收幂等 */
export function ackTask(db, taskId, { acked_by }) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new ApiError(404, 'task_not_found', '待办不存在');
  if (!(acked_by || '').trim()) throw new ApiError(422, 'acked_by_required', '签收人必填');
  const cur = currentAssignment(db, taskId);
  if (!cur) throw new ApiError(422, 'no_assignment', '任务尚未分派，无法签收');
  const existing = ackForAssignment(db, cur.id);
  if (existing) return { ack: existing, idempotent: true };
  const id = uid();
  db.prepare('INSERT INTO task_acks (id, assignment_id, task_id, acked_by, acked_at) VALUES (?,?,?,?,?)')
    .run(id, cur.id, taskId, acked_by.trim(), nowIso());
  return { ack: db.prepare('SELECT * FROM task_acks WHERE id = ?').get(id), idempotent: false };
}

export function setTaskStatus(db, taskId, status) {
  if (!['open', 'done', 'cancelled'].includes(status)) {
    throw new ApiError(422, 'status_invalid', '状态必须是 open/done/cancelled');
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new ApiError(404, 'task_not_found', '待办不存在');
  if (task.status === status) return { task, idempotent: true };
  const now = nowIso();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, taskId);
  db.prepare('INSERT INTO task_status_events (id, task_id, status, changed_at) VALUES (?,?,?,?)')
    .run(uid(), taskId, status, now);
  return { task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), idempotent: false };
}

export function withdrawResolution(db, resolutionId) {
  const r = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(resolutionId);
  if (!r) throw new ApiError(404, 'resolution_not_found', '决议不存在');
  if (r.status === 'withdrawn') return { resolution: r, idempotent: true };
  db.prepare("UPDATE resolutions SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?")
    .run(nowIso(), resolutionId);
  // 注意：不级联取消任务 —— 已分派的工作保持有效，仅在渲染时标注决议已撤回
  return { resolution: db.prepare('SELECT * FROM resolutions WHERE id = ?').get(resolutionId), idempotent: false };
}

/* ============================== 读取模型 ============================== */

function enrichTask(db, task, versionId) {
  const cur = currentAssignment(db, task.id);
  const ack = cur ? ackForAssignment(db, cur.id) : null;
  const mentions = versionId
    ? db.prepare('SELECT COUNT(*) AS c FROM task_mentions WHERE version_id = ? AND task_id = ?').get(versionId, task.id).c
    : 0;
  let resolution = null;
  if (task.resolution_id) {
    const r = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(task.resolution_id);
    if (r) resolution = { id: r.id, code: r.code, status: r.status, text: r.text };
  }
  return {
    ...task,
    owner: cur ? cur.owner_name : null,
    assignment_id: cur ? cur.id : null,
    acked: !!ack,
    ack: ack ? { acked_by: ack.acked_by, acked_at: ack.acked_at } : null,
    mention_count: mentions,
    overdue: task.status === 'open' ? isOverdue(task) : false,
    due_label: dueLabel(task),
    resolution,
  };
}

export function getMeetingState(db, meetingId) {
  const meeting = getMeeting(db, meetingId);
  const versions = db.prepare(
    'SELECT id, version_no, base_version_no, kind, author, snapshot_complete, created_at FROM meeting_versions WHERE meeting_id = ? ORDER BY version_no'
  ).all(meetingId);
  const latest = latestVersion(db, meetingId);
  const content = latest ? JSON.parse(latest.content_json) : { agenda: [], blocks: [] };
  const tasks = db.prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY code').all(meetingId)
    .map(t => enrichTask(db, t, latest ? latest.id : null));
  const resolutions = db.prepare('SELECT * FROM resolutions WHERE meeting_id = ? ORDER BY code').all(meetingId);
  const pendingJobs = db.prepare(
    "SELECT COUNT(*) AS c FROM jobs WHERE meeting_id = ? AND status IN ('pending','failed')"
  ).get(meetingId).c;
  return {
    meeting, versions,
    latest_version_no: latest ? latest.version_no : 0,
    content, tasks, resolutions,
    warnings: computeWarnings(db, meetingId),
    pending_jobs: pendingJobs,
  };
}

export function getTaskHistory(db, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new ApiError(404, 'task_not_found', '待办不存在');
  const assignments = db.prepare('SELECT * FROM task_assignments WHERE task_id = ? ORDER BY seq').all(taskId);
  return {
    task,
    assignments: assignments.map(a => ({
      ...a,
      ack: db.prepare('SELECT * FROM task_acks WHERE assignment_id = ?').get(a.id) || null,
    })),
  };
}

export function getVersionContent(db, meetingId, versionNo) {
  const v = db.prepare('SELECT * FROM meeting_versions WHERE meeting_id = ? AND version_no = ?')
    .get(meetingId, versionNo);
  if (!v) throw new ApiError(404, 'version_not_found', '版本不存在');
  return { ...v, content: JSON.parse(v.content_json) };
}

/* ============================== 导出视图模型 ============================== */

/**
 * 导出视图模型：
 *  - finalize 版本：读取定稿快照（必须先由快照作业生成完毕；自动尝试恢复）
 *  - 普通版本：按版本创建时点回溯负责人沿革/状态事件
 * 两种情况都不会混入后来的任务状态。
 */
export function buildExportModel(db, meetingId, versionNo = null) {
  const meeting = getMeeting(db, meetingId);
  let version;
  if (versionNo != null) {
    version = db.prepare('SELECT * FROM meeting_versions WHERE meeting_id = ? AND version_no = ?')
      .get(meetingId, versionNo);
  } else if (meeting.finalized_version_id) {
    version = db.prepare('SELECT * FROM meeting_versions WHERE id = ?').get(meeting.finalized_version_id);
  } else {
    version = latestVersion(db, meetingId);
  }
  if (!version) throw new ApiError(404, 'version_not_found', '版本不存在');

  let taskRows;
  if (version.kind === 'finalize') {
    if (!version.snapshot_complete) {
      runJobs(db, { meetingId }); // 自动恢复中断的快照
      version = db.prepare('SELECT * FROM meeting_versions WHERE id = ?').get(version.id);
    }
    if (!version.snapshot_complete) {
      throw new ApiError(409, 'snapshot_incomplete', '定稿快照尚未生成完毕，请稍后重试或调用 /api/jobs/run 恢复');
    }
    taskRows = db.prepare('SELECT * FROM version_task_snapshots WHERE version_id = ? ORDER BY task_code')
      .all(version.id)
      .map(s => ({
        task_id: s.task_id, code: s.task_code, title: s.title, owner: s.owner_name,
        acked: !!s.acked, status: s.task_status,
        due_kind: s.due_kind, due_date: s.due_date, due_at: s.due_at, due_tz: s.due_tz,
        resolution_code: s.resolution_code, resolution_status: s.resolution_status,
        mention_blocks: JSON.parse(s.mention_blocks),
      }));
  } else {
    const T = version.created_at;
    const tasks = db.prepare('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY code').all(meetingId);
    taskRows = tasks.map(t => {
      const asg = assignmentAt(db, t.id, T);
      const ack = asg ? ackForAssignment(db, asg.id, T) : null;
      let resCode = null, resStatus = null;
      if (t.resolution_id) {
        const r = db.prepare('SELECT * FROM resolutions WHERE id = ?').get(t.resolution_id);
        if (r) {
          resCode = r.code;
          resStatus = (r.status === 'withdrawn' && r.withdrawn_at <= T) ? 'withdrawn' : 'active';
        }
      }
      const mentions = db.prepare('SELECT block_id FROM task_mentions WHERE version_id = ? AND task_id = ?')
        .all(version.id, t.id).map(x => x.block_id);
      return {
        task_id: t.id, code: t.code, title: t.title, owner: asg ? asg.owner_name : null,
        acked: !!ack, status: statusAt(db, t.id, T),
        due_kind: t.due_kind, due_date: t.due_date, due_at: t.due_at, due_tz: t.due_tz,
        resolution_code: resCode, resolution_status: resStatus, mention_blocks: mentions,
      };
    });
  }

  const content = JSON.parse(version.content_json);
  const resolutions = db.prepare('SELECT * FROM resolutions WHERE meeting_id = ? ORDER BY code').all(meetingId)
    .map(r => ({
      ...r,
      status_at_version: (r.status === 'withdrawn' && r.withdrawn_at <= version.created_at) ? 'withdrawn' : 'active',
    }));
  const taskByToken = new Map();
  for (const t of db.prepare('SELECT id, client_token FROM tasks WHERE meeting_id = ?').all(meetingId)) {
    taskByToken.set(t.client_token, t.id);
  }
  const rowByTaskId = new Map(taskRows.map(r => [r.task_id, r]));

  return {
    meeting, version, content, resolutions,
    tasks: taskRows.map(r => ({ ...r, due_label: dueLabel(r) })),
    blocks: content.blocks.map(b => {
      if (b.type === 'todo') {
        const row = rowByTaskId.get(taskByToken.get(b.token));
        return { ...b, task: row ? { ...row, due_label: dueLabel(row) } : null };
      }
      if (b.type === 'resolution') {
        const r = resolutions.find(x => x.client_token === b.token);
        return { ...b, resolution: r || null };
      }
      return b;
    }),
    generated_at: nowIso(),
  };
}
