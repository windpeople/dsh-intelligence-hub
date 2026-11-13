# 验收清单 — dsh-intelligence-hub

对照 16 条最终验收标准逐条核对真实实现。证据引用真实测试文件（`node --test` 全绿，139/139，2026-11-05 本机实测）与冒烟脚本。状态：✅ 满足 / ⚠️ 部分满足或待验证。

| # | 验收标准 | 实现方式 | 验证证据 | 状态 |
|---|---|---|---|---|
| 1 | RSS/GitHub/arXiv 三类源采集入库，去重不重复入库 | `lib/adapters/*` + `lib/pipeline.js` collect；`dedup_key` 唯一索引；maxPerRun 限流 | tests/adapters.test.js（9）、tests/normalize.test.js（8）、tests/db.test.js（5）；scripts/smoke.js 真网采集 | ✅ |
| 2 | URL 归一化与语言/主题识别 | `lib/normalize.js`：canonicalUrl、dedupKeyFor、detectLang | tests/normalize.test.js（8） | ✅ |
| 3 | 持久任务队列：幂等、重试、超时、重启恢复 | `lib/scheduler.js`：kind+runDate 去重、指数退避、心跳、recoverStaleJobs | tests/scheduler.test.js（8）、tests/migration.test.js（2）；scripts/smoke3.js 队列实跑 | ✅ |
| 4 | 定时调度：采集间隔、日报、审计、流水线时段 | `index.js` 60s tick + enqueueScheduledDaily / enqueuePipelineRun（本地时区） | tests/scheduler.test.js；index.js 调度逻辑代码审读 | ✅ |
| 5 | LLM 内容分析可选启用，结构化输出校验 | `lib/analysis.js` runContentAnalysis + extractJson；provider/model 成对配置，缺省跳过 | tests/analysis.test.js（6）；scripts/smoke3.js 真实 llm.stream 分析 1 篇 | ✅ |
| 6 | 打分流水线 L0→L1→L2→L3，阈值可配且幂等 | `lib/scoring.js` runPipeline；resolveThresholds 回退默认；同日重跑不重复计分 | tests/scoring.test.js（10）含阈值边界与幂等用例；scripts/smoke4.js 真库全流程 | ✅ |
| 7 | 事件聚类与主文档选举 | `lib/events.js` assignDocumentToEvent / electPrimaryDocument | tests/events.test.js（7） | ✅ |
| 8 | Research Gate 决策（研究/观察/归档）与探索性抽样 | `lib/scoring.js` Gate 三分支；归档文档 ~5% 抽样复审 | tests/scoring.test.js：Gate 分支 + 抽样比例用例 | ✅ |
| 9 | 每日规则版日报（+可选 LLM 版），落盘可查 | `lib/report.js` generateDailyReport；intel_reports 表 + .md 文件 | tests/report.test.js（7）；scripts/smoke6.js 真库复刻日报并断言文件落盘 | ✅ |
| 10 | 深度研究：本地+web 证据、冲突标注、每日预算 | `lib/research.js`；researchBudgetPerDay 限流、同题去重 | tests/research.test.js（6）；smoke6.js web 不可用时降级为 web_error 非致命——**完整 web 路径待真实 provider 端到端验证** | ⚠️ 部分（web provider 依赖） |
| 11 | 代码研究流水线：白名单→克隆→读搜→证据报告，默认关闭 | `lib/codeResearch.js` + 5 个 codeResearchEnabled 门控工具；commit 去重、磁盘预算 | tests/codeResearch.test.js（11）、tests/phase5tools.test.js（6）；scripts/smoke5.js 真实克隆 lukeed/klona 全流程 | ✅ |
| 12 | 学习材料生成必须带证据，无 LLM 降级可用 | `lib/learning.js`；证据 id / path:line 强校验；degraded 标记 | tests/learning.test.js（5） | ✅ |
| 13 | 源发现 + SSRF 防护 + 显式审批 | `lib/discovery.js`：http(s) 白名单、私网/元数据 IP/DNS 复查；autoApproveSources=false | tests/discovery.test.js（8）；scripts/smoke7.js github.blog 探测产生候选且不自动启用 | ✅ |
| 14 | 反馈环保守可追溯；画像 confirm 才持久化 | `lib/feedback.js`（intel_feedback 轨迹，ranking v1）+ `lib/profile.js` 三段式 | tests/feedback.test.js（8）、tests/profile.test.js（7） | ✅ |
| 15 | 记忆桥接：事实版本化 + 只读导出，报告完成自动抽取 | `lib/memoryBridge.js` extractAndStoreFacts / exportFacts；index.js CODE_RESEARCH / RESEARCH_TASK 完成钩子 | tests/memoryBridge.test.js（7）；smoke7.js 抽取-取代-导出实跑 | ✅ |
| 16 | Web 管理页：只读 RPC 白名单、approve/reject 唯一写、渲染防注入 | `lib/webapi.js`（11 方法白名单 + 参数校验）+ `client.js`（textContent/白名单 markdown） | tests/webclient.test.js（8）含 `<script>` 转义与拒绝未知方法断言；**页面重连实机验证待做**（见 docs/WEBUI-VERIFICATION.md） | ⚠️ 待验证（实机） |

## 汇总

- 14 条 ✅，2 条 ⚠️（#10 抽样漏检/深研究 web 路径需真实 web provider；#16 Web UI 待页面重连实机验证）。
- 全部单测：`node --test tests/*.test.js` → 139 pass / 0 fail（本机 2026-11-05 实测，duration ≈ 8.5s）。
- 抽样漏检类验收依赖真实数据分布，冒烟脚本（smoke4/smoke6）已在真库上跑过一轮，但常态化验证需接入真实 web 搜索 provider 后复查。
