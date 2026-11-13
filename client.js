/**
 * dsh-intelligence-hub — browser half (Web management UI, V2.0 phase 3).
 *
 * Registers an independent main panel (Intelligence Hub) with a sidebar
 * launcher icon in the DSH Web UI. Plain JS + DOM inside a single React host
 * element; no framework UI code, no CDN, no direct database access. All data
 * arrives through the `/api/intelligence-hub` Fetch route served by the Host
 * half. Every rendered string goes through textContent / a whitelist markdown
 * renderer, so untrusted library content can never inject markup.
 *
 * Eight in-panel pages: 工作台 / 情报收件箱 / 专题研究 / 知识库 / 研究报告 /
 * 数据来源 / 采集任务 / 设置. Kept as a single file because the module loader
 * contract (`window.__ModuleLoader__.load`) registers exactly one factory.
 */
window.__ModuleLoader__.load({
  id: 'dsh-intelligence-hub',
  factory(require) {
    const React = require('react');

    const NS = 'intelligenceHub.web';
    const CHANNEL = '/api/intelligence-hub';
    const SOURCE_TYPES = ['rss', 'github', 'arxiv'];
    const REPORT_KINDS = ['daily', 'weekly', 'coverage', 'research', 'learning'];
    const JOB_STATUS_LEVEL = { PENDING: 'off', PROCESSING: 'warn', COMPLETED: 'ok', FAILED: 'bad' };
    const CHANGE_KIND_LEVEL = {
      known: 'ok', supplement: 'ok', new: 'warn', conflict: 'bad', major_change: 'bad', rollback: 'off',
    };
    /** The eight pages, in display order (asserted by tests). */
    const NAV_PAGES = [
      ['workbench', 'navWorkbench'],
      ['inbox', 'navInbox'],
      ['topics', 'navTopics'],
      ['knowledge', 'navKnowledge'],
      ['reports', 'navReports'],
      ['sources', 'navSources'],
      ['jobs', 'navJobs'],
      ['settings', 'navSettings'],
    ];

    // ---------------------------------------------------------------------------
    // Locale dictionaries (en / zh), served through the Client locale service.
    // ---------------------------------------------------------------------------
    const zh = {
      title: '情报中枢',
      navWorkbench: '工作台', navInbox: '情报收件箱', navTopics: '专题研究', navKnowledge: '知识库',
      navReports: '研究报告', navSources: '数据来源', navJobs: '采集任务', navSettings: '设置',
      refresh: '刷新', loading: '加载中…', retry: '重试', empty: '暂无内容。',
      errorPrefix: '请求失败', welcome: '欢迎回来，情报中枢已就绪。',
      todayAdded: '今日新增', eventsToday: '事件聚合', pendingVerify: '待验证', topicUpdates: '专题更新',
      topPicks: '今日重点', topPicksEmpty: '今天还没有评分结果，等评分管线跑完再来看。',
      picksFallbackHint: '（今天管线尚未运行，展示历史最高分）',
      bookmark: '收藏', bookmarked: '已收藏', ignore: '忽略', ignored: '已忽略',
      deepResearch: '交给大肥鱼研究', researching: '已递交大肥鱼', researchQueued: '已递交大肥鱼，它将在对话中处理',
      actionFail: '操作失败',
      topicsNow: '正在研究的专题', knowledgeItems: '知识条目', doneResearch: '已完成研究', lastUpdate: '最近更新',
      bigFish: '大肥鱼状态', running: '运行中', recentDone: '最近完成', watching: '待处理',
      sourceHealth: '来源健康', trend7: '采集趋势（近 7 天）', weeklyHint: '周报',
      linkedSources: '关联来源', score: '评分',
      inboxTitle: '情报收件箱', filterType: '类型', filterTopic: '专题', filterScore: '最低分',
      filterDecision: '决策', filterBookmark: '收藏', onlyBookmarked: '仅收藏', sortLabel: '排序',
      sortFetched: '最新入库', sortScore: '评分最高', rangeAll: '全部', rangeDay: '24 小时',
      rangeWeek: '7 天', rangeMonth: '30 天', searchPlaceholder: '搜索标题 / 摘要 / 全文',
      searchButton: '搜索', resultsCount: '共 {n} 条', noResults: '没有匹配结果。',
      selectAll: '全选', batchBookmark: '批量收藏', batchIgnore: '批量忽略', selected: '已选 {n} 项',
      pagePrev: '上一页', pageNext: '下一页',
      refreshTopic: '刷新专题', refreshing: '刷新中…', refreshDone: '检查 {e} 篇，写入 {w} 条',
      sections: '知识分组', revisions: '修订历史', noRevisions: '还没有修订记录。',
      backToList: '← 返回专题列表',
      knowledgeTitle: '知识库', knowledgeSearch: '搜索知识条目', evidence: '证据',
      rollback: '回滚', rollbackConfirm: '确认回滚这条修订？将恢复变更前内容并留痕。',
      rollbackDone: '已回滚',
      reportsList: '报告列表', reportFor: '报告', noReports: '还没有报告。日报每天自动生成。',
      groupDaily: '日报', groupWeekly: '周报', groupCoverage: '覆盖审计', groupResearch: '研究', groupLearning: '学习',
      sourcesOn: '已收录来源', name: '名称', type: '类型', url: '链接', state: '状态',
      lastOk: '最近成功', lastError: '最近错误', candidates: '发现的候选来源', candidateFilter: '显示',
      all: '全部', candidate: '待定', approved: '已批准', rejected: '已拒绝', approve: '批准', reject: '拒绝',
      addSource: '新增来源', addSourceBtn: '添加', addSourceHint: 'URL 会先经过 SSRF 安全检查（仅 http/https、非内网地址）。',
      enable: '启用', disable: '停用', sourceAdded: '已添加来源', sourceAddDup: '来源已存在',
      jobsTitle: '采集任务历史', triggerCollect: '手动采集', collecting: '采集中…',
      collectDone: '抓取 {f} 篇，入库 {i} 篇，{e} 个错误', collectQueued: '已加入采集队列',
      retry: '重试', retryDone: '已重新排队', jobsKind: '任务', jobsStatus: '状态', jobsDate: '执行日',
      jobsTime: '更新时间', jobsAttempts: '次数', statusOk: '正常', statusDegraded: '异常',
      statusFailed: '失败', statusOff: '停用', external: '打开原文',
      settingsNote: '本页面为只读。请通过 DSH Config 机制（cordis.patch.yml / 插件设置）修改配置，此处仅展示当前生效值。',
      configKey: '键', configValue: '值', settingsTitle: '当前生效配置',
      connected: '已连接', lastRefresh: '自动刷新于 {m}', refreshNow: '手动刷新',
      justNow: '刚刚', minAgo: '{n} 分钟前', hourAgo: '{n} 小时前', dayAgo: '{n} 天前',
      noReports2: '还没有报告。', queueEmpty: '近期没有任务。',
      fetchedAt: '入库', publishedAt: '发布',
      cfgEnabled: '插件总开关。', cfgCollectEnabled: '是否启用定时采集任务。',
      cfgCollectIntervalHours: '两次采集之间的最小间隔（小时）。',
      cfgMaxPerRun: '每次采集每个来源最多入库条数。',
      cfgAnalysisEnabled: '是否启用 LLM 内容分析（关闭时走规则路径）。',
      cfgAnalysisProvider: 'LLM 提供方（与模型配对）。', cfgAnalysisModel: 'LLM 模型名。',
      cfgAnalysisMaxDocs: '每天最多做 LLM 分析的新文档数。',
      cfgReportEnabled: '是否每天自动生成日报。', cfgReportTime: '日报生成时刻（HH:mm）。',
      cfgReportTimeZone: '报告时区（IANA）。', cfgReportsDir: '报告 .md 输出目录。',
      cfgRetentionDays: '非收藏文档保留天数。', cfgMaxDiskMb: 'SQLite 磁盘预算（MB）。',
      cfgPipelineEnabled: '是否启用评分管线（L0-L3 + 研究门控）。',
      cfgPipelineSlots: '评分管线每日槽位（HH:mm 逗号分隔）。',
      cfgScoreThresholds: 'L3 阈值：archive/digest/recommend/research。',
      cfgCodeResearchEnabled: '是否启用代码研究管线。',
      cfgResearchBudgetPerDay: '每天最多创建的深度研究任务数。',
      cfgCoverageEnabled: '是否每日运行覆盖审计。', cfgCoverageTime: '覆盖审计时刻。',
      cfgDiscoveryEnabled: '是否自动发现候选来源。', cfgMaxNewSourcesPerDay: '每天最多记录的新候选来源数。',
      cfgAutoApproveSources: '是否自动批准候选来源（默认需人工批准）。',
      cfgTokenBudgetPerDay: '每日 LLM 字符预算，0 为不限。',
      cfgWeeklyReportEnabled: '是否每周一生成周报。', cfgWeeklyReportTime: '周报生成时刻。',
      cfgStarSnapshotsEnabled: '是否记录 GitHub star 快照。',
      cfgDbPath: 'SQLite 文件路径。', cfgReposDir: '代码研究仓库目录。',
      cfgExtraCloneHosts: '除 github.com 外允许的克隆主机。',
    };
    const en = {
      title: 'Intelligence Hub',
      navWorkbench: 'Workbench', navInbox: 'Inbox', navTopics: 'Topics', navKnowledge: 'Knowledge',
      navReports: 'Reports', navSources: 'Sources', navJobs: 'Jobs', navSettings: 'Settings',
      refresh: 'Refresh', loading: 'Loading…', retry: 'Retry', empty: 'Nothing here yet.',
      errorPrefix: 'Request failed', welcome: 'Welcome back. The hub is running.',
      todayAdded: 'Added today', eventsToday: 'Events', pendingVerify: 'Unverified', topicUpdates: 'Topic updates',
      topPicks: 'Top picks today', topPicksEmpty: 'No scored documents yet. Check back after the pipeline runs.',
      picksFallbackHint: '(pipeline has not run today; showing historical best)',
      bookmark: 'Bookmark', bookmarked: 'Bookmarked', ignore: 'Ignore', ignored: 'Ignored',
      deepResearch: 'Research', researching: 'Researching', researchQueued: 'Research task created',
      actionFail: 'Action failed',
      topicsNow: 'Topics in research', knowledgeItems: 'knowledge', doneResearch: 'completed research', lastUpdate: 'updated',
      bigFish: 'Big fish status', running: 'Running', recentDone: 'Recently done', watching: 'Watching',
      sourceHealth: 'Source health', trend7: 'Collection trend (7d)', weeklyHint: 'Weekly',
      linkedSources: 'sources', score: 'Score',
      inboxTitle: 'Inbox', filterType: 'Type', filterTopic: 'Topic', filterScore: 'Min score',
      filterDecision: 'Decision', filterBookmark: 'Bookmark', onlyBookmarked: 'Bookmarked only', sortLabel: 'Sort',
      sortFetched: 'Newest', sortScore: 'Best score', rangeAll: 'All time', rangeDay: '24 hours',
      rangeWeek: '7 days', rangeMonth: '30 days', searchPlaceholder: 'Search title / summary / full text',
      searchButton: 'Search', resultsCount: '{n} item(s)', noResults: 'No matches.',
      selectAll: 'Select all', batchBookmark: 'Bookmark', batchIgnore: 'Ignore', selected: '{n} selected',
      pagePrev: 'Prev', pageNext: 'Next',
      refreshTopic: 'Refresh topic', refreshing: 'Refreshing…', refreshDone: 'checked {e}, wrote {w}',
      sections: 'Knowledge', revisions: 'Revisions', noRevisions: 'No revisions yet.',
      backToList: '← Back to topics',
      knowledgeTitle: 'Knowledge', knowledgeSearch: 'Search knowledge', evidence: 'Evidence',
      rollback: 'Roll back', rollbackConfirm: 'Roll back this revision? Previous content will be restored (audited).',
      rollbackDone: 'Rolled back',
      reportsList: 'Reports', reportFor: 'Report', noReports: 'No reports yet.',
      groupDaily: 'Daily', groupWeekly: 'Weekly', groupCoverage: 'Coverage', groupResearch: 'Research', groupLearning: 'Learning',
      sourcesOn: 'Sources', name: 'Name', type: 'Type', url: 'URL', state: 'Status',
      lastOk: 'Last success', lastError: 'Last error', candidates: 'Discovered candidates', candidateFilter: 'Show',
      all: 'All', candidate: 'Pending', approved: 'Approved', rejected: 'Rejected', approve: 'Approve', reject: 'Reject',
      addSource: 'Add source', addSourceBtn: 'Add', addSourceHint: 'URLs pass an SSRF safety check (http/https only, no private hosts).',
      enable: 'Enable', disable: 'Disable', sourceAdded: 'Source added', sourceAddDup: 'Source already exists',
      jobsTitle: 'Job history', triggerCollect: 'Collect now', collecting: 'Collecting…',
      collectDone: 'fetched {f}, inserted {i}, {e} error(s)', collectQueued: 'Queued a collection run',
      retry: 'Retry', retryDone: 'Re-queued', jobsKind: 'Kind', jobsStatus: 'Status', jobsDate: 'Run date',
      jobsTime: 'Updated', jobsAttempts: 'Tries', statusOk: 'OK', statusDegraded: 'Degraded',
      statusFailed: 'Failing', statusOff: 'Disabled', external: 'Open source page',
      settingsNote: 'This page is read-only. Change configuration through the DSH Config mechanism; this panel only shows effective values.',
      configKey: 'Key', configValue: 'Value', settingsTitle: 'Effective configuration',
      connected: 'Connected', lastRefresh: 'Auto-refreshed {m}', refreshNow: 'Refresh now',
      justNow: 'just now', minAgo: '{n} min ago', hourAgo: '{n} h ago', dayAgo: '{n} d ago',
      noReports2: 'No reports yet.', queueEmpty: 'No recent jobs.',
      fetchedAt: 'Fetched', publishedAt: 'Published',
      cfgEnabled: 'Plugin master switch.', cfgCollectEnabled: 'Enable scheduled collection jobs.',
      cfgCollectIntervalHours: 'Minimum hours between collection runs.',
      cfgMaxPerRun: 'Max documents per source per run.',
      cfgAnalysisEnabled: 'Enable LLM content analysis (off = rule paths).',
      cfgAnalysisProvider: 'LLM provider.', cfgAnalysisModel: 'LLM model.',
      cfgAnalysisMaxDocs: 'Max LLM-analyzed docs per day.',
      cfgReportEnabled: 'Generate a daily report.', cfgReportTime: 'Daily report time (HH:mm).',
      cfgReportTimeZone: 'Report time zone (IANA).', cfgReportsDir: 'Report .md output dir.',
      cfgRetentionDays: 'Retention days for non-bookmarked docs.', cfgMaxDiskMb: 'SQLite disk budget (MB).',
      cfgPipelineEnabled: 'Enable the scoring pipeline (L0-L3 + gate).',
      cfgPipelineSlots: 'Daily pipeline slots (HH:mm, comma separated).',
      cfgScoreThresholds: 'L3 thresholds: archive/digest/recommend/research.',
      cfgCodeResearchEnabled: 'Enable the code research pipeline.',
      cfgResearchBudgetPerDay: 'Max deep research tasks per day.',
      cfgCoverageEnabled: 'Run the daily coverage audit.', cfgCoverageTime: 'Coverage audit time.',
      cfgDiscoveryEnabled: 'Auto-discover source candidates.', cfgMaxNewSourcesPerDay: 'Max new candidates per day.',
      cfgAutoApproveSources: 'Auto-approve candidates (default: manual).',
      cfgTokenBudgetPerDay: 'Daily LLM char budget; 0 = unlimited.',
      cfgWeeklyReportEnabled: 'Generate a weekly report on Mondays.', cfgWeeklyReportTime: 'Weekly report time.',
      cfgStarSnapshotsEnabled: 'Record daily GitHub star snapshots.',
      cfgDbPath: 'SQLite file path.', cfgReposDir: 'Code research repos dir.',
      cfgExtraCloneHosts: 'Extra git hosts allowed besides github.com.',
    };

    // ---------------------------------------------------------------------------
    // Small DOM helpers (XSS-safe by construction: textContent only).
    // ---------------------------------------------------------------------------
    function el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = String(v);
        else if (k === 'text') node.textContent = String(v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'href' || k === 'src') {
          // Whitelist: only http(s) URLs ever become attributes.
          const s = String(v);
          if (/^https?:\/\//i.test(s)) node.setAttribute(k, s);
        } else node.setAttribute(k, String(v));
      }
      for (const c of children.flat()) {
        if (c === undefined || c === null || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
      return node;
    }

    function fmtTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString();
    }

    /** Relative time ("3 小时前"); never shows a bare ISO string in lists. */
    function relTime(iso, t) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
      if (mins < 1) return t('justNow');
      if (mins < 60) return t('minAgo').replace('{n}', String(mins));
      const hours = Math.floor(mins / 60);
      if (hours < 24) return t('hourAgo').replace('{n}', String(hours));
      return t('dayAgo').replace('{n}', String(Math.floor(hours / 24)));
    }

    /** Strip markdown inline tokens for one-line plain-text display. */
    function stripInline(text) {
      return String(text)
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
        .replace(/^#+\s*/, '')
        .trim();
    }

    /** Sparkline geometry (pure): 7 points mapped into a width×height box. */
    function sparkPoints(trend, width = 220, height = 48) {
      const vals = (trend || []).map((p) => Number(p.count) || 0);
      if (!vals.length) return '';
      const max = Math.max(1, ...vals);
      const step = vals.length > 1 ? width / (vals.length - 1) : width;
      return vals.map((v, i) => `${Math.round(i * step)},${Math.round(height - 4 - (v / max) * (height - 10))}`).join(' ');
    }

    /** Loading skeleton: three pulse blocks. */
    function skeleton() {
      return el('div', { class: 'ihub-skel' },
        el('div', { class: 'ihub-skel-block', style: 'height:88px' }),
        el('div', { class: 'ihub-skel-row' }),
        el('div', { class: 'ihub-skel-row', style: 'width:70%' }),
      );
    }

    /** Empty state: one sentence + suggested action. */
    function emptyState(message, actionLabel, onAction) {
      const box = el('div', { class: 'ihub-empty' }, el('div', { text: message }));
      if (actionLabel && onAction) {
        box.append(el('button', { class: 'ihub-btn', onclick: onAction }, actionLabel));
      }
      return box;
    }

    // ---------------------------------------------------------------------------
    // Restricted markdown renderer. Builds DOM directly; text always via
    // textContent; only http(s) links become anchors. No innerHTML anywhere.
    // ---------------------------------------------------------------------------
    function renderInline(parent, text) {
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"')\]]+)/g;
      let last = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
        const tok = m[0];
        if (tok.startsWith('`')) {
          parent.append(el('code', { class: 'ihub-code' }, tok.slice(1, -1)));
        } else if (tok.startsWith('**')) {
          parent.append(el('strong', {}, tok.slice(2, -2)));
        } else if (tok.startsWith('[')) {
          const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
          if (mm && /^https?:\/\//i.test(mm[2])) {
            parent.append(el('a', { class: 'ihub-link', href: mm[2], target: '_blank', rel: 'noopener noreferrer' }, mm[1]));
          } else {
            parent.append(document.createTextNode(tok));
          }
        } else {
          parent.append(el('a', { class: 'ihub-link', href: tok, target: '_blank', rel: 'noopener noreferrer' }, tok));
        }
        last = m.index + tok.length;
      }
      if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
    }

    function markdownToDom(md) {
      const root = el('div', { class: 'ihub-md' });
      const lines = String(md || '').split(/\r?\n/);
      let i = 0;
      let list = null; // current ul/ol node
      const closeList = () => { list = null; };
      while (i < lines.length) {
        const line = lines[i];
        if (/^```/.test(line)) {
          closeList();
          const buf = [];
          i += 1;
          while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
          i += 1; // closing fence
          root.append(el('pre', { class: 'ihub-pre' }, el('code', {}, buf.join('\n'))));
          continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
          closeList();
          root.append(el(`h${h[1].length}`, {}, h[2]));
          i += 1;
          continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          closeList();
          root.append(el('hr', {}));
          i += 1;
          continue;
        }
        const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (li) {
          const ordered = /^\s*\d/.test(line);
          if (!list || list._ordered !== ordered) {
            list = el(ordered ? 'ol' : 'ul', {});
            list._ordered = ordered;
            root.append(list);
          }
          const item = el('li', {});
          renderInline(item, li[1]);
          list.append(item);
          i += 1;
          continue;
        }
        const bq = /^\s*>\s?(.*)$/.exec(line);
        if (bq) {
          closeList();
          root.append(el('blockquote', {}, bq[1]));
          i += 1;
          continue;
        }
        if (line.trim() === '') { closeList(); i += 1; continue; }
        closeList();
        const p = el('p', {});
        renderInline(p, line.trim());
        root.append(p);
        i += 1;
      }
      return root;
    }

    /** Extract the first `### ` sections (title + one-line reason) from report markdown. */
    function topPicksFromMarkdown(md, max = 3) {
      const picks = [];
      const lines = String(md || '').split(/\r?\n/);
      for (let i = 0; i < lines.length && picks.length < max; i += 1) {
        const h = /^###\s+(.*)$/.exec(lines[i]);
        if (!h) continue;
        const title = stripInline(h[1]);
        let reason = '';
        for (let j = i + 1; j < lines.length; j += 1) {
          const l = lines[j];
          if (/^#{1,6}\s/.test(l)) break;
          if (l.trim() === '') continue;
          reason = stripInline(l).slice(0, 160);
          break;
        }
        picks.push({ title, reason });
      }
      return picks;
    }

    // ---------------------------------------------------------------------------
    // Styles — Linear-flavoured, theme-token only (--dsw-alias-*).
    // ---------------------------------------------------------------------------
    const STYLE_TEXT = `.ihub { font-size: 13px; color: var(--dsw-alias-label-primary); line-height: 1.55; max-width: 1160px; }
.ihub * { box-sizing: border-box; }
.ihub a { text-decoration: none; }

/* ---- nav: segmented pills ---- */
.ihub-tabs { display: flex; gap: 4px; padding: 3px; margin-bottom: 16px; flex-wrap: wrap;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; width: fit-content; }
.ihub-tab { appearance: none; background: none; border: none; cursor: pointer; font: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-secondary); padding: 5px 14px; border-radius: 7px; transition: all .15s ease; }
.ihub-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.ihub-tab[data-active="true"] { color: var(--dsw-alias-label-primary); font-weight: 600;
  background: var(--dsw-alias-interactive-bg-hover-solid); box-shadow: 0 1px 2px rgba(0,0,0,.06); }

.ihub-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.ihub-header h1 { font-size: 16px; font-weight: 700; margin: 0; letter-spacing: -.01em; }
.ihub-refresh { margin-left: auto; display: flex; gap: 8px; align-items: center;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; }

/* ---- hero greeting ---- */
.ihub-welcome { margin: 2px 0 14px; }
.ihub-welcome .ihub-welcome-title { font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.ihub-welcome .ihub-welcome-title b, .ihub-welcome .ihub-welcome-title strong { color: var(--dsw-alias-brand-primary); }

/* ---- stat cards ---- */
.ihub-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px; }
.ihub-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-1); transition: border-color .15s ease, transform .15s ease; }
.ihub-card:hover { border-color: var(--dsw-alias-border-l3); transform: translateY(-1px); }
.ihub-card .ihub-num { font-size: 26px; font-weight: 700; line-height: 1.15; letter-spacing: -.02em; }
.ihub-card .ihub-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-top: 3px; }

/* ---- hero picks ---- */
.ihub-hero { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px;
  background: var(--dsw-alias-bg-layer-1); }
.ihub-hero h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
  display: flex; align-items: center; gap: 6px; }
.ihub-hero h2::before { content: ''; width: 3px; height: 13px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.ihub-pick { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.ihub-pick:first-of-type { border-top: none; padding-top: 4px; }
.ihub-pick-title { font-weight: 600; font-size: 13.5px; }
.ihub-pick-reason { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 3px; line-height: 1.55; }

/* ---- layout ---- */
.ihub-cols { display: grid; grid-template-columns: minmax(0, 7fr) minmax(260px, 3fr); gap: 16px; align-items: start; }
.ihub-panel { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px 16px; margin-bottom: 14px;
  background: var(--dsw-alias-bg-layer-1); }
.ihub-panel h3 { margin: 0 0 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; }

/* ---- table ---- */
.ihub-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ihub-table th { text-align: left; color: var(--dsw-alias-label-tertiary); font-weight: 500; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.ihub-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.ihub-table tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }

/* ---- status dot & pill ---- */
.ihub-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor, transparent 80%); }
.ihub-dot[data-level="ok"] { background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.ihub-dot[data-level="warn"] { background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.ihub-dot[data-level="bad"] { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.ihub-dot[data-level="off"] { background: var(--dsw-alias-label-dimmed); color: var(--dsw-alias-label-dimmed); }
.ihub-url { color: var(--dsw-alias-link); word-break: break-all; }
.ihub-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); white-space: nowrap;
  background: var(--dsw-alias-bg-base); }

/* ---- buttons ---- */
.ihub-btn { appearance: none; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; padding: 5px 12px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); transition: all .15s ease; }
.ihub-btn:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.ihub-btn[data-kind="primary"] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent; box-shadow: 0 1px 3px color-mix(in srgb, var(--dsw-alias-button-primary-fill), transparent 60%); }
.ihub-btn[data-kind="primary"]:hover { filter: brightness(1.08); }
.ihub-btn[data-kind="danger"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary), transparent 60%); }
.ihub-btn:disabled { opacity: .45; cursor: default; }

.ihub-err { color: var(--dsw-alias-state-error-primary); padding: 8px 0; }
.ihub-muted { color: var(--dsw-alias-label-tertiary); }
.ihub-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* ---- inputs ---- */
.ihub-input, .ihub-select { font: inherit; font-size: 12.5px; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  min-width: 0; transition: border-color .15s ease, box-shadow .15s ease; }
.ihub-input:focus, .ihub-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary), transparent 85%); }
.ihub-search { flex: 1 1 220px; }

/* ---- result & detail cards ---- */
.ihub-result { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px;
  background: var(--dsw-alias-bg-layer-1); transition: border-color .15s ease; }
.ihub-result:hover { border-color: var(--dsw-alias-border-l3); }
.ihub-result .ihub-res-title { font-weight: 600; }
.ihub-badges { display: flex; gap: 5px; flex-wrap: wrap; }
.ihub-detail { margin-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; color: var(--dsw-alias-label-secondary); }
.ihub-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

/* ---- topic cards ---- */
.ihub-topics { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.ihub-topic-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); transition: all .15s ease; }
.ihub-topic-card:hover { border-color: var(--dsw-alias-brand-primary); transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,.07); }
.ihub-topic-card h4 { margin: 0 0 5px; font-size: 13.5px; font-weight: 600; }
.ihub-topic-card .ihub-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-top: 8px; }

/* ---- knowledge ---- */
.ihub-ksection h4 { margin: 14px 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); font-weight: 600; }
.ihub-kitem { border-left: 2px solid var(--dsw-alias-border-l3); padding: 6px 12px; margin-bottom: 10px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-radius: 0 8px 8px 0; }

/* ---- revisions ---- */
.ihub-revline { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.ihub-revline:first-of-type { border-top: none; }

/* ---- reports ---- */
.ihub-reports { display: grid; grid-template-columns: 250px 1fr; gap: 16px; }
.ihub-reports-list { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 10px;
  background: var(--dsw-alias-bg-layer-1); align-self: start; max-height: 600px; overflow-y: auto; }
.ihub-reports-list h4 { margin: 10px 6px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; }
.ihub-rep-item { display: block; width: 100%; text-align: left; appearance: none; background: none; border: none;
  font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-secondary); cursor: pointer;
  padding: 6px 10px; border-radius: 8px; transition: all .12s ease; }
.ihub-rep-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ihub-rep-item[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); font-weight: 600; }
.ihub-reader { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 22px 26px;
  background: var(--dsw-alias-bg-layer-1); }
.ihub-md { max-width: 720px; line-height: 1.75; }
.ihub-md h1, .ihub-md h2, .ihub-md h3, .ihub-md h4 { margin: 18px 0 8px; line-height: 1.4; letter-spacing: -.01em; }
.ihub-md h1 { font-size: 19px; } .ihub-md h2 { font-size: 16px; } .ihub-md h3 { font-size: 14px; } .ihub-md h4 { font-size: 13px; }
.ihub-md h1:first-child, .ihub-md h2:first-child, .ihub-md h3:first-child { margin-top: 0; }
.ihub-md p { margin: 8px 0; }
.ihub-md ul, .ihub-md ol { margin: 8px 0; padding-left: 20px; }
.ihub-md li { margin: 3px 0; }
.ihub-md blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border-radius: 0 8px 8px 0; }
.ihub-pre { background: var(--dsw-alias-markdown-code-block); border-radius: 8px; padding: 12px 14px;
  overflow-x: auto; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.6; }
.ihub-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--dsw-alias-markdown-code-block); border-radius: 4px; padding: 1px 5px; }
.ihub-link { color: var(--dsw-alias-link); }
.ihub-link:hover { text-decoration: underline; }
.ihub-kv { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ihub-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-bottom: 12px; }

/* ---- empty state ---- */
.ihub-empty { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 12px; padding: 28px;
  text-align: center; color: var(--dsw-alias-label-tertiary); margin: 8px 0; background: var(--dsw-alias-bg-base); }
.ihub-empty .ihub-btn { margin-top: 12px; }

/* ---- job lines ---- */
.ihub-jobline { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12.5px; cursor: default; }
.ihub-jobline .ihub-job-kind { min-width: 140px; font-weight: 500; }
.ihub-jobline .ihub-job-time { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.ihub-joberr { color: var(--dsw-alias-state-error-primary); font-size: 11px; padding: 2px 0 8px 24px; word-break: break-all; }

/* ---- skeleton ---- */
.ihub-skel { padding: 4px 0; }
.ihub-skel-block { border-radius: 12px; background: var(--dsw-alias-bg-skeleton); margin-bottom: 10px;
  animation: ihubPulse 1.4s ease-in-out infinite; }
.ihub-skel-row { height: 14px; border-radius: 6px; background: var(--dsw-alias-bg-skeleton); margin-bottom: 8px;
  animation: ihubPulse 1.4s ease-in-out infinite; }
@keyframes ihubPulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }

@media (max-width: 900px) { .ihub-cols, .ihub-reports { grid-template-columns: 1fr; } }
`;

    // ---------------------------------------------------------------------------
    // App shell: page nav + header + view container, all imperative DOM.
    // ---------------------------------------------------------------------------
    const FALLBACK_VARS = [
      ['--dsw-alias-bg-base', '#ffffff'], ['--dsw-alias-bg-layer-1', '#f7f8fa'], ['--dsw-alias-bg-skeleton', '#eceef1'],
      ['--dsw-alias-border-l1', '#e5e7eb'], ['--dsw-alias-border-l2', '#d9dce1'], ['--dsw-alias-border-l3', '#c8ccd2'],
      ['--dsw-alias-brand-primary', '#3b82f6'], ['--dsw-alias-button-primary-fill', '#3b82f6'],
      ['--dsw-alias-interactive-bg-hover', 'rgba(0,0,0,0.05)'], ['--dsw-alias-interactive-bg-hover-solid', '#e8eaee'],
      ['--dsw-alias-label-primary', '#1f2328'], ['--dsw-alias-label-primary-foreground', '#ffffff'],
      ['--dsw-alias-label-secondary', '#57606a'], ['--dsw-alias-label-tertiary', '#8b949e'], ['--dsw-alias-label-dimmed', '#afb8c1'],
      ['--dsw-alias-link', '#2563eb'], ['--dsw-alias-markdown-code-block', '#f6f8fa'],
      ['--dsw-alias-state-error-primary', '#dc2626'], ['--dsw-alias-state-success-primary', '#16a34a'], ['--dsw-alias-state-warn-primary', '#d97706'],
    ].map(([k, v]) => `${k}: var(${k}, ${v});`).join(' ');

    const EXTRA_STYLE = `
.ihub-card { box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.ihub-pill { font-weight: 500; }
.ihub-pill[data-kind="rss"], .ihub-pill[data-kind="github"], .ihub-pill[data-kind="arxiv"] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary), transparent 88%);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary), transparent 55%);
  color: var(--dsw-alias-brand-primary); }
.ihub-pill[data-decision="RESEARCH"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary), transparent 85%);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary), transparent 50%);
  color: var(--dsw-alias-state-success-primary); font-weight: 600; }
.ihub-pill[data-decision="RECOMMEND"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary), transparent 85%);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary), transparent 50%);
  color: var(--dsw-alias-brand-primary); font-weight: 600; }
.ihub-pill[data-decision="DIGEST"] { border-color: var(--dsw-alias-border-l3); }
.ihub-pick-title a, .ihub-res-title a { color: var(--dsw-alias-label-primary); }
.ihub-pick-title a:hover { color: var(--dsw-alias-brand-primary); }
.ihub-tab { font-size: 13px; padding: 6px 16px; }
.ihub-tab[data-active="true"] { color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary), transparent 90%); }
.ihub-welcome-title { font-size: 20px !important; }
.ihub-num { color: var(--dsw-alias-brand-primary); }
.ihub-reader, .ihub-panel, .ihub-hero, .ihub-result, .ihub-topic-card { box-shadow: 0 1px 3px rgba(0,0,0,.06); }
`;

    // Guaranteed-visibility fallback: critical styles applied as inline style
    // attributes after every render, so the panel keeps its look even if every
    // stylesheet channel (adopted/<style>) fails or gets wiped.
    const INLINE_CRITICAL = {
      'ihub': 'font-size:13px;line-height:1.55;max-width:1160px;',
      'ihub-tabs': 'display:flex;gap:4px;padding:3px;margin-bottom:16px;flex-wrap:wrap;background:#f7f8fa;border:1px solid #d9dce1;border-radius:10px;width:fit-content;',
      'ihub-tab': 'appearance:none;background:none;border:none;cursor:pointer;font:inherit;font-size:12.5px;color:#57606a;padding:5px 14px;border-radius:7px;',
      'ihub-header': 'display:flex;align-items:center;gap:8px;margin-bottom:12px;',
      'ihub-refresh': 'margin-left:auto;display:flex;gap:8px;align-items:center;color:#8b949e;font-size:11px;',
      'ihub-welcome': 'margin:2px 0 14px;',
      'ihub-cards': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px;',
      'ihub-card': 'border:1px solid #d9dce1;border-radius:12px;padding:14px 16px;background:#fff;',
      'ihub-num': 'font-size:26px;font-weight:700;line-height:1.15;color:#3b82f6;',
      'ihub-label': 'color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-top:3px;',
      'ihub-hero': 'border:1px solid #d9dce1;border-radius:12px;padding:16px 18px;margin-bottom:16px;background:#fff;',
      'ihub-pick': 'display:flex;gap:12px;padding:12px 0;border-top:1px solid #e5e7eb;',
      'ihub-pick-title': 'font-weight:600;font-size:13.5px;',
      'ihub-pick-reason': 'color:#57606a;font-size:12px;margin-top:3px;',
      'ihub-cols': 'display:grid;grid-template-columns:minmax(0,7fr) minmax(260px,3fr);gap:16px;align-items:start;',
      'ihub-panel': 'border:1px solid #d9dce1;border-radius:12px;padding:12px 16px;margin-bottom:14px;background:#fff;',
      'ihub-table': 'width:100%;border-collapse:collapse;font-size:12.5px;',
      'ihub-dot': 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;',
      'ihub-pill': 'display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;border:1px solid #c8ccd2;color:#57606a;white-space:nowrap;background:#fff;',
      'ihub-btn': 'appearance:none;font:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:5px 12px;border-radius:8px;border:1px solid #d9dce1;background:#fff;color:#1f2328;',
      'ihub-err': 'color:#dc2626;padding:8px 0;',
      'ihub-muted': 'color:#8b949e;',
      'ihub-row': 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;',
      'ihub-input': 'font:inherit;font-size:12.5px;padding:6px 10px;border-radius:8px;border:1px solid #d9dce1;background:#fff;color:#1f2328;',
      'ihub-select': 'font:inherit;font-size:12.5px;padding:6px 10px;border-radius:8px;border:1px solid #d9dce1;background:#fff;color:#1f2328;',
      'ihub-search': 'flex:1 1 220px;',
      'ihub-result': 'border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin-bottom:10px;background:#fff;',
      'ihub-badges': 'display:flex;gap:5px;flex-wrap:wrap;',
      'ihub-actions': 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;',
      'ihub-topics': 'display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;',
      'ihub-topic-card': 'border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;cursor:pointer;background:#fff;',
      'ihub-reports': 'display:grid;grid-template-columns:250px 1fr;gap:16px;',
      'ihub-reports-list': 'border:1px solid #d9dce1;border-radius:12px;padding:10px;background:#fff;align-self:start;max-height:600px;overflow-y:auto;',
      'ihub-rep-item': 'display:block;width:100%;text-align:left;appearance:none;background:none;border:none;font:inherit;font-size:12.5px;color:#57606a;cursor:pointer;padding:6px 10px;border-radius:8px;',
      'ihub-reader': 'border:1px solid #d9dce1;border-radius:12px;padding:22px 26px;background:#fff;',
      'ihub-md': 'max-width:720px;line-height:1.75;',
      'ihub-empty': 'border:1px dashed #c8ccd2;border-radius:12px;padding:28px;text-align:center;color:#8b949e;margin:8px 0;background:#fafbfc;',
      'ihub-jobline': 'display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;',
      'ihub-job-kind': 'min-width:140px;font-weight:500;',
      'ihub-job-time': 'margin-left:auto;color:#8b949e;font-size:11px;',
      'ihub-joberr': 'color:#dc2626;font-size:11px;padding:2px 0 8px 24px;word-break:break-all;',
    };

    function inlineTheme(scope) {
      try {
        scope.querySelectorAll('[class]').forEach((elm) => {
          let extra = '';
          for (const c of elm.classList) {
            const st = INLINE_CRITICAL[c];
            if (st) extra += st;
          }
          if (extra) {
            const prev = elm.getAttribute('style');
            elm.setAttribute('style', prev ? `${prev};${extra}` : extra);
          }
        });
        scope.querySelectorAll('h1').forEach((h) => { h.style.fontSize = '16px'; h.style.fontWeight = '700'; h.style.margin = '0'; });
        scope.querySelectorAll('h2,h3').forEach((h) => { h.style.fontSize = '13px'; h.style.fontWeight = '600'; h.style.margin = '0 0 10px'; h.style.color = '#1f2328'; });
        scope.querySelectorAll('h4').forEach((h) => { h.style.fontSize = '11px'; h.style.fontWeight = '600'; h.style.margin = '10px 4px 4px'; h.style.color = '#8b949e'; });
        scope.querySelectorAll('.ihub-dot[data-level="ok"]').forEach((d) => { d.style.background = '#16a34a'; });
        scope.querySelectorAll('.ihub-dot[data-level="warn"]').forEach((d) => { d.style.background = '#d97706'; });
        scope.querySelectorAll('.ihub-dot[data-level="bad"]').forEach((d) => { d.style.background = '#dc2626'; });
        scope.querySelectorAll('.ihub-tab[data-active="true"]').forEach((t) => { t.style.background = '#e8f0fe'; t.style.color = '#2563eb'; t.style.fontWeight = '600'; });
        scope.querySelectorAll('.ihub-btn[data-kind="primary"]').forEach((b) => { b.style.background = '#3b82f6'; b.style.color = '#fff'; b.style.borderColor = 'transparent'; });
      } catch { /* cosmetic only */ }
    }

    function ensureStyles(node) {
      if (typeof document === 'undefined') return;
      const root = (node && node.getRootNode && node.getRootNode()) || document;
      const styleIn = (scope) => {
        try { return scope && (scope.getElementById ? scope.getElementById('ihub-style') : scope.querySelector('style#ihub-style')); } catch { return null; }
      };
      if (styleIn(root) || styleIn(document)) return;
      const css = `.ihub { ${FALLBACK_VARS} }\n${STYLE_TEXT}\n${EXTRA_STYLE}`;
      // Channel 1: constructable stylesheet (works in Shadow DOM and under strict CSP).
      try {
        if (typeof CSSStyleSheet !== 'undefined' && root && 'adoptedStyleSheets' in root) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          root.adoptedStyleSheets = [...(root.adoptedStyleSheets || []), sheet];
        }
      } catch { /* fall through */ }
      // Channel 2: classic <style> element as well (belt and braces across hosts).
      if (typeof document !== 'undefined' && !document.getElementById('ihub-style')) {
        const st = document.createElement('style');
        st.id = 'ihub-style';
        st.textContent = css;
        document.head.appendChild(st);
      }
    }

    function createApp({ t, call, onDispose }) {
      let root = null;
      let disposed = false;
      let activeTab = 'workbench';
      let refreshTimer = 0;
      let lastRefreshAt = 0;
      const controllers = new Set();
      const pageState = {}; // per-page persistent state (filters, selections)

      function request(endpoint, payload) {
        const ctrl = new AbortController();
        controllers.add(ctrl);
        const done = () => controllers.delete(ctrl);
        return call(endpoint, payload, ctrl.signal).finally(done);
      }

      const views = {};
      function registerView(name, render) { views[name] = render; }

      function renderHeader() {
        const mins = lastRefreshAt ? Math.max(0, Math.round((Date.now() - lastRefreshAt) / 60000)) : null;
        const label = mins === null ? '' : t('lastRefresh').replace('{m}', mins < 1 ? t('justNow') : t('minAgo').replace('{n}', String(mins)));
        return el('div', { class: 'ihub-header' },
          el('h1', {}, t('title')),
          el('div', { class: 'ihub-refresh' },
            el('span', { text: label }),
            el('button', { class: 'ihub-btn', onclick: () => render() }, t('refreshNow')),
          ));
      }

      function render() {
        if (!root || disposed) return;
        lastRefreshAt = Date.now();
        root.textContent = '';
        root.append(renderHeader());
        const tabs = el('div', { class: 'ihub-tabs', role: 'tablist' });
        for (const [key, labelKey] of NAV_PAGES) {
          tabs.append(el('button', {
            class: 'ihub-tab', role: 'tab', 'data-active': String(activeTab === key),
            'aria-selected': String(activeTab === key),
            onclick: () => { activeTab = key; render(); },
          }, t(labelKey)));
        }
        const pane = el('div', { class: 'ihub-pane' });
        root.append(tabs, pane);
        (views[activeTab] || views.workbench)(pane, render);
        if (typeof inlineTheme === 'function') inlineTheme(root);
      }

      function start(node) {
        ensureStyles(node);
        root = node;
        refreshTimer = setInterval(() => { if (activeTab === 'workbench') render(); }, 60000);
        render();
      }

      /** Switch to a page programmatically (e.g. "open latest report"). */
      function show(tab) {
        activeTab = tab;
        render();
      }

      function stop() {
        disposed = true;
        if (refreshTimer) clearInterval(refreshTimer);
        for (const c of controllers) c.abort();
        controllers.clear();
        if (onDispose) onDispose();
      }

      return { start, stop, request, registerView, render, show, t, pageState };
    }

    // ---------------------------------------------------------------------------
    // Shared view pieces.
    // ---------------------------------------------------------------------------
    function installViews(app) {
      const { request, t, pageState } = app;

      function showError(pane, e) {
        pane.textContent = '';
        const msg = e && e.message ? e.message : String(e);
        pane.append(
          el('div', { class: 'ihub-err' }, `${t('errorPrefix')}: ${msg}`),
          el('button', { class: 'ihub-btn', onclick: () => app.render() }, t('retry')),
        );
      }

      function section(parent, title) {
        const p = el('div', { class: 'ihub-panel' }, el('h3', {}, title));
        parent.append(p);
        return p;
      }

      function pill(label) { return el('span', { class: 'ihub-pill' }, label); }

      function badgeOf(doc) {
        return pill(doc.source_type || '—');
      }

      function topicBadge(doc) {
        return doc.topic && doc.topic !== 'general' ? pill(doc.topic) : null;
      }

      function openButton(doc) {
        const open = el('button', { class: 'ihub-btn' }, t('external'));
        if (/^https?:\/\//i.test(String(doc.url || ''))) {
          open.addEventListener('click', () => window.open(doc.url, '_blank', 'noopener'));
        } else open.disabled = true;
        return open;
      }

      function metaLine(doc) {
        const parts = [`${t('fetchedAt')} ${relTime(doc.fetched_at, t)}`];
        if (doc.published_at) parts.push(`${t('publishedAt')} ${relTime(doc.published_at, t)}`);
        if (doc.source_count !== undefined) parts.push(`${t('linkedSources')} ${doc.source_count}`);
        if (doc.score !== undefined && doc.score !== null) parts.push(`${t('score')} ${Math.round(doc.score)}`);
        return el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:2px' }, parts.join(' · '));
      }

      /** Action buttons for a scored doc: bookmark / ignore / deep research. */
      function pickActions(doc, onChanged) {
        const box = el('div', { class: 'ihub-actions' });
        const bm = el('button', { class: 'ihub-btn' }, t('bookmark'));
        const ig = el('button', { class: 'ihub-btn' }, t('ignore'));
        const dr = el('button', { class: 'ihub-btn' }, t('deepResearch'));
        const done = (btn, label) => { btn.textContent = label; btn.disabled = true; };
        bm.addEventListener('click', () => {
          bm.disabled = true;
          request('markItems', { items: [{ document_id: doc.id }], bookmark: true })
            .then(() => { done(bm, t('bookmarked')); if (onChanged) onChanged(); })
            .catch(() => { done(bm, t('actionFail')); });
        });
        ig.addEventListener('click', () => {
          ig.disabled = true;
          request('markItems', { items: [{ document_id: doc.id, feedback_type: 'irrelevant' }] })
            .then(() => { done(ig, t('ignored')); if (onChanged) onChanged(); })
            .catch(() => { done(ig, t('actionFail')); });
        });
        dr.addEventListener('click', () => {
          dr.disabled = true; dr.textContent = t('researching');
          const topic = doc.topic && doc.topic !== 'general' ? doc.topic : String(doc.title || '').slice(0, 60);
          request('researchTrigger', { topic, document_id: doc.id, title: doc.title })
            .then((res) => { done(dr, (res && res.message) ? res.message : t('researchQueued')); })
            .catch(() => { done(dr, t('actionFail')); });
        });
        box.append(bm, ig, dr);
        return box;
      }

      /** Compact doc card used by the inbox; checkbox managed by caller. */
      function inboxCard(doc, checkbox, onChanged) {
        const item = el('div', { class: 'ihub-result' });
        const row = el('div', { class: 'ihub-row' }, checkbox,
          el('div', { class: 'ihub-res-title', text: doc.title || doc.url }),
          el('div', { class: 'ihub-badges' }, badgeOf(doc), topicBadge(doc),
            doc.decision ? pill(doc.decision) : null, doc.bookmark ? pill('★') : null),
          openButton(doc));
        item.append(row, metaLine(doc));
        if (doc.summary) item.append(el('div', { class: 'ihub-muted', style: 'font-size:12px; margin-top:4px' }, String(doc.summary).slice(0, 140)));
        item.append(pickActions(doc, onChanged));
        return item;
      }

      function jobLine(j, failed, onToggle) {
        const line = el('div', { class: 'ihub-jobline' });
        line.append(
          el('span', { class: 'ihub-dot', 'data-level': failed ? 'bad' : 'ok', title: j.status || '' }),
          el('span', { class: 'ihub-job-kind', text: j.repo || j.topic || j.kind }),
          el('span', { class: 'ihub-job-time', text: relTime(j.updated_at || j.completed_at || j.finished_at, t) }),
        );
        if (failed && j.error) {
          line.addEventListener('click', () => onToggle(line, j.error));
          line.setAttribute('title', t('lastError'));
        }
        return line;
      }

      function sparkSvg(trend) {
        const NS_SVG = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS_SVG, 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '56');
        svg.setAttribute('viewBox', '0 0 220 56');
        svg.setAttribute('preserveAspectRatio', 'none');
        const points = sparkPoints(trend, 220, 56);
        if (points) {
          const poly = document.createElementNS(NS_SVG, 'polyline');
          poly.setAttribute('points', points);
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', 'var(--dsw-alias-brand-primary)');
          poly.setAttribute('stroke-width', '1.6');
          svg.append(poly);
        }
        const labels = el('div', { class: 'ihub-muted', style: 'font-size:10px; display:flex; justify-content:space-between' },
          (trend || []).map((p) => el('span', { text: String(p.date || '').slice(5) })));
        const wrap = el('div', {});
        wrap.append(svg, labels);
        return wrap;
      }

      // --- 工作台 (Workbench) ---------------------------------------------------
      app.registerView('workbench', (pane) => {
        pane.textContent = '';
        pane.append(skeleton());
        request('getWorkbench').then((d) => {
          pane.textContent = '';
          pane.append(el('div', { class: 'ihub-welcome' }, t('welcome')));

          pane.append(el('div', { class: 'ihub-cards' },
            el('div', { class: 'ihub-card' }, el('div', { class: 'ihub-num' }, String(d.todayAdded ?? 0)), el('div', { class: 'ihub-label' }, t('todayAdded'))),
            el('div', { class: 'ihub-card' }, el('div', { class: 'ihub-num' }, String(d.eventsToday ?? 0)), el('div', { class: 'ihub-label' }, t('eventsToday'))),
            el('div', { class: 'ihub-card' }, el('div', { class: 'ihub-num' }, String(d.pendingVerify ?? 0)), el('div', { class: 'ihub-label' }, t('pendingVerify'))),
            el('div', { class: 'ihub-card' }, el('div', { class: 'ihub-num' }, String(d.topicUpdates ?? 0)), el('div', { class: 'ihub-label' }, t('topicUpdates'))),
          ));

          const main = el('div', {});
          const side = el('div', {});
          pane.append(el('div', { class: 'ihub-cols' }, main, side));

          // 今日重点 Top5
          const hero = section(main, t('topPicks'));
          if ((d.topPicks || []).length) {
            if (d.picksFallback) hero.append(el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-bottom:6px' }, t('picksFallbackHint')));
            for (const doc of d.topPicks) {
              const row = el('div', { class: 'ihub-pick' });
              const body = el('div', { style: 'min-width:0; flex:1' });
              body.append(
                el('div', { class: 'ihub-row' },
                  el('div', { class: 'ihub-pick-title', text: doc.title || doc.url }),
                  el('div', { class: 'ihub-badges' }, badgeOf(doc), topicBadge(doc), doc.decision ? pill(doc.decision) : null)),
                doc.summary ? el('div', { class: 'ihub-pick-reason', text: String(doc.summary).slice(0, 100) }) : null,
                metaLine(doc),
                pickActions(doc, () => app.render()),
              );
              const open = openButton(doc);
              row.append(body, el('div', { style: 'align-self:center' }, open));
              hero.append(row);
            }
          } else {
            hero.append(emptyState(t('topPicksEmpty'), t('navReports'), () => app.show('reports')));
          }

          // 正在研究的专题（左下）
          const topicsPanel = section(main, t('topicsNow'));
          if ((d.topicCards || []).length) {
            const grid = el('div', { class: 'ihub-topics' });
            for (const tp of d.topicCards) {
              grid.append(el('div', { class: 'ihub-topic-card', onclick: () => app.openTopic(tp.id) },
                el('h4', { text: tp.name }),
                el('div', { class: 'ihub-muted', style: 'font-size:12px' }, tp.description || ''),
                el('div', { class: 'ihub-meta' },
                  `${t('knowledgeItems')} ${tp.knowledge_count} · ${t('doneResearch')} ${tp.completed_research} · ${t('lastUpdate')} ${relTime(tp.last_revision_at, t)}`)));
            }
            topicsPanel.append(grid);
          } else topicsPanel.append(el('div', { class: 'ihub-muted' }, t('empty')));

          // 右栏：大肥鱼状态
          const fish = section(side, t('bigFish'));
          const lineFor = (label, rows, timeKey) => {
            fish.append(el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:6px' }, label));
            if (!rows.length) fish.append(el('div', { class: 'ihub-muted', style: 'font-size:12px' }, t('empty')));
            for (const j of rows.slice(0, 5)) fish.append(jobLine(j, false));
          };
          lineFor(t('running'), d.runningTasks || []);
          lineFor(t('recentDone'), (d.recentCompleted || []).map((j) => ({ ...j })), 'completed_at');
          fish.append(el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:6px' }, t('watching')));
          if (!(d.pending || []).length) fish.append(el('div', { class: 'ihub-muted', style: 'font-size:12px' }, t('empty')));
          for (const c of d.pending || []) {
            fish.append(el('div', { class: 'ihub-jobline' },
              el('span', { class: 'ihub-dot', 'data-level': 'warn' }),
              el('span', { class: 'ihub-job-kind', text: c.topic || '' }),
              el('span', { class: 'ihub-job-time', text: relTime(c.created_at, t) })));
          }

          // 右栏：来源健康
          const healthPanel = section(side, t('sourceHealth'));
          for (const h of d.sourceHealth || []) {
            const level = !h.last_error ? (h.last_ok_at ? 'ok' : 'warn')
              : (/rate|429|timed?\s?out|timeout|temporar/i.test(String(h.last_error)) ? 'warn' : 'bad');
            healthPanel.append(el('div', { class: 'ihub-jobline' },
              el('span', { class: 'ihub-dot', 'data-level': level, title: String(h.last_error || '') }),
              el('span', { class: 'ihub-job-kind', text: h.name }),
              el('span', { class: 'ihub-job-time', text: relTime(h.last_ok_at, t) })));
          }

          // 右栏：采集趋势 sparkline
          const trendPanel = section(side, t('trend7'));
          trendPanel.append(sparkSvg(d.trend7 || []));
          trendPanel.append(el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:6px' }, `${t('weeklyHint')}: ${d.weeklyHint || '—'}`));
        }).catch((e) => showError(pane, e));
      });

      // --- 情报收件箱 (Inbox) ---------------------------------------------------
      app.registerView('inbox', (pane) => {
        const state = pageState.inbox ||= { q: '', source_type: '', topic: '', min_score: '', decision: '', bookmark: '', sort: 'fetched', time_range: '', offset: 0, limit: 20, total: 0, selected: new Set() };
        pane.textContent = '';
        const input = el('input', { class: 'ihub-input ihub-search', type: 'search', placeholder: t('searchPlaceholder'), value: state.q });
        const typeSel = el('select', { class: 'ihub-select' },
          el('option', { value: '' }, t('all')),
          ...SOURCE_TYPES.map((s) => el('option', { value: s, selected: state.source_type === s }, s)));
        const topicSel = el('select', { class: 'ihub-select' }, el('option', { value: '' }, `${t('filterTopic')}: ${t('all')}`));
        const scoreInput = el('input', { class: 'ihub-input', type: 'number', min: '0', max: '100', placeholder: t('filterScore'), value: state.min_score, style: 'width:80px' });
        const decisionSel = el('select', { class: 'ihub-select' },
          el('option', { value: '' }, `${t('filterDecision')}: ${t('all')}`),
          ...['DIGEST', 'RECOMMEND', 'RESEARCH', 'ARCHIVE'].map((v) => el('option', { value: v, selected: state.decision === v }, v)));
        const bmSel = el('select', { class: 'ihub-select' },
          el('option', { value: '' }, `${t('filterBookmark')}: ${t('all')}`),
          el('option', { value: '1', selected: state.bookmark === '1' }, t('onlyBookmarked')));
        const sortSel = el('select', { class: 'ihub-select' },
          el('option', { value: 'fetched', selected: state.sort === 'fetched' }, t('sortFetched')),
          el('option', { value: 'score', selected: state.sort === 'score' }, t('sortScore')));
        const rangeSel = el('select', { class: 'ihub-select' },
          ...[['', t('rangeAll')], ['1440', t('rangeDay')], ['10080', t('rangeWeek')], ['43200', t('rangeMonth')]]
            .map(([v, label]) => el('option', { value: v, selected: state.time_range === v }, label)));
        const count = el('div', { class: 'ihub-muted', style: 'margin:8px 0' }, t('loading'));
        const results = el('div', {});
        const pager = el('div', { class: 'ihub-row', style: 'margin-top:8px' });
        const batchBar = el('div', { class: 'ihub-row', style: 'margin:8px 0' });

        function drawBatchBar() {
          batchBar.textContent = '';
          const sel = state.selected;
          batchBar.append(el('span', { class: 'ihub-muted' }, t('selected').replace('{n}', String(sel.size))));
          const bBm = el('button', { class: 'ihub-btn' }, t('batchBookmark'));
          const bIg = el('button', { class: 'ihub-btn', 'data-kind': 'danger' }, t('batchIgnore'));
          bBm.disabled = bIg.disabled = sel.size === 0;
          bBm.addEventListener('click', () => batchAct({ bookmark: true }));
          bIg.addEventListener('click', () => batchAct({ feedback_type: 'irrelevant' }));
          batchBar.append(bBm, bIg);
        }

        function batchAct(base) {
          const items = [...state.selected].map((id) => ({ document_id: id, feedback_type: base.feedback_type }));
          const payload = { items };
          if (base.bookmark) payload.bookmark = true;
          request('markItems', payload).then(() => {
            state.selected.clear();
            run();
          }).catch((e) => { count.textContent = `${t('errorPrefix')}: ${e?.message || e}`; });
        }

        function run() {
          results.textContent = '';
          results.append(skeleton());
          Object.assign(state, {
            q: input.value.trim().slice(0, 200), source_type: typeSel.value,
            min_score: scoreInput.value, decision: decisionSel.value, bookmark: bmSel.value,
            sort: sortSel.value, time_range: rangeSel.value,
          });
          request('getInbox', {
            q: state.q || undefined,
            source_type: state.source_type || undefined,
            topic: state.topic || undefined,
            min_score: state.min_score === '' ? undefined : Number(state.min_score),
            decision: state.decision || undefined,
            bookmark: state.bookmark === '' ? undefined : state.bookmark === '1',
            sort: state.sort,
            time_range: state.time_range === '' ? undefined : Number(state.time_range),
            offset: state.offset,
            limit: state.limit,
          }).then((d) => {
            state.total = d.total || 0;
            count.textContent = t('resultsCount').replace('{n}', String(state.total));
            results.textContent = '';
            if (!(d.items || []).length) { results.append(emptyState(t('noResults'))); drawPager(); return; }
            for (const doc of d.items) {
              const cb = el('input', { type: 'checkbox' });
              cb.checked = state.selected.has(doc.id);
              cb.addEventListener('change', () => {
                if (cb.checked) state.selected.add(doc.id); else state.selected.delete(doc.id);
                drawBatchBar();
              });
              results.append(inboxCard(doc, cb, () => run()));
            }
            drawBatchBar();
            drawPager();
          }).catch((e) => { results.textContent = ''; showError(results, e); });
        }

        function drawPager() {
          pager.textContent = '';
          const pages = Math.max(1, Math.ceil(state.total / state.limit));
          const page = Math.floor(state.offset / state.limit) + 1;
          const prev = el('button', { class: 'ihub-btn' }, t('pagePrev'));
          const next = el('button', { class: 'ihub-btn' }, t('pageNext'));
          prev.disabled = page <= 1;
          next.disabled = page >= pages;
          prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); run(); });
          next.addEventListener('click', () => { state.offset = state.offset + state.limit; run(); });
          pager.append(prev, el('span', { class: 'ihub-muted' }, `${page} / ${pages}`), next);
        }

        let debounce = 0;
        input.addEventListener('input', () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { state.offset = 0; run(); }, 300); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (debounce) clearTimeout(debounce); state.offset = 0; run(); } });
        for (const s of [typeSel, decisionSel, bmSel, sortSel, rangeSel]) {
          s.addEventListener('change', () => { state.offset = 0; run(); });
        }
        scoreInput.addEventListener('change', () => { state.offset = 0; run(); });

        request('getTopics').then((d) => {
          for (const tp of d.topics || []) {
            topicSel.append(el('option', { value: tp.name, selected: state.topic === tp.name }, tp.name));
          }
        }).catch(() => { /* topic filter stays empty */ });
        topicSel.addEventListener('change', () => { state.topic = topicSel.value; state.offset = 0; run(); });

        pane.append(
          el('div', { class: 'ihub-row', style: 'margin-bottom:8px' },
            input, typeSel, topicSel, scoreInput, decisionSel, bmSel, sortSel, rangeSel,
            el('button', { class: 'ihub-btn', 'data-kind': 'primary', onclick: () => { state.offset = 0; run(); } }, t('searchButton'))),
          count, batchBar, results, pager,
        );
        run();
      });

      // --- 专题研究 (Topics) ----------------------------------------------------
      app.registerView('topics', (pane) => {
        const state = pageState.topics ||= { openId: null };
        pane.textContent = '';
        if (!state.openId) return drawList();
        return drawDetail(state.openId);

        function drawList() {
          pane.append(skeleton());
          request('getTopics').then((d) => {
            pane.textContent = '';
            const grid = el('div', { class: 'ihub-topics' });
            for (const tp of d.topics || []) {
              grid.append(el('div', { class: 'ihub-topic-card', onclick: () => { state.openId = tp.id; app.render(); } },
                el('h4', { text: tp.name }),
                el('div', { class: 'ihub-muted', style: 'font-size:12px' }, tp.description || ''),
                el('div', { class: 'ihub-meta' },
                  `${t('knowledgeItems')} ${tp.knowledge_count} · ${t('doneResearch')} ${tp.completed_research}`)));
            }
            pane.append(grid);
            if (!(d.topics || []).length) pane.append(emptyState(t('empty')));
          }).catch((e) => showError(pane, e));
        }

        function drawDetail(id) {
          pane.append(skeleton());
          request('getTopicDetail', { id }).then((d) => {
            pane.textContent = '';
            pane.append(el('button', { class: 'ihub-btn', onclick: () => { state.openId = null; app.render(); } }, t('backToList')));
            pane.append(el('h2', { style: 'font-size:15px; margin:10px 0' }, d.topic.name));
            pane.append(el('div', { class: 'ihub-muted', style: 'margin-bottom:8px' }, d.topic.description || ''));

            const refreshBtn = el('button', { class: 'ihub-btn', 'data-kind': 'primary' }, t('refreshTopic'));
            const refreshNote = el('span', { class: 'ihub-muted', style: 'font-size:11px' });
            refreshBtn.addEventListener('click', () => {
              refreshBtn.disabled = true; refreshBtn.textContent = t('refreshing');
              request('refreshTopic', { id }).then((r) => {
                refreshBtn.disabled = false; refreshBtn.textContent = t('refreshTopic');
                refreshNote.textContent = t('refreshDone').replace('{e}', String(r.examined)).replace('{w}', String(r.written));
                app.render();
                state.openId = id;
              }).catch((e) => {
                refreshBtn.disabled = false; refreshBtn.textContent = t('refreshTopic');
                refreshNote.textContent = `${t('errorPrefix')}: ${e?.message || e}`;
              });
            });
            pane.append(el('div', { class: 'ihub-row', style: 'margin-bottom:10px' }, refreshBtn, refreshNote));

            const secPanel = section(pane, t('sections'));
            for (const [sec, items] of Object.entries(d.sections || {})) {
              if (!(items || []).length) continue;
              secPanel.append(el('h4', { text: `${sec} (${items.length})` }));
              for (const k of items) {
                const item = el('div', { class: 'ihub-kitem' });
                item.append(el('div', { text: k.content }));
                if ((k.evidence || []).length) {
                  const ev = el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:2px' }, `${t('evidence')}: `);
                  k.evidence.forEach((e, i) => {
                    if (i) ev.append(' · ');
                    if (/^https?:\/\//i.test(String(e.url || ''))) {
                      ev.append(el('a', { class: 'ihub-link', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.title || String(e.url).slice(0, 50)));
                    } else ev.append(e.title || `#${e.id}`);
                  });
                  item.append(ev);
                }
                secPanel.append(item);
              }
            }

            const revPanel = section(pane, t('revisions'));
            if (!(d.revisions || []).length) revPanel.append(el('div', { class: 'ihub-muted' }, t('noRevisions')));
            for (const r of d.revisions || []) {
              const line = el('div', { class: 'ihub-revline' });
              line.append(
                el('span', { class: 'ihub-pill' },
                  el('span', { class: 'ihub-dot', 'data-level': CHANGE_KIND_LEVEL[r.change_kind] || 'off' }),
                  document.createTextNode(r.change_kind)),
                el('span', { class: 'ihub-muted', text: relTime(r.created_at, t) }),
                el('span', { text: r.change_reason || '' }),
              );
              revPanel.append(line);
            }
          }).catch((e) => showError(pane, e));
        }
      });

      // --- 知识库 (Knowledge) ---------------------------------------------------
      app.registerView('knowledge', (pane) => {
        const state = pageState.knowledge ||= { q: '', topic_id: '' };
        pane.textContent = '';
        const input = el('input', { class: 'ihub-input ihub-search', type: 'search', placeholder: t('knowledgeSearch'), value: state.q });
        const topicSel = el('select', { class: 'ihub-select' }, el('option', { value: '' }, t('all')));
        const results = el('div', { style: 'margin-top:10px' });

        function run() {
          results.textContent = '';
          results.append(skeleton());
          state.q = input.value.trim().slice(0, 200);
          state.topic_id = topicSel.value;
          const calls = [
            request('getKnowledge', { q: state.q || undefined, topic_id: state.topic_id || undefined }),
            request('searchDocs', { query: state.q || undefined, limit: 10 }),
            state.topic_id ? request('getTopicDetail', { id: Number(state.topic_id) }) : Promise.resolve(null),
          ];
          Promise.all(calls).then(([k, docs, detail]) => {
            results.textContent = '';
            const kPanel = section(results, t('knowledgeTitle'));
            if (!(k.knowledge || []).length) kPanel.append(el('div', { class: 'ihub-muted' }, t('noResults')));
            for (const item of k.knowledge || []) {
              const box = el('div', { class: 'ihub-kitem' });
              box.append(el('div', { text: item.content }));
              const meta = el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:2px' },
                `${item.section} · ${relTime(item.created_at, t)}`);
              box.append(meta);
              if ((item.evidence || []).length) {
                const ev = el('div', { style: 'font-size:11px; margin-top:2px' }, `${t('evidence')}: `);
                item.evidence.forEach((e, i) => {
                  if (i) ev.append(' · ');
                  if (/^https?:\/\//i.test(String(e.url || ''))) {
                    ev.append(el('a', { class: 'ihub-link', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.title || String(e.url).slice(0, 50)));
                  } else ev.append(e.title || `#${e.id}`);
                });
                box.append(ev);
              }
              kPanel.append(box);
            }
            if (docs && (docs.results || []).length) {
              const dPanel = section(results, t('navInbox'));
              for (const doc of docs.results.slice(0, 8)) {
                const row = el('div', { class: 'ihub-kitem' },
                  el('div', { text: doc.title || doc.url }),
                  el('div', { class: 'ihub-muted', style: 'font-size:11px' }, `${doc.source_type} · ${relTime(doc.fetched_at, t)}`));
                if (/^https?:\/\//i.test(String(doc.url || ''))) {
                  row.append(el('a', { class: 'ihub-link', href: doc.url, target: '_blank', rel: 'noopener noreferrer', style: 'font-size:11px' }, t('external')));
                }
                dPanel.append(row);
              }
            }
            if (detail && (detail.revisions || []).length) {
              const rPanel = section(results, t('revisions'));
              for (const r of detail.revisions) {
                const line = el('div', { class: 'ihub-revline' });
                const rb = el('button', { class: 'ihub-btn' }, t('rollback'));
                rb.addEventListener('click', () => {
                  if (!window.confirm(t('rollbackConfirm'))) return;
                  rb.disabled = true;
                  request('rollbackKnowledge', { revision_id: r.id }).then(() => {
                    rb.textContent = t('rollbackDone');
                    run();
                  }).catch((e) => { rb.disabled = false; rb.textContent = `${t('errorPrefix')}: ${e?.message || e}`; });
                });
                line.append(
                  el('span', { class: 'ihub-pill' },
                    el('span', { class: 'ihub-dot', 'data-level': CHANGE_KIND_LEVEL[r.change_kind] || 'off' }),
                    document.createTextNode(r.change_kind)),
                  el('span', { class: 'ihub-muted', text: relTime(r.created_at, t) }),
                  el('span', { style: 'flex:1', text: r.change_reason || '' }),
                  rb,
                );
                rPanel.append(line);
              }
            }
          }).catch((e) => showError(results, e));
        }

        let debounce = 0;
        input.addEventListener('input', () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(run, 300); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (debounce) clearTimeout(debounce); run(); } });
        topicSel.addEventListener('change', run);

        request('getTopics').then((d) => {
          for (const tp of d.topics || []) topicSel.append(el('option', { value: String(tp.id), selected: state.topic_id === String(tp.id) }, tp.name));
        }).catch(() => { /* stay empty */ });

        pane.append(el('div', { class: 'ihub-row', style: 'margin-bottom:8px' }, input, topicSel), results);
        run();
      });

      // --- 研究报告 (Reports) ---------------------------------------------------
      app.registerView('reports', (pane) => {
        pane.textContent = '';
        pane.append(skeleton());
        request('listReports', { limit: 90 }).then((d) => {
          pane.textContent = '';
          const reports = d.reports || [];
          if (!reports.length) {
            pane.append(emptyState(t('noReports'), t('refresh'), () => app.render()));
            return;
          }
          const wrap = el('div', { class: 'ihub-reports' });
          const list = el('div', { class: 'ihub-reports-list' });
          const reader = el('div', { class: 'ihub-reader' });
          wrap.append(list, reader);
          pane.append(wrap);

          const KIND_LABEL = { daily: 'groupDaily', weekly: 'groupWeekly', coverage: 'groupCoverage', research: 'groupResearch', learning: 'groupLearning' };
          const groups = new Map();
          for (const r of reports) {
            const g = t(KIND_LABEL[r.kind] || 'groupOther');
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(r);
          }
          const buttons = new Map();
          const keyOf = (r) => `${r.kind}:${r.id}`;
          for (const [g, rows] of groups) {
            list.append(el('h4', {}, g));
            for (const r of rows.slice(0, 20)) {
              const btn = el('button', { class: 'ihub-rep-item' },
                r.report_date || '', el('div', { class: 'ihub-muted', style: 'font-size:11px' }, r.title || ''));
              btn.addEventListener('click', () => load(r, btn));
              buttons.set(keyOf(r), btn);
              list.append(btn);
            }
          }

          function load(r, btn) {
            reader.textContent = '';
            reader.append(skeleton());
            for (const b of buttons.values()) b.removeAttribute('data-active');
            if (btn) btn.setAttribute('data-active', 'true');
            const payload = { kind: r.kind, date: r.report_date || undefined, id: r.kind === 'learning' ? r.id : undefined, task_id: r.kind === 'research' ? r.id : undefined };
            request('getReportMarkdown', payload).then((md) => {
              reader.textContent = '';
              reader.append(
                el('h2', { style: 'margin:0 0 10px; font-size:15px' }, md.report.title || `${t('reportFor')} ${md.report.report_date}`),
                markdownToDom(md.report.markdown),
              );
            }).catch((e) => showError(reader, e));
          }

          const target = app.pendingReportKey;
          app.pendingReportKey = undefined;
          if (target && buttons.has(target)) load(reports.find((r) => keyOf(r) === target), buttons.get(target));
          else {
            const first = reports[0];
            load(first, buttons.get(keyOf(first)));
          }
        }).catch((e) => showError(pane, e));
      });

      // --- 数据来源 (Sources) ---------------------------------------------------
      app.registerView('sources', (pane) => {
        pane.textContent = '';
        pane.append(skeleton());
        Promise.all([
          request('listSources', {}),
          request('listCandidates', { status: '' }),
        ]).then(([src, cand]) => {
          pane.textContent = '';

          // 新增来源表单
          const addPanel = section(pane, t('addSource'));
          const typeSel = el('select', { class: 'ihub-select' }, ...SOURCE_TYPES.map((s) => el('option', { value: s }, s)));
          const nameInput = el('input', { class: 'ihub-input', placeholder: t('name'), style: 'width:160px' });
          const urlInput = el('input', { class: 'ihub-input ihub-search', placeholder: t('url') });
          const addBtn = el('button', { class: 'ihub-btn', 'data-kind': 'primary' }, t('addSourceBtn'));
          const addNote = el('span', { class: 'ihub-muted', style: 'font-size:11px' }, t('addSourceHint'));
          addBtn.addEventListener('click', () => {
            addBtn.disabled = true;
            request('addSource', { source_type: typeSel.value, name: nameInput.value.trim().slice(0, 120), url: urlInput.value.trim().slice(0, 500) })
              .then((r) => {
                addBtn.disabled = false;
                addNote.textContent = r.inserted ? t('sourceAdded') : t('sourceAddDup');
                if (r.inserted) { nameInput.value = ''; urlInput.value = ''; app.render(); }
              })
              .catch((e) => { addBtn.disabled = false; addNote.textContent = `${t('errorPrefix')}: ${e?.message || e}`; });
          });
          addPanel.append(el('div', { class: 'ihub-row' }, typeSel, nameInput, urlInput, addBtn), el('div', { class: 'ihub-muted', style: 'font-size:11px; margin-top:4px' }, addNote));

          const srcPanel = section(pane, t('sourcesOn'));
          const table = el('table', { class: 'ihub-table' });
          table.append(el('tr', {},
            el('th', {}, t('type')), el('th', {}, t('name')), el('th', {}, t('url')),
            el('th', {}, t('state')), el('th', {}, t('lastOk')), el('th', {}, '')));
          for (const s of src.sources || []) {
            const level = s.enabled ? (!s.last_error ? (s.last_ok_at ? 'ok' : 'warn')
              : (/rate|429|timed?\s?out|timeout|temporar/i.test(String(s.last_error)) ? 'warn' : 'bad')) : 'off';
            const key = { ok: 'statusOk', warn: 'statusDegraded', bad: 'statusFailed', off: 'statusOff' }[level];
            const toggle = el('button', { class: 'ihub-btn' }, s.enabled ? t('disable') : t('enable'));
            toggle.addEventListener('click', () => {
              toggle.disabled = true;
              request('setSourceEnabled', { id: s.id, enabled: !s.enabled })
                .then(() => app.render())
                .catch((e) => { toggle.disabled = false; toggle.textContent = `${t('errorPrefix')}: ${e?.message || e}`; });
            });
            table.append(el('tr', {},
              el('td', {}, pill(s.source_type)),
              el('td', { text: s.name }),
              el('td', {}, el('span', { class: 'ihub-url', text: String(s.url || '').slice(0, 80) })),
              el('td', { title: String(s.last_error || '') }, el('span', { class: 'ihub-pill' },
                el('span', { class: 'ihub-dot', 'data-level': level }), document.createTextNode(t(key)))),
              el('td', { text: relTime(s.last_ok_at, t) }),
              el('td', {}, toggle)));
          }
          if (!(src.sources || []).length) srcPanel.append(emptyState(t('empty')));
          else srcPanel.append(table);

          // 候选来源审批区（保留）
          const candPanel = section(pane, t('candidates'));
          let filter = 'candidate';
          const filterSel = el('select', { class: 'ihub-select', onchange: () => { filter = filterSel.value; drawCandidates(); } },
            ...[['candidate', t('candidate')], ['approved', t('approved')], ['rejected', t('rejected')], ['', t('all')]]
              .map(([v, label]) => el('option', { value: v }, label)));
          candPanel.append(el('div', { class: 'ihub-row', style: 'margin-bottom:8px' }, el('span', { class: 'ihub-muted' }, t('candidateFilter')), filterSel));
          const candBox = el('div', {});
          candPanel.append(candBox);

          function drawCandidates() {
            candBox.textContent = '';
            const rows = (cand.candidates || []).filter((c) => !filter || c.status === filter);
            if (!rows.length) { candBox.append(el('div', { class: 'ihub-muted' }, t('empty'))); return; }
            const ct = el('table', { class: 'ihub-table' });
            ct.append(el('tr', {}, el('th', {}, t('name')), el('th', {}, t('url')), el('th', {}, t('state')), el('th', {}, '')));
            for (const c of rows.slice(0, 50)) {
              const act = el('td', {});
              if (c.status === 'candidate') {
                const approveBtn = el('button', { class: 'ihub-btn', 'data-kind': 'primary' }, t('approve'));
                const rejectBtn = el('button', { class: 'ihub-btn', 'data-kind': 'danger' }, t('reject'));
                approveBtn.addEventListener('click', () => actOn('approveCandidate', c.id, approveBtn, rejectBtn));
                rejectBtn.addEventListener('click', () => actOn('rejectCandidate', c.id, approveBtn, rejectBtn));
                act.append(approveBtn, ' ', rejectBtn);
              }
              ct.append(el('tr', {},
                el('td', { text: c.domain }),
                el('td', {}, el('span', { class: 'ihub-url', text: String(c.url || '').slice(0, 70) })),
                el('td', {}, el('span', { class: 'ihub-pill' }, t(c.status === 'candidate' ? 'candidate' : c.status))),
                act));
            }
            candBox.append(ct);
          }

          function actOn(method, id, approveBtn, rejectBtn) {
            approveBtn.disabled = true; rejectBtn.disabled = true;
            request(method, { id }).then(() => request('listCandidates', { status: '' }).then((fresh) => {
              cand.candidates = fresh.candidates;
              drawCandidates();
            })).catch((e) => {
              candBox.textContent = '';
              candBox.append(el('div', { class: 'ihub-err' }, `${t('errorPrefix')}: ${e?.message || e}`));
              approveBtn.disabled = false; rejectBtn.disabled = false;
            });
          }
          drawCandidates();
        }).catch((e) => showError(pane, e));
      });

      // --- 采集任务 (Jobs) ------------------------------------------------------
      app.registerView('jobs', (pane) => {
        const state = pageState.jobs ||= { offset: 0, limit: 20, kind: '', status: '' };
        pane.textContent = '';

        const trigPanel = section(pane, t('triggerCollect'));
        const kindSel = el('select', { class: 'ihub-select' }, ...['all', ...SOURCE_TYPES].map((k) => el('option', { value: k }, k)));
        const trigBtn = el('button', { class: 'ihub-btn', 'data-kind': 'primary' }, t('triggerCollect'));
        const trigNote = el('span', { class: 'ihub-muted', style: 'font-size:11px' });
        trigBtn.addEventListener('click', () => {
          trigBtn.disabled = true; trigBtn.textContent = t('collecting');
          request('triggerCollect', { kind: kindSel.value }).then((r) => {
            trigBtn.disabled = false; trigBtn.textContent = t('triggerCollect');
            trigNote.textContent = r.mode === 'sync'
              ? t('collectDone').replace('{f}', String(r.fetched ?? 0)).replace('{i}', String(r.inserted ?? 0)).replace('{e}', String(r.errors ?? 0))
              : t('collectQueued');
            run();
          }).catch((e) => {
            trigBtn.disabled = false; trigBtn.textContent = t('triggerCollect');
            trigNote.textContent = `${t('errorPrefix')}: ${e?.message || e}`;
          });
        });
        trigPanel.append(el('div', { class: 'ihub-row' }, kindSel, trigBtn, trigNote));

        const listPanel = section(pane, t('jobsTitle'));
        const kindFilter = el('select', { class: 'ihub-select' },
          el('option', { value: '' }, `${t('jobsKind')}: ${t('all')}`),
          ...['DAILY_DISCOVERY', 'RSS_SYNC', 'GITHUB_SYNC', 'PAPER_SYNC', 'CONTENT_ANALYSIS', 'DAILY_REPORT', 'WEEKLY_REPORT', 'PIPELINE_RUN', 'CODE_RESEARCH', 'RESEARCH_TASK', 'RESEARCH_REVIEW', 'COVERAGE_AUDIT']
            .map((k) => el('option', { value: k, selected: state.kind === k }, k)));
        const statusFilter = el('select', { class: 'ihub-select' },
          el('option', { value: '' }, `${t('jobsStatus')}: ${t('all')}`),
          ...Object.keys(JOB_STATUS_LEVEL).map((k) => el('option', { value: k, selected: state.status === k }, k)));
        const tableBox = el('div', {});
        const pager = el('div', { class: 'ihub-row', style: 'margin-top:8px' });
        kindFilter.addEventListener('change', () => { state.kind = kindFilter.value; state.offset = 0; run(); });
        statusFilter.addEventListener('change', () => { state.status = statusFilter.value; state.offset = 0; run(); });
        listPanel.append(el('div', { class: 'ihub-row', style: 'margin-bottom:8px' }, kindFilter, statusFilter), tableBox, pager);

        function run() {
          tableBox.textContent = '';
          tableBox.append(skeleton());
          request('listJobs', { offset: state.offset, limit: state.limit, kind: state.kind || undefined, status: state.status || undefined })
            .then((d) => {
              tableBox.textContent = '';
              const table = el('table', { class: 'ihub-table' });
              table.append(el('tr', {},
                el('th', {}, t('jobsKind')), el('th', {}, t('jobsStatus')), el('th', {}, t('jobsDate')),
                el('th', {}, t('jobsTime')), el('th', {}, t('jobsAttempts')), el('th', {}, '')));
              if (!(d.jobs || []).length) tableBox.append(el('div', { class: 'ihub-muted' }, t('queueEmpty')));
              for (const j of d.jobs || []) {
                const retryBtn = j.status === 'FAILED' ? el('button', { class: 'ihub-btn' }, t('retry')) : null;
                if (retryBtn) {
                  retryBtn.addEventListener('click', () => {
                    retryBtn.disabled = true;
                    request('retryJob', { job_id: j.id })
                      .then(() => { retryBtn.textContent = t('retryDone'); run(); })
                      .catch((e) => { retryBtn.disabled = false; retryBtn.textContent = `${t('errorPrefix')}: ${e?.message || e}`; });
                  });
                }
                table.append(el('tr', {},
                  el('td', { text: j.kind }),
                  el('td', { title: String(j.error || '') }, el('span', { class: 'ihub-pill' },
                    el('span', { class: 'ihub-dot', 'data-level': JOB_STATUS_LEVEL[j.status] || 'off' }), document.createTextNode(j.status))),
                  el('td', { text: j.run_date || '—' }),
                  el('td', { text: relTime(j.updated_at, t) }),
                  el('td', { text: `${j.attempts}/${j.max_attempts}` }),
                  el('td', {}, retryBtn)));
              }
              tableBox.append(table);
              pager.textContent = '';
              const pages = Math.max(1, Math.ceil((d.total || 0) / state.limit));
              const page = Math.floor(state.offset / state.limit) + 1;
              const prev = el('button', { class: 'ihub-btn' }, t('pagePrev'));
              const next = el('button', { class: 'ihub-btn' }, t('pageNext'));
              prev.disabled = page <= 1;
              next.disabled = page >= pages;
              prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); run(); });
              next.addEventListener('click', () => { state.offset = state.offset + state.limit; run(); });
              pager.append(prev, el('span', { class: 'ihub-muted' }, `${page} / ${pages}`), next);
            })
            .catch((e) => showError(tableBox, e));
        }
        run();
      });

      // --- 设置 (Settings, read-only) ------------------------------------------
      const CFG_DOCS = [
        ['enabled', 'cfgEnabled'], ['collectEnabled', 'cfgCollectEnabled'], ['collectIntervalHours', 'cfgCollectIntervalHours'],
        ['maxPerRun', 'cfgMaxPerRun'], ['analysisEnabled', 'cfgAnalysisEnabled'], ['analysisProvider', 'cfgAnalysisProvider'],
        ['analysisModel', 'cfgAnalysisModel'], ['analysisMaxDocs', 'cfgAnalysisMaxDocs'], ['reportEnabled', 'cfgReportEnabled'],
        ['reportTime', 'cfgReportTime'], ['reportTimeZone', 'cfgReportTimeZone'], ['reportsDir', 'cfgReportsDir'],
        ['retentionDays', 'cfgRetentionDays'], ['maxDiskMb', 'cfgMaxDiskMb'], ['pipelineEnabled', 'cfgPipelineEnabled'],
        ['pipelineSlots', 'cfgPipelineSlots'], ['scoreThresholds', 'cfgScoreThresholds'], ['codeResearchEnabled', 'cfgCodeResearchEnabled'],
        ['researchBudgetPerDay', 'cfgResearchBudgetPerDay'], ['coverageEnabled', 'cfgCoverageEnabled'], ['coverageTime', 'cfgCoverageTime'],
        ['discoveryEnabled', 'cfgDiscoveryEnabled'], ['maxNewSourcesPerDay', 'cfgMaxNewSourcesPerDay'],
        ['autoApproveSources', 'cfgAutoApproveSources'], ['tokenBudgetPerDay', 'cfgTokenBudgetPerDay'],
        ['weeklyReportEnabled', 'cfgWeeklyReportEnabled'], ['weeklyReportTime', 'cfgWeeklyReportTime'],
        ['starSnapshotsEnabled', 'cfgStarSnapshotsEnabled'], ['dbPath', 'cfgDbPath'], ['reposDir', 'cfgReposDir'],
        ['extraCloneHosts', 'cfgExtraCloneHosts'],
      ];
      app.registerView('settings', (pane) => {
        pane.textContent = '';
        pane.append(el('div', { class: 'ihub-note' }, t('settingsNote')));
        const p = section(pane, t('settingsTitle'));
        p.append(skeleton());
        request('getConfig').then((d) => {
          p.textContent = '';
          const table = el('table', { class: 'ihub-table' });
          table.append(el('tr', {}, el('th', {}, t('configKey')), el('th', {}, t('configValue')), el('th', {}, '')));
          for (const [k, v] of Object.entries(d.config || {})) {
            const docKey = CFG_DOCS.find(([key]) => key === k);
            table.append(el('tr', {},
              el('td', { class: 'ihub-kv', text: k }),
              el('td', { class: 'ihub-kv', text: JSON.stringify(v) }),
              el('td', { class: 'ihub-muted', text: docKey ? t(docKey[1]) : '' })));
          }
          p.append(table);
        }).catch((e) => showError(p, e));
      });
    }

    // Sidebar launcher glyph for the global panel row. The sidebar owns the
    // button and its accessible label; this component only draws the glyph at
    // the requested size (contract: SidebarPanelIconOwnerProps { size, active }).
    function HubPanelIcon({ size }) {
      const s = Number(size) || 20;
      return React.createElement('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
        React.createElement('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.6 }),
        React.createElement('circle', { cx: 12, cy: 12, r: 4.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        React.createElement('circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor' }),
        React.createElement('circle', { cx: 12, cy: 3, r: 1.3, fill: 'currentColor' }),
        React.createElement('circle', { cx: 12, cy: 21, r: 1.3, fill: 'currentColor' }),
        React.createElement('circle', { cx: 3, cy: 12, r: 1.3, fill: 'currentColor' }),
        React.createElement('circle', { cx: 21, cy: 12, r: 1.3, fill: 'currentColor' }),
      );
    }

    // ---------------------------------------------------------------------------
    // React host component: renders one container; the DOM app lives inside.
    // ---------------------------------------------------------------------------
    function HubSection(props) {
      const ref = React.useRef(null);
      const ctxRef = React.useRef(props.__ctx);
      React.useEffect(() => {
        const ctx = ctxRef.current;
        const t = ctx.locale.bind(NS);
        const app = createApp({
          t,
          call: (endpoint, payload, signal) =>
            globalThis.fetch(CHANNEL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method: endpoint, payload }),
              ...(signal === undefined ? {} : { signal }),
            }).then(async (res) => {
              if (!res.ok) throw new Error(`transport failure for ${CHANNEL}/${endpoint}: HTTP ${res.status}`);
              const full = await res.json();
              if (full && full.ok) return full.value;
              throw new Error(full?.error?.message || `rpc ${endpoint} failed`);
            }),
        });
        app.openReport = (key) => {
          app.pendingReportKey = key;
          app.show('reports');
        };
        app.openTopic = (id) => {
          app.pageState.topics = { openId: id };
          app.show('topics');
        };
        installViews(app);
        app.start(ref.current);
        return () => app.stop();
      }, []);
      return React.createElement('div', { ref, className: 'ihub' });
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      // Test-only internals (pure functions, never invoked by the runtime).
      __test: {
        markdownToDom, topPicksFromMarkdown, stripInline, relTime, sparkPoints, NAV_PAGES,
        NS, CHANNEL,
      },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'intelligence-hub: locale');
        // Independent main panel (keyed slot) + sidebar launcher icon, mirroring
        // dsh-client-ui-schedule's TaskManager wiring: the panellist entry id is
        // the matching `main` key, so the sidebar button opens this panel.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'intelligence-hub',
          locale: NS,
        }, (props) => HubSection({ ...props, __ctx: ctx })));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'intelligence-hub',
          order: 60,
          locale: NS,
          label: () => ctx.locale.bind(NS)('title'),
        }, HubPanelIcon));
      },
    };
  },
});
