# 会议纪要编辑器

议题与待办由 Vue 页面录入；业务接口维护决议引用与任务分派；SQL 储存会议版本、
负责人沿革与截止时点；渲染服务基于定稿快照生成正式纪要。

## 运行

```bash
npm install
npm start          # http://localhost:3000 （DB_FILE 可指定 SQLite 路径）
npm test           # 验收测试（内存库，覆盖全部验收标准）
```

## 架构

```
public/            Vue 3 页面（议题/待办录入、状态徽章、冲突处理、定稿后独立变更）
src/server.js      HTTP 接口层（Express）
src/services.js    业务服务：版本/对账/定稿/分派/签收/快照/导出模型
src/render.js      渲染服务：导出模型 -> 正式纪要 HTML
src/db.js          SQLite schema
src/util.js        时区与截止时点语义
test/acceptance.test.js  验收测试
```

### 数据模型要点

| 表 | 作用 |
|---|---|
| `meeting_versions` | 每次保存追加版本（`kind=edit/finalize`），`save_token` 幂等，`UNIQUE(meeting_id, version_no)` 兜底并发 |
| `tasks` | 待办任务实体（`UNIQUE(meeting_id, client_token)` 幂等关联）；正文待办与汇总表共用 |
| `task_mentions` | 正文块 -> 任务的引用（按版本记录）；删段落只删引用，不动任务 |
| `task_assignments` | 负责人沿革：`effective_from/effective_to` 区间，部分唯一索引保证每人任务仅一任现任 |
| `task_acks` | 签收绑定**某一次分派**（`UNIQUE(assignment_id)`），改派后旧签收不会看似确认新分派 |
| `task_status_events` | 任务状态事件流，支持按时点还原 |
| `version_task_snapshots` | 定稿快照：正式纪要/汇总表的唯一数据源，与后续任务状态隔离 |
| `jobs` | 快照生成等异步作业，`pending/running/done/failed`，支撑部分失败恢复 |

## 关键设计决策

### 1. 待办生成时机：编辑即创建 vs 定稿一次生成

| | 编辑即创建（本实现） | 定稿时一次生成 |
|---|---|---|
| 任务实体建立 | 保存版本时按 `client_token` 对账创建/更新 | 定稿时扫描正文批量创建 |
| 分派/签收可用时机 | 草稿期即可分派、签收、跟踪 | 定稿前无实体可挂 |
| 幂等关联 | `UNIQUE(meeting_id, client_token)`，断网重试/重复保存安全 | 需整批重跑去重，窗口内重复定稿易重复建任务 |
| 部分失败 | 单次保存事务内对账，失败整体回滚，重试幂等 | 大批量创建，中途失败留半成品，恢复复杂 |
| 删段落语义 | 引用减少、任务保留（天然满足"删段落不取消待办"） | 定稿时正文已删的待办根本不会成为任务，语义相反 |

选择**编辑即创建**：任务实体在编辑期就存在，分派、签收、状态跟踪从草稿期开始；
定稿只做**快照对账**（把时点状态固化进快照表），不再创建任务。
幂等关联靠编辑器为每个待办块生成稳定 `client_token`，服务端唯一约束兜底。

### 2. 定稿快照与部分失败恢复

定稿 = 追加 `finalize` 版本 + 入队快照作业。快照逐任务 `INSERT OR IGNORE`
（主键 `(version_id, task_id)`），每行独立提交：

- **中断**（如生成表格过程中崩溃）：已写入的行保留，作业标记 `failed`；
- **恢复**：`POST /api/jobs/run` 或导出时自动重跑，只补缺失行，重复执行不产生重复；
- **时点正确性**：快照所有字段按 `version.created_at` 回溯（负责人走沿革区间、
  状态走事件流、决议看 `withdrawn_at`），即使恢复发生在改派之后，也不会混入后来的状态。

### 3. 定稿后负责人变更 = 独立变更

- 定稿后正文锁定（保存返回 409）；负责人变更必须走独立接口并携带**变更单号**（否则 422）；
- 变更新增一条沿革区间（`change_type=post_finalize`），旧区间关闭；
- 签收记录绑定旧分派，新分派签收状态从"未签收"重新开始 —— 旧签收不会看似确认新分派；
- `change_token` 幂等，重放安全。

### 4. 截止时点的时区解释

- `date`（仅日期）：存 `due_date + due_tz`，解释为**该时区当日 23:59** 截止；
  逾期判断 = 当前时刻 > 该时区当日结束时刻；
- `datetime`（具体时刻）：存 UTC 时刻 + `due_tz`，按确切时刻判断逾期，展示时换算回 `due_tz`；
- 渲染与导出均显式标注类型与时区，如 `2026-10-10（日期型，Asia/Shanghai 当日 23:59 截止）`。

### 5. 离线并行修改

保存携带 `base_version_no`（乐观并发）：不一致返回 409 并带回当前最新内容，
客户端合并后基于新版本号重试；`save_token` 保证断网重试不产生重复版本。

### 6. 决议撤回

撤回只改决议状态（记录 `withdrawn_at`），**不级联取消**已分派任务；
已撤回决议不能被新待办关联（422）；导出按版本时点标注"已撤回"。

## 页面状态区分

- **会议已定稿**：头部徽章"会议：已定稿（第 N 版）"，正文只读，导出指向定稿版；
- **待办已建立**：每个待办块独立徽章"已建立 T-n / 未建立"，与会议定稿状态相互独立；
- 汇总表另列签收、逾期、状态徽章；定稿后负责人变更需填变更单号。

## 验收标准对照（test/acceptance.test.js）

| 验收 | 测试 |
|---|---|
| 同任务多处引用 | 两处引用同一 token → 单实体、汇总表一行、正文两处渲染 |
| 负责人缺失 | 定稿警告不阻断，导出显示"未指派" |
| 离线并行修改 | 后到保存 409 带回当前内容，基于新版本重试成功 |
| 决议撤回 | 任务保留、新关联 422、导出标注已撤回 |
| 生成表格中断 | 注入失败后快照部分写入，恢复补齐且重跑不重复 |
| 定稿后改负责人 | 无变更单 422；旧签收不确认新分派；导出仍是当时负责人 |
| 删段落不取消待办 | 引用归零、任务保留、汇总表仍列出 |
| 导出还原 | 改派+完成后导出仍显示当时负责人与状态 |
| 幂等 | save_token/定稿/签收/变更重放均不产生重复 |
| 截止时点 | 日期型当日不逾期、时刻型按确切时刻、时区标注 |

## API 摘要

```
POST /api/meetings                       建会
GET  /api/meetings/:id                   会议全量状态（内容/任务/决议/警告/待恢复作业）
POST /api/meetings/:id/versions          保存（base_version_no + save_token）
POST /api/meetings/:id/finalize          定稿（幂等；__test_fail_after 可演练中断）
POST /api/tasks/:id/assignment           负责人变更（定稿后需 ticket；change_token 幂等）
POST /api/tasks/:id/ack                  签收当前分派（幂等）
POST /api/tasks/:id/status               状态变更（open/done/cancelled）
GET  /api/tasks/:id/history              负责人沿革 + 各次签收
POST /api/resolutions/:id/withdraw       撤回决议（幂等，不级联）
POST /api/jobs/run                       恢复待处理作业
GET  /api/meetings/:id/export[.json]     导出正式纪要（定稿快照；?version_no= 可查历史版）
```
