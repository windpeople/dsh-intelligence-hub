# dsh-intelligence-hub

本地情报中枢插件（Host-only + Web 管理页）：采集 RSS / GitHub / arXiv 到本地 SQLite，提供搜索工具、LLM 打分流水线、深度研究、代码研究、学习材料生成与记忆桥接。版本 `0.1.0`，要求 Node ≥ 22，实际使用 `node:sqlite` 内置模块（无需原生依赖）。

## 功能总览（均为真实已实现能力）

- **采集**：RSS / GitHub / arXiv 三类适配器（`lib/adapters/`），URL 归一化去重（`dedup_key` 唯一索引）、语言检测、主题粗分类；每源每次最多 `maxPerRun` 篇。
- **持久任务队列**：`intel_job_executions` 表支撑的 durable 队列，同 kind+runDate 幂等去重、失败指数退避重试（默认 3 次）、心跳 + 超时、进程重启时陈旧 `PROCESSING` 行自动恢复。
- **打分流水线**（`lib/scoring.js`）：L0 确定性过滤 → 事件聚类（同日事件归并、选主文档）→ L1 相关性 / L2 知识增量 / L3 总分（阈值可配）→ Research Gate（DEEP_RESEARCH / WATCHLIST / ARCHIVE 决策）；归档文档约 5% 探索性抽样复审。
- **LLM 内容分析**（可选，`analysisEnabled`）：对每日 Top-N 文档做结构化 JSON 分析；无 provider 时全部走规则路径。
- **日报**：规则版日报每天定时生成，按主题分组高分文档，写入 `intel_reports` 并落盘 `.md`；LLM 可用时生成 LLM 版。
- **覆盖审计**（COVERAGE_AUDIT）：统计 + 盲区检测，落盘审计文件。
- **深度研究**（`intel_research`）：本地 FTS + web 搜索 + 预算限流的全文抓取 → 证据抽取 → 冲突标注 → 报告；每日预算 `researchBudgetPerDay`（默认 3）。
- **代码研究流水线**（默认关闭，`codeResearchEnabled`）：GitHub 白名单 → 浅克隆钉住 ref/commit → 只读代码读取/搜索 → 强制 path:line 证据的结构化报告提交；commit 去重与磁盘 LRU 预算。
- **源发现**（`lib/discovery.js`）：研究/搜索过程中自动发现库外源候选，SSRF 安全检查后进入待审批队列（默认不自动启用）。
- **反馈环**（`lib/feedback.js`）：六类反馈，保守调整源质量分与话题兴趣，全部可追溯（`intel_feedback`，ranking_version v1）。
- **兴趣画像**（`lib/profile.js`）：get / suggest / confirm 三段式，只有显式 confirm 才持久化。
- **学习材料生成**（`lib/learning.js`）：从已完成研究/高分文档生成结构化学习材料，每个结论必须带证据引用；无 LLM 时降级为规则模板并标记 degraded。
- **记忆桥接**（`lib/memoryBridge.js`）：从完成的报告抽取版本化知识事实（`intel_knowledge_facts`），提供只读导出工具；报告完成后自动抽取。
- **Web 管理页**：Client 半部（`client.js`）注册 "Intelligence Hub" 设置页，经 `/intelligence-hub` Connection RPC 只读通道取数；11 个白名单方法，仅 approve/reject 两个写路径；渲染全部 textContent / 白名单 markdown，不可注入。

## 安装

本插件以 DSH bundle 形式安装（包名 `dsh-intelligence-hub`，patch 见 `cordis.patch.yml`）。在 DSH 会话中使用 plugin_manager 工具：

1. `plugin_manager { "action": "list_bundles" }` 在 Official/本地目录中确认 `dsh-intelligence-hub` 与其 `installTarget.spec`。
2. `plugin_manager { "action": "install_bundle", "target": "<spec>" }`。若构建需要跑安装脚本，需你明确批准后把 `pendingBuilds` 名单传入 `approvedBuilds`。
3. 安装后 patch 生效（`cordis.patch.yml` 插入 `id: intel-hub` 插件行，默认 config 见下），日志出现 `intelligence-hub: tools registered` 即成功。
4. 未满足 DSH 版本要求（peerDependencies：cordis ~4.0.5、dsh-tools / dsh-web 0.2.1-rc.5、schemastery ~3.18.5）会阻止安装，不要绕过版本豁免。

## 卸载与数据

- 卸载：`plugin_manager { "action": "remove_bundle", "target": "dsh-intelligence-hub" }`。
- 卸载**不删除数据**。SQLite 库、报告、克隆仓库等保留在 `~/.dsh/plugins-data/dsh-intelligence-hub/`（默认 `intel.db`、`reports/`、`repos/`）。
- 彻底删除：卸载后手动 `rm -rf ~/.dsh/plugins-data/dsh-intelligence-hub/`（若自定义了 `dbPath` / `reportsDir` / `codeResearchReposDir`，删除对应目录）。

## 升级

DSH 目前无独立 upgrade 动作，流程为 remove → install：先 `remove_bundle`，再按上文安装步骤 `install_bundle` 新版本。数据目录不受影响，数据库经 `schema_version` 表做版本化迁移（见 `lib/db.js`）。替换 JS 后需重启进程加载新世代（HMR 仅对 bundle 安装生效）。

## 配置示例

全部 Config 项（`index.js` 中 `export const Config`，schemastery，均为真实名称与默认值）：

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| enabled | boolean | true | 启用插件 |
| dbPath | string | '' | SQLite 路径；空 = `~/.dsh/plugins-data/dsh-intelligence-hub/intel.db` |
| collectEnabled | boolean | true | 启用定时采集任务 |
| collectIntervalHours | number | 6 | DAILY_DISCOVERY 采集最小间隔（小时） |
| maxPerRun | number | 20 | 每源每次最多入库文档数 |
| analysisEnabled | boolean | false | 启用 LLM 内容分析（CONTENT_ANALYSIS） |
| analysisProvider | string | '' | 分析用 LLM provider（与 model 成对） |
| analysisModel | string | '' | 分析用 LLM model（与 provider 成对） |
| analysisMaxDocs | number | 10 | 每日分析的 Top-N 新文档数 |
| reportEnabled | boolean | true | 每日生成规则版日报 |
| reportTime | string | '18:00' | 日报生成时间 HH:mm（reportTimeZone） |
| reportTimeZone | string | 'Asia/Shanghai' | 调度与报告日期的 IANA 时区 |
| reportsDir | string | '' | 日报 .md 目录；空 = `<db 目录>/reports` |
| retentionDays | number | 90 | 非书签文档保留天数，过期清除 |
| maxDiskMb | number | 512 | SQLite 磁盘预算，超出按最旧非书签清除 |
| pipelineEnabled | boolean | true | 启用打分流水线 PIPELINE_RUN |
| pipelineSlots | string | '10:00,12:00' | 每日流水线时段（逗号分隔）；首个时段 L0+聚类，后续 L1-L3+Gate |
| scoreThresholds.archive | number | 50 | 低于该总分 → ARCHIVE |
| scoreThresholds.digest | number | 50 | ≥ 该分 → DIGEST 候选 |
| scoreThresholds.recommend | number | 70 | ≥ 该分 → RECOMMEND |
| scoreThresholds.research | number | 85 | ≥ 该分 → Research Gate 评估 |
| codeResearchEnabled | boolean | **false** | 启用代码研究流水线与相关工具（默认关闭） |
| codeResearchMaxRepoMb | number | 200 | 单仓库克隆大小上限 |
| reposTotalMaxMb | number | 1024 | repos 目录总磁盘预算（LRU 驱逐非 watch 仓库） |
| codeResearchTimeoutMs | number | 300000 | 单次克隆硬超时 |
| extraCloneHosts | string[] | [] | 除 github.com 外额外允许的 git 主机白名单 |
| codeResearchReposDir | string | '' | 仓库目录覆盖；空 = `~/.dsh/plugins-data/dsh-intelligence-hub/repos` |
| researchBudgetPerDay | number | 3 | 每本地日 intel_research 任务上限 |
| coverageEnabled | boolean | true | 启用每日 COVERAGE_AUDIT |
| coverageTime | string | '20:00' | 覆盖审计时间 HH:mm（reportTimeZone） |
| discoveryEnabled | boolean | true | 研究/搜索流中自动发现源候选 |
| maxNewSourcesPerDay | number | 3 | 每日最多记录的新源候选数 |
| autoApproveSources | boolean | false | 自动把候选转为计划源（默认等待显式审批） |

JSON 配置示例（cordis patch 的插件行 config）：

```json
{
  "enabled": true,
  "dbPath": "",
  "collectEnabled": true,
  "collectIntervalHours": 6,
  "maxPerRun": 20,
  "analysisEnabled": false,
  "analysisProvider": "",
  "analysisModel": "",
  "reportTime": "18:00",
  "reportTimeZone": "Asia/Shanghai",
  "pipelineSlots": "10:00,12:00",
  "codeResearchEnabled": false,
  "autoApproveSources": false
}
```

YAML 等价示例（可并入用户层 patch）：

```yaml
- insert:
    - id: intel-hub
      name: dsh-intelligence-hub
      config:
        enabled: true
        collectIntervalHours: 6
        reportTime: "18:00"
        reportTimeZone: Asia/Shanghai
        pipelineSlots: "10:00,12:00"
        scoreThresholds:
          archive: 50
          digest: 50
          recommend: 70
          research: 85
        codeResearchEnabled: false
```

## 工具清单

默认注册 13 个工具（`lib/tools.js` `buildTools`）：

| 工具 | 主要参数 | 说明 |
|---|---|---|
| intel_search | query, limit(10), source_type, time_range | 本地库全文搜索（中文支持） |
| intel_get_document | id*, truncate(2000) | 按 id 取单篇文档含原文 |
| intel_list_sources | source_type, candidates, status, action(approve/reject), candidate_id | 列源/候选；approve/reject 管理候选 |
| intel_collect_now | kind(all), timeout_ms(120000) | 同步触发一次采集 |
| intel_get_status | — | 统计、队列、每源错误、今日新增与去重 |
| intel_get_daily_report | date | 日报 Markdown；无则按需生成规则版 |
| intel_web_search | query*, max_results(8), save_to_db(false) | 实时 web 搜索（需 ctx.web.search provider），可入库 |
| intel_track_topic | action(get/suggest/confirm), patch | 兴趣画像读写（仅 confirm 持久化） |
| intel_submit_feedback | feedback_type*, document_id, related_topic, comment | 六类反馈，幂等可追溯 |
| intel_export_memory_facts | subject, since, include_superseded | 知识事实只读导出 |
| intel_research | topic*, depth(standard), max_sources, time_range | 深度研究任务（每日预算限流） |
| intel_get_research_report | task_id / report_id | 研究/代码任务状态与报告 |
| intel_generate_learning_material | topic / report_id / task_id | 从既有来源生成学习材料（必须带证据） |

**默认关闭**（`codeResearchEnabled=false` 时不注册，5 个）：intel_track_github、intel_analyze_repository、intel_code_read（≤400 行/次，拒绝路径穿越）、intel_code_search（自实现子串/regex 扫描，无 shell）、intel_complete_repository_analysis（强制 path:line 证据校验）。

## 调度时间表（真实实现，时区 = reportTimeZone，默认 Asia/Shanghai）

调度入口为 `ctx.interval` 每 **60 秒**一次 tick（`index.js`），tick 内容：

- **采集**：当天且 `dayNumber % slotDays == 0` 时入队一次 DAILY_DISCOVERY（slotDays = `collectIntervalHours/24` 取整，≥1）；每天另入队 RSS_SYNC / GITHUB_SYNC / PAPER_SYNC 各一次（同一去重键当日幂等）。
- **流水线**：`pipelineSlots`（默认 `10:00,12:00`）——10:00 时段跑 L0 + 事件聚类（phase L0），12:00 时段跑 L1-L3 + Research Gate（phase FULL）；每个时段独立去重键 `日期#槽位`。
- **日报**：`reportTime`（默认 **18:00**）入队 DAILY_REPORT，当日幂等。
- **覆盖审计**：`coverageTime`（默认 **20:00**）入队 COVERAGE_AUDIT，当日幂等。
- **保留清理**：每本地日一次 runRetention（retentionDays 过期 + maxDiskMb 磁盘预算）。
- 任务执行参数：单 tick 最多 10 个任务，单任务硬超时 10 分钟，心跳 15 秒，失败退避基数 60 秒（1x/2x/4x…至 maxAttempts=3）。

## 目录结构

```
dsh-intelligence-hub/
├── index.js            # Host 插件入口：Config、apply、调度 tick、任务 handler
├── client.js           # Web 管理页（Client 半部，settings.section）
├── cordis.patch.yml    # bundle patch（insert intel-hub 插件行 + 默认 config）
├── icon.svg            # 插件图标
├── locale/en.json zh.json
├── lib/
│   ├── db.js           # node:sqlite WAL，20+ 张表，schema_version 迁移
│   ├── normalize.js    # URL 归一化、去重键、语言检测
│   ├── pipeline.js     # collect 采集执行 + 互斥锁 + withTimeout
│   ├── adapters/{rss,github,arxiv}.js
│   ├── scheduler.js    # durable 队列：去重/心跳/退避/重启恢复/本地时区工具
│   ├── analysis.js     # LLM 结构化分析 + extractJson/streamText
│   ├── scoring.js      # L0→聚类→L1-L3→Research Gate（ranking v1）
│   ├── events.js       # 事件聚类、主文档选举
│   ├── report.js       # 日报生成（规则 + 可选 LLM）
│   ├── coverage.js     # 覆盖审计 + 盲区检测
│   ├── retention.js    # 过期与磁盘预算清理
│   ├── research.js     # 深度研究（证据/冲突/预算）
│   ├── codeResearch.js # 代码研究（白名单→克隆→只读读搜→证据报告）
│   ├── learning.js     # 学习材料生成
│   ├── feedback.js     # 反馈环（intel_feedback）
│   ├── profile.js      # 兴趣画像 get/suggest/confirm
│   ├── discovery.js    # 源发现 + SSRF 安全检查 + 审批
│   ├── memoryBridge.js # 知识事实抽取/版本化/只读导出
│   ├── tools.js        # defineTool 工具定义（13+5）
│   └── webapi.js       # /intelligence-hub RPC：11 个白名单方法
├── scripts/            # smoke.js~smoke7.js 真实网络冒烟脚本
└── tests/              # node --test 单测 139 个
```

## 安全边界

- **SSRF 防护**（`lib/discovery.js`）：候选 URL 仅允许 http(s)，拒绝 localhost/.local/0.0.0.0、私有/环回网段、链路本地含云元数据 `169.254.169.254`，且做 DNS 解析后二次校验解析地址；被拒候选终态拒绝。
- **主机白名单**：代码研究仅允许 github.com + `extraCloneHosts` 配置的主机（`parseRepoInput` 硬校验）。
- **不执行第三方代码**：克隆只读；代码搜索为自实现子串/regex 扫描，无 shell、无 git 命令拼接；仓库目录只读访问，路径穿越被拒绝。
- **渲染转义**（`client.js`）：所有不可信库内容经 `textContent` 或白名单 markdown 渲染器（链接仅 http(s)，HTML 转义），单测断言 `<script>` 永不成为元素。
- **RPC 白名单**：Web 端仅 11 个白名单方法，所有入参经类型/长度/枚举/日期格式校验，绝不从客户端字符串拼 SQL；唯一写路径 approve/reject 复用已审计的 discovery 路径。
- **密钥不落码**：LLM / web 搜索凭据由 DSH 能力层（ctx.llm / ctx.web）解析（环境变量或 harness 凭据体系），本插件不读取、不存储、不打印任何密钥。

## 已知限制（真实遗留问题）

1. Web 管理页仅有逻辑与协议层测试（`tests/webclient.test.js`），**未做页面重连实机验证**（见 `docs/WEBUI-VERIFICATION.md`）。
2. `intel_web_search` 依赖已配置的 DSH web 搜索 provider；无 provider 时返回 `WEB_PROVIDER_UNAVAILABLE`，抽样漏检、覆盖审计 web 探测等需要真实 provider 才能端到端验证。
3. 调度简化：`collectIntervalHours > 24` 时按日取整跳日，不做小时内错峰；多进程同时运行同一 db 无文件锁保护。
4. LLM 分析质量依赖 provider/model 配对正确；配置错误时任务以规则回退而非报错，可能掩盖配置问题。
5. 深度研究每日预算为本地日计数，跨时区修改 `reportTimeZone` 会重置预算窗口。
6. 记忆桥接规则路径抽取的事实质量有限（无 LLM 时为模板化增量），需人工 confirm 型工具（如 intel_track_topic）配合收敛。
7. 反馈环 `bad_source` 等调整作用于源质量分，但当前评分主要受画像与阈值影响，反馈影响的传导路径较短。
