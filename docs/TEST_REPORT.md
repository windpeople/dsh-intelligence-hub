# 测试报告 — dsh-intelligence-hub

测试时间：2026-11-05（本机）。命令：`node --test tests/*.test.js`。

## 单元测试汇总（真实输出）

```
ℹ tests 139
ℹ pass 139
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8535.009843
```

## 按文件分布（逐文件 `node --test <file>` 实测计数）

| 测试文件 | 用例数 | 覆盖内容 |
|---|---|---|
| tests/adapters.test.js | 9 | RSS/GitHub/arXiv 适配与解析 |
| tests/analysis.test.js | 6 | LLM 结构化分析、extractJson、缺省回退 |
| tests/codeResearch.test.js | 11 | 白名单、克隆状态机、code read/search、证据报告校验 |
| tests/coverage.test.js | 3 | 覆盖审计统计与盲区 |
| tests/db.test.js | 5 | 建库、去重索引、检索、统计 |
| tests/discovery.test.js | 8 | 源发现、SSRF 检查、审批流 |
| tests/events.test.js | 7 | 事件聚类、主文档选举 |
| tests/feedback.test.js | 8 | 六类反馈、幂等、质量调整、追溯 |
| tests/learning.test.js | 5 | 学习材料证据校验、降级模板 |
| tests/memoryBridge.test.js | 7 | 事实抽取、版本取代、只读导出 |
| tests/migration.test.js | 2 | schema_version 迁移 |
| tests/normalize.test.js | 8 | URL 归一化、去重键、语言检测 |
| tests/phase5tools.test.js | 6 | 代码研究工具（默认关闭门控）行为 |
| tests/pipeline.test.js | 4 | collect 执行、互斥锁、超时 |
| tests/profile.test.js | 7 | 画像 get/suggest/confirm 语义 |
| tests/report.test.js | 7 | 日报分组、落盘、按需生成 |
| tests/research.test.js | 6 | 深度研究任务、预算、去重 |
| tests/scheduler.test.js | 8 | 队列去重/退避/恢复/时段解析 |
| tests/scoring.test.js | 10 | L0-L3、阈值边界、Gate、抽样、幂等 |
| tests/tools.test.js | 4 | intel_search / get_document / status / daily_report 工具 |
| tests/webclient.test.js | 8 | markdown 转义、RPC 白名单、approve/reject 唯一写 |
| **合计** | **139** | 全部通过 |

## 冒烟脚本（真实网络/真库，手工运行：`node scripts/smoke*.js`）

| 脚本 | 用途 | 最近一次结果要点（据脚本文档与代码注释） |
|---|---|---|
| scripts/smoke.js | 阶段一：真网采集 hnrss.org + arXiv 入临时库并回查 | 采集-入库-搜索链路打通；documents=0 时以非零码失败 |
| scripts/smoke3.js | 阶段三：真实 SQLite 上 RSS_SYNC 过 durable 队列；真实 ctx.llm（zai-coding-cn / glm-5.3-flash）分析 1 篇并手写 schema 校验 | 同日重复入队被去重；结构化 JSON 校验通过 |
| scripts/smoke4.js | 阶段四：真库（`INTEL_DB` 或默认路径）上完整 PIPELINE_RUN，打印逐篇得分、Gate 决策、事件簇与推荐理由 | L0 槽位重复入队被幂等拒绝；无 LLM 时灰区文档回退规则分 |
| scripts/smoke5.js | 代码研究端到端：真实克隆 lukeed/klona（钉住 commit）→ 读 2 个真实源文件 → 提交带 path:line 证据的结构化报告 | 证据校验通过、报告持久化并回显真实摘录 |
| scripts/smoke6.js | 真库副本上重构版日报 + 真实 intel_research（depth=quick，本地 FTS 证据；web 不可用时非致命 web_error） | 任务终态 COMPLETED、报告文件落盘；web 路径降级符合预期 |
| scripts/smoke7.js | 真库上 COVERAGE_AUDIT + 源发现（真实探测 github.blog）+ 记忆桥接（规则路径抽取-取代-导出） | 审计落盘；候选未被自动启用（autoApproveSources=false）；事实版本化正常 |

> 冒烟脚本依赖真实网络与真实凭据，本次未重跑；表中要点依据脚本头部注释与实现代码核对。本地单测为本轮真实重跑结果。

## 遗留问题汇总

1. **Web UI 实机验证未完成**：逻辑/协议层有 tests/webclient.test.js 覆盖，但浏览器页面重连验证待做（清单见 docs/WEBUI-VERIFICATION.md）。
2. **真实 web provider 依赖**：intel_web_search、深度研究 web 证据、覆盖审计 web 探测在无 provider 环境只能验证降级路径。
3. **多进程并发**：同一 db 文件无跨进程文件锁，调度幂等仅靠 SQLite 行级去重。
4. **采样漏检常态化验证**：~5% 归档抽样有单测比例断言，真实分布效果需长期数据复查。
5. `index.js` 引用了未在 Config schema 中声明的 `config.codeResearchTestHosts`（仅测试场景用，生产配置不生效）——见 docs/ACCEPTANCE.md 之外的实施备注。
