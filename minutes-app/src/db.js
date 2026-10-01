import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 会议
CREATE TABLE IF NOT EXISTS meetings (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  finalized_version_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 会议版本（每次保存追加一个版本；定稿也是一个版本）
CREATE TABLE IF NOT EXISTS meeting_versions (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id),
  version_no    INTEGER NOT NULL,
  base_version_no INTEGER,
  kind          TEXT NOT NULL DEFAULT 'edit' CHECK (kind IN ('edit','finalize')),
  author        TEXT,
  save_token    TEXT,                 -- 保存幂等键（离线重试安全）
  content_json  TEXT NOT NULL,
  snapshot_complete INTEGER NOT NULL DEFAULT 0,  -- 定稿快照（汇总表）是否生成完毕
  created_at    TEXT NOT NULL,
  UNIQUE (meeting_id, version_no),
  UNIQUE (meeting_id, save_token)
);

-- 决议（正文决议块引用的实体）
CREATE TABLE IF NOT EXISTS resolutions (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id),
  client_token  TEXT NOT NULL,
  code          TEXT NOT NULL,        -- R-1, R-2 ...
  text          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  withdrawn_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (meeting_id, client_token)
);

-- 待办/任务实体：正文待办与汇总表共用此实体
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id),
  client_token  TEXT NOT NULL,        -- 编辑器生成的幂等键
  code          TEXT NOT NULL,        -- T-1, T-2 ...
  resolution_id TEXT REFERENCES resolutions(id),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  due_kind      TEXT NOT NULL DEFAULT 'none' CHECK (due_kind IN ('none','date','datetime')),
  due_date      TEXT,                 -- due_kind=date: YYYY-MM-DD（仅日期）
  due_at        TEXT,                 -- due_kind=datetime: UTC 时刻
  due_tz        TEXT,                 -- IANA 时区
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (meeting_id, client_token)
);

-- 任务状态历史（用于按时点还原状态）
CREATE TABLE IF NOT EXISTS task_status_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  status      TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_events_task ON task_status_events(task_id, changed_at);

-- 负责人沿革：effective_to IS NULL 的为现任
CREATE TABLE IF NOT EXISTS task_assignments (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  owner_name    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  change_type   TEXT NOT NULL CHECK (change_type IN ('initial','reassign','post_finalize')),
  change_token  TEXT,                 -- 分派变更幂等键
  ticket        TEXT,                 -- 定稿后变更的变更单号（独立变更凭据）
  reason        TEXT,
  actor         TEXT,
  effective_from TEXT NOT NULL,
  effective_to  TEXT,                 -- NULL = 当前有效
  created_at    TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_assignment
  ON task_assignments(task_id) WHERE effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assignment_change_token
  ON task_assignments(change_token) WHERE change_token IS NOT NULL;

-- 签收记录：绑定到“某一次分派”，改派后旧签收不会套用到新分派
CREATE TABLE IF NOT EXISTS task_acks (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES task_assignments(id),
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  acked_by      TEXT NOT NULL,
  acked_at      TEXT NOT NULL,
  UNIQUE (assignment_id)
);

-- 正文待办引用（mention）：同任务可在多处引用；删段落只删 mention，不动任务
CREATE TABLE IF NOT EXISTS task_mentions (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL REFERENCES meeting_versions(id),
  meeting_id  TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  block_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (version_id, block_id, task_id)
);

-- 定稿快照：正式纪要/汇总表的数据来源，与后续任务状态隔离
CREATE TABLE IF NOT EXISTS version_task_snapshots (
  version_id  TEXT NOT NULL REFERENCES meeting_versions(id),
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  task_code   TEXT NOT NULL,
  title       TEXT NOT NULL,
  owner_name  TEXT,                   -- 定稿时点负责人（可能为 NULL = 未指派）
  acked       INTEGER NOT NULL DEFAULT 0,  -- 定稿时点该分派是否已签收
  task_status TEXT NOT NULL,          -- 定稿时点任务状态
  due_kind    TEXT NOT NULL,
  due_date    TEXT,
  due_at      TEXT,
  due_tz      TEXT,
  resolution_code   TEXT,
  resolution_status TEXT,
  mention_blocks TEXT NOT NULL DEFAULT '[]',  -- 该版本正文中引用此任务的块 id
  created_at  TEXT NOT NULL,
  PRIMARY KEY (version_id, task_id)
);

-- 异步作业：定稿快照生成等；中断后可恢复、可重入
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  meeting_id  TEXT NOT NULL,
  version_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

export function openDb(file) {
  if (file && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file || ':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
