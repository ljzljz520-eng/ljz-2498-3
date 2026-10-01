# 会议纪要编辑器

议题与待办由 Vue 页面输入；业务接口维护「决议↔任务」引用与负责人分派；
SQLite 持久化**会议版本、负责人沿革、截止时点、定稿快照**；渲染服务从不可变快照生成正式纪要。

## 运行

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # 15 项验收测试（node:test）
```

数据库默认在 `data/minutes.db`（可用 `MINUTES_DB` 覆盖、`PORT` 改端口）。前端免构建（Vue3 本地 vendor）。

## 需求 → 实现 对照

| 需求 | 落地方式 |
| --- | --- |
| 正文待办与汇总表来自**同一任务实体** | 只有一张 `tasks` 表；正文 `todo` 块存 `task_id`、决议用 `decision_task_refs`、汇总表渲染同一行。`GET /tasks/references` 统计多处引用 |
| 议题/待办由页面输入 | `web/app.js` 块编辑 → `POST /meetings/:id/edit`（带 `base_rev`） |
| 业务接口维护决议引用与任务分派 | `decisions` 服务负责 link/unlink/withdraw；`tasks/:tid/assignee`、`/acknowledge` 独立通道 |
| **编辑即建 vs 定稿一次生成** | 编辑期任务 `status=provisional`（已可分派/引用，正文与汇总同源）；定稿事务内幂等转为 `established`。两者不是两套数据，只是同一实体的两个生命周期态 |
| 幂等关联 | 任务 ID 由客户端生成并保持稳定（`PUT /tasks/:id` 重放 `created=false`）；定稿带 `idempotency_key`（同键重放返回同一快照、不二次转换）；渲染带 `client_token` |
| 部分失败恢复 | `PUT /tasks` 批量按条独立落库，返回 `succeeded/failed`，坏条目不拖垮好条目；定稿各步幂等可重放；渲染分阶段检查点 |
| 删段落不自动取消已分派事项 | 块为软删除（`block_history` 留痕），与 `tasks` 无级联；任务只随显式 `/status` 变更 |
| 定稿后改负责人需独立变更 | 正文定稿即冻结（再编辑返回 409）；`POST /tasks/:tid/assignee` 追加一行不可变沿革，并留 `owner_change` 版本 |
| 不让旧签收看似确认新分派 | 签收绑定 `assignment_id`。新分派追加后旧行 `superseded_at` 置位；`acknowledged` 按当前分派计算；对旧 assignment 补签收返回 409 |
| 仅日期 vs 具体时刻 + 时区 | `due_kind=date`：`due_date=YYYY-MM-DD`，按会议时区解释为日历日，**不做 UTC 换算**；`due_kind=datetime`：墙上时间+IANA 时区归一化为 `due_at_utc`（DST 安全），导出还原并同时展示 UTC |
| 离线并行修改 | 编辑带 `base_rev`，服务端做**块级 + 字段级三路合并**：不同块/不同字段自动合，同字段分叉返回 409（含 base/head/client 三值），页面可拉新基线变基重放 |
| 决议撤回 | 仅标记 `decisions.status=withdrawn`、引用 `dropped_at`（行保留可追溯），不取消任务；定稿后撤回生成 `amendment` 快照与新版本 |
| 生成表格中断 | 渲染五阶段（collect/assemble/render_todo_table/render_decisions/finalize_doc），每阶段产物落 `checkpoints_json`；中断后同 `client_token` 从断点续跑，已完成阶段不重算。可用 `POST /api/_test/fail-next-render` 注故障 |
| 页面区分「会议已定稿」与「待办已建立」 | 会议徽标取 `meetings.status`（draft/finalized/amended），任务徽标取 `tasks.status`（provisional/established/cancelled/done），两者独立 |
| 导出还原当时负责人、不混入后来状态 | 快照 `snapshots.snapshot_json` 自包含（块/任务含当时负责人与沿革签收/决议）；`GET /export?snapshot_id=` 只从快照渲染，不读活数据 |

## 目录

```
server/src/
  db/schema.sql            # 全部表结构
  services/
    meetings.js            # 会议、版本链、三路合并
    tasks.js               # 统一任务实体、负责人沿革、签收、批量部分失败
    decisions.js           # 决议、引用维护、撤回（修正案）
    snapshots.js           # 自包含快照、幂等定稿
    renderer.js            # 分阶段检查点渲染、断点续跑、导出
    deadline.js            # 仅日期/带时区时刻的语义
  routes 由 app.js 统一装配；server.js 启动
web/                       # Vue3 页面（免构建）
test/acceptance.test.js    # 15 个验收场景
```
