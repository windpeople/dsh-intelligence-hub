# Web UI 页面重连验证清单 — dsh-intelligence-hub

背景：Web 管理页（`client.js`，Intelligence Hub 设置页）通过 Connection RPC 通道 `/intelligence-hub` 从 Host 取数。`tests/webclient.test.js` 已覆盖协议与渲染逻辑，但以下 6 项需要在**真实 DSH Web GUI 页面**上重连实机验证。前提：`plugin_manager` 已安装并启用 dsh-intelligence-hub，Host 日志出现 `intelligence-hub: web rpc channel /intelligence-hub registered`；库内有少量真实文档。

## 1. 页面注册与首屏加载

- 步骤：刷新 Web GUI → 打开 Settings → 找到 "Intelligence Hub"（Intelligence Hub / 情报中枢）分区页。
- 预期：页面渲染 Dashboard（文档总数、今日新增、Sources OK、任务队列、最新日报卡片）；中/英文随界面语言切换（locale/en.json、locale/zh.json）。

## 2. RPC 通道握手与 getStatus 数据

- 步骤：页面打开后观察 Network/连接日志中 `/intelligence-hub` 通道的 `getStatus` 调用。
- 预期：返回 `{ ok: true, value }` 包络；`documents / sourcesTotal / sourcesOk / todayAdded / byType / queue / latestReport` 与 `intel_get_status` 工具输出一致；`serverTime` 为 Host 当前时间。

## 3. 断线重连后数据自动恢复

- 步骤：页面保持打开，重启 DSH Host 进程（或触发 Client 重连），随后在页面点 Refresh。
- 预期：通道重建后各页签（Dashboard / Sources / Search / Reports / Settings）重新拉数成功，无残留错误提示；Host 重启时调度恢复日志出现 `recovered N stale job(s)` 不影响页面。

## 4. approve/reject 写路径端到端

- 步骤：先用 `intel_web_search`（save_to_db=true）或研究流程产生若干源候选；页面打开 Sources → 候选列表 → 对一个候选执行 Approve，另一个执行 Reject。
- 预期：操作后 `intel_list_sources { candidates: true }` 状态变为 approved/rejected；approved 候选进入采集源列表；UI 刷新反映变化。此二者是 Web 端唯一写路径。

## 5. 不可信内容渲染转义

- 步骤：向库内插入一条标题/摘要含 `<script>alert(1)</script>` 与 `[x](javascript:alert(1))` 的测试文档（SQL 或临时源），页面 Search 中检索并查看详情，再打开一篇含链接/代码块的日报。
- 预期：脚本内容以纯文本显示、不执行（对应单测 "markdown renderer escapes HTML"）；`javascript:` 链接不被渲染为可点链接（白名单仅 http(s)）；验证后删除测试文档。

## 6. 无 connection 服务时的降级运行

- 步骤：禁用/移除 Web carrier（或在没有 Web 界面的 headless profile 中启动插件），观察 Host 日志与工具可用性。
- 预期：日志不出现 rpc 注册行，但采集/调度/工具全部正常（`ctx.inject(['connection'], ...)` 仅可选挂载）；重新启用 Web carrier 后（HMR 或重启）通道恢复注册，页面可用。

## 记录

| # | 验证项 | 结果 | 日期 |
|---|---|---|---|
| 1 | 页面注册与首屏 | 待验证 | — |
| 2 | getStatus 握手 | 待验证 | — |
| 3 | 断线重连恢复 | 待验证 | — |
| 4 | approve/reject 端到端 | 待验证 | — |
| 5 | 渲染转义实机 | 待验证 | — |
| 6 | 无 Web 降级 | 待验证 | — |
