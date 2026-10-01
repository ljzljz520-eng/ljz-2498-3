-- 会议纪要编辑器 · 数据模型
-- 设计要点：
--  1) tasks 是唯一任务实体：正文 todo 块、决议引用 decision_task_refs、汇总表都指向同一行
--  2) task_assignments 是负责人沿革；task_acknowledgements 绑定到具体分派版本，不跨版本"继承"
--  3) meeting_revisions 是会议版本链（编辑即建版本，定稿即冻结快照）
--  4) snapshots 自包含（含当时负责人），导出/正式渲染只从快照还原，不读活数据
--  5) 截止时点：due_date 仅日期(按 meeting.timezone 解释)；due_at_utc 是带时区时刻的归一化 UTC

CREATE TABLE IF NOT EXISTS meetings (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  timezone        TEXT NOT NULL,                 -- IANA，如 Asia/Shanghai；仅日期截止按此解释
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | finalized | amended
  head_rev        INTEGER NOT NULL DEFAULT 0,
  finalized_at    TEXT,
  finalized_by    TEXT,
  final_revision_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 会议版本（离线并行修改靠 base_rev 做块级三路合并）
CREATE TABLE IF NOT EXISTS meeting_revisions (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id),
  rev           INTEGER NOT NULL,                -- 每会议单调递增
  base_rev      INTEGER,                         -- 基于哪个版本编辑
  change_type   TEXT NOT NULL,                   -- edit | finalize | owner_change | decision_withdraw
  author        TEXT NOT NULL,
  blocks_json   TEXT NOT NULL,                   -- 该版本完整块快照: [{id,type,ord,content,task_id,...}]
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(meeting_id, rev)
);

-- 块的逻辑删除历史（软删除；不级联取消任务）
CREATE TABLE IF NOT EXISTS block_history (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL,
  block_id      TEXT NOT NULL,
  revision_id   TEXT NOT NULL,
  action        TEXT NOT NULL,                   -- insert | update | delete
  snapshot_json TEXT
);

-- 统一任务实体
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,             -- 客户端生成的稳定 ID（幂等关联的关键）
  meeting_id      TEXT NOT NULL REFERENCES meetings(id),
  title           TEXT NOT NULL,
  detail          TEXT,
  status          TEXT NOT NULL DEFAULT 'provisional', -- provisional | established | cancelled | done
  -- 截止时点（二选一；定稿前必须通过校验给出其中之一，或显式留空=无截止）
  due_kind        TEXT,                          -- 'date' | 'datetime' | NULL
  due_date        TEXT,                          -- YYYY-MM-DD，按 meeting.timezone 的日历日解释，不附时刻
  due_at_utc      TEXT,                          -- ISO-8601 UTC 时刻；展示时转回 due_tz
  due_tz          TEXT,                          -- 录入时刻所用 IANA 时区
  created_in_rev  INTEGER,
  established_in_rev INTEGER,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(meeting_id);

-- 负责人沿革：每个任务的每次分派是不可变一行；当前负责人 = 最新未 superseded 行
CREATE TABLE IF NOT EXISTS task_assignments (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  assignee        TEXT,                          -- NULL = 处于"无负责人"间隙（负责人缺失可被显式记录与检测）
  reason          TEXT,
  change_type     TEXT NOT NULL,                 -- assign | clear | reassign
  changed_by      TEXT NOT NULL,
  changed_at      TEXT NOT NULL,
  superseded_at   TEXT                           -- 被下一次分派取代的时刻；NULL 表示当前生效
);
CREATE INDEX IF NOT EXISTS idx_assign_task ON task_assignments(task_id, changed_at);

-- 签收：绑定到具体 assignment_id。负责人变更后旧签收不再"确认"新分派。
CREATE TABLE IF NOT EXISTS task_acknowledgements (
  id              TEXT PRIMARY KEY,
  assignment_id   TEXT NOT NULL REFERENCES task_assignments(id),
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  acknowledged_by TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  note            TEXT,
  UNIQUE(assignment_id, acknowledged_by)
);

-- 决议
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id),
  code         TEXT NOT NULL,                    -- 如 D-1
  content      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',   -- active | withdrawn
  created_in_rev INTEGER,
  withdrawn_at TEXT,
  withdrawn_by TEXT,
  withdraw_reason TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(meeting_id, code)
);

-- 决议↔任务 引用（业务接口维护；同一任务可被多处引用）
CREATE TABLE IF NOT EXISTS decision_task_refs (
  id           TEXT PRIMARY KEY,
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  dropped_at   TEXT,                             -- 决议撤回时引用标记 dropped，不删行（可追溯）
  UNIQUE(decision_id, task_id)
);

-- 定稿/修正案快照（不可变）。snapshot_json 自包含：块、任务(含当时负责人与签收)、决议
CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  meeting_id   TEXT NOT NULL REFERENCES meetings(id),
  kind         TEXT NOT NULL,                    -- final | amendment
  revision_id  TEXT NOT NULL REFERENCES meeting_revisions(id),
  seq          INTEGER NOT NULL,                 -- 同一会议内 1..（正式版序列；修正案递增）
  trigger      TEXT NOT NULL,                    -- finalize | decision_withdraw
  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,                   -- 确定性哈希，渲染输入去重/断点判定
  created_at   TEXT NOT NULL,
  UNIQUE(meeting_id, seq)
);

-- 渲染服务任务（正式纪要生成；分阶段检查点，中断可续跑，client_token 幂等）
CREATE TABLE IF NOT EXISTS render_jobs (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL,
  snapshot_id   TEXT NOT NULL REFERENCES snapshots(id),
  client_token  TEXT NOT NULL,                   -- 客户端幂等键
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | interrupted
  stage         TEXT NOT NULL DEFAULT 'collect',-- collect | assemble | render_todo_table | render_decisions | finalize_doc
  stage_seq     INTEGER NOT NULL DEFAULT 0,     -- 已完成阶段序号
  checkpoints_json TEXT NOT NULL DEFAULT '{}',  -- 各阶段产物检查点
  result_md     TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(meeting_id, client_token)
);
CREATE INDEX IF NOT EXISTS idx_render_status ON render_jobs(status);

-- 定稿操作幂等记录
CREATE TABLE IF NOT EXISTS finalize_keys (
  meeting_id   TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY(meeting_id, idempotency_key)
);
