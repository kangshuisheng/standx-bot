# 做市策略改进开发文档

目的：提升 StandX Maker Points 获取效率与安全性，降低撤单频次与空窗期风险，修复 token/session 到期导致无法撤单的高危问题。同时实现 5 天 TG 提醒以便手动刷新 session（Token-only 场景）。

## 概览（变更要点）
- 从「每周期全撤单」改为「按目标对账（reconciliation）+ 每区间每方向只保留一单」。
- 增强撤单 / API 请求可靠性：重试/指数回退、撤单后确认状态。
- 增加 Watchdog：检测 API / 授权异常，发送 TG 告警并可使用紧急私钥尝试撤单。
- 增加 5 天一次的 Telegram 提醒服务（一次性）用于提醒刷新 session。
- 增加监控脚本 `scripts/monitor-uptime.js` 用于采样 both-sides-in-10bps 的 uptime。

## 主要修改文件
- 改动
  - `src/strategies/market-maker.ts`：实现 reconciliation，确保每启用的 tier 只下 1 买 + 1 卖；只取消不匹配的订单；添加 fallback tight pair 以确保存在 10 bps 内的双边。 (see code comments)
  - `src/services/standx-api.ts`：重写 `sendRequest`（重试 + backoff + re-auth），增强 `cancelOrder`（重试 + 验证）与 `cancelAllOrders`（批量撤销后确认）。
  - `src/config/index.ts`：调整默认 `ORDERS_TIER2/3=1`，并新增配置：`CANCEL_RETRY_COUNT`, `CANCEL_RETRY_BACKOFF_MS`, `SESSION_REMINDER_DAYS`, `SESSION_REMINDER_REPEAT`, `SESSION_REMINDER_CHECK_INTERVAL_MS`, `WATCHDOG_INTERVAL_MS`, `EMERGENCY_WALLET_PRIVATE_KEY` 等。
  - `src/index.ts`：启动 `session-reminder`（依赖 `sendTelegramMessage` 回调）并启动 Watchdog（检测授权失败/ API 错误并发送 TG 告警，若配置紧急私钥则执行 emergency cancel）。
  - 新增：`src/services/session-reminder.ts`（负责持久化 `.bot_state.json`，并在运行达 5 天时发送 TG 提醒）。
  - 新增：`scripts/monitor-uptime.js`（采样 API，计算 both-sides-within-10bps 样本）。

## 设计细节 & 行为说明
- 单区间一单：对于每个已启用的 tier（Tier1, Tier2, Tier3），生成一对订单（buy/sell），价格使用该 tier 的边缘值（接近档位边界，减少被吃的概率）。
- 对账逻辑：
  - 获取当前 open orders。
  - 对于每个 open order，若在某一目标订单（同 side）价格阈值（1 bps）内，则视为已满足；否则尝试取消（重试 + backoff）。
  - 对于未满足的目标，提交下单。提交完成后再次验证至少存在 1 对在 10 bps 内；若没有，则提交一对 fallback（±9 bps）以保证 Maker Points 条件。
- 撤单可靠性：`cancelOrder` 支持多次重试并在提供 symbol 时验证订单是否真的消失；`cancelAllOrders` 批量撤单后也会确认结果并在必要时重试。
- 授权失败处理：当 `sendRequest` 遇到 401：
  - 若配置并传入 `WALLET_PRIVATE_KEY`：尝试自动 re-auth，重试请求；
  - 若为 token-only（无私钥）：抛出明确错误，由 Watchdog 捕获并触发 TG 告警，提示手动刷新 ACCESS_TOKEN（此时若配置 `EMERGENCY_WALLET_PRIVATE_KEY`，系统会使用该私钥尝试 emergency cancel）。

## 配置项（新增）
- `SESSION_REMINDER_DAYS` (default 5) - 运行达到 N 天向 TG 发送提醒一次。
- `SESSION_REMINDER_REPEAT` (default false) - 是否重复发送提醒。
- `SESSION_REMINDER_CHECK_INTERVAL_MS` (default 3600000) - 检查间隔。
- `CANCEL_RETRY_COUNT` / `CANCEL_RETRY_BACKOFF_MS` / `CANCEL_RETRY_MAX_BACKOFF_MS` - 撤单与请求重试参数。
- `WATCHDOG_INTERVAL_MS` (default 60000) - Watchdog 检测间隔。
- `EMERGENCY_WALLET_PRIVATE_KEY` (optional) - 紧急私钥，用于 Watchdog 在授权失效时尝试撤单（仅在极端情况下使用）。

## 验证 & 测试计划
- 单元测试：模拟 API 返回 401、超时与部分撤销成功的场景，断言 `sendRequest`、`cancelOrder`/`cancelAllOrders` 的重试行为与错误上报。
- 集成测试：使用 mock server 模拟授权过期后恢复、网络抖动，验证 Watchdog 报警与 emergency cancel 流程。
- 手动验证：
  - 将 `SESSION_REMINDER_DAYS` 临时设为 0，确认在启动后短时间内收到 TG 提醒且 `.bot_state.json` 被更新。
  - 运行 `scripts/monitor-uptime.js`，采样 1 小时并计算 both-sides-within-10bps 比例（目标 ≥50%，优先实现 ≥70%）。

## 风险与回退
- 如果 emergency private key 被错误配置，会触发紧急撤单；务必妥善保管。
- 先做小规模验证（在测试对或小仓位上）以观察现实网络/API 行为再全量运行。

---

若你确认文档，我可以继续准备对应的 PR（包含单元测试样例与变更说明）。若需要我现在开始提交 PR，我会把变动拆为 3 个提交：1) 配置 + API 可靠性改动 2) 市场制造策略改动（reconciliation）3) session reminder + watchdog + 监控脚本。