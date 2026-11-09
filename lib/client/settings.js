/**
 * dsh-qq-bot —— 客户端半边（浏览器）。
 *
 * 这是一个手写的模块 bundle，格式由 DSH 的客户端模块加载器决定：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * 只有 `react` 是外部依赖（由运行时提供），其余能力都从 apply(ctx) 注入的服务拿。
 *
 * 作用：在插件管理里本插件的**配置区**渲染整套表单（见文件末尾 plugins.bundle.config 注入），
 * 设置页顶层不单开「QQ 机器人」选项卡。读写走内置的设置 Remote（ctx.remote.settings），
 * 不需要自定义 RPC。
 */
// 这个 id 必须等于 **npm 包名**：DSH 的 client-modules 按包名索引模块行，不一致会报
// 「loaded without registering ...」，网页端整个插件加载失败（设置面板也就没了）。
// 注意它和下面 apply(ctx) 里的 NS 不是一回事——NS 是 profile 条目 id（= 设置命名空间），
// 一直是 'dsh-qq-bot'，不随包名变化。
window.__ModuleLoader__.load({
  id: '@sputnikzaychik/dsh-qq-bot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    // DSH ≥ 0.1.7 的「设置命名空间」就是 profile 里的条目 id。本插件的 bundle 补丁
    // 插入的 id 是 'dsh-qq-bot'（0.1.6 时代用的是自定义命名空间 'qq-bot'，该 API 已移除）。
    // 插件详情页的配置区用「插槽 key」派发，而插件管理页拿的是 **npm 包名**
    // （renderSlot(..., { entryKey: pkg.name })）。所以 key 必须等于包名；
    // 而下面读写的设置命名空间 NS 仍是 profile 条目 id（'dsh-qq-bot'），两者别混。
    var PKG_NAME = '@sputnikzaychik/dsh-qq-bot';
    var NS = 'dsh-qq-bot';
    // 条目 id 可能被用户改名，所以再加一条「以 qq-bot 结尾且唯一」的回退匹配。
    var NS_FALLBACK = /(^|[-_])qq-bot$/;
    var PREFIX = 'dsh-qq-bot';
    // 「未安装」时卡片上的安装入口（取自 dsh-moli 包的 repository 字段）。
    var MOLI_REPO_URL = 'https://github.com/27painter/dsh-moli';

    // ---------------------------------------------------------------- 表单模型

    // ============================================================ 设置页字段（来自服务端模板）
    // 字段定义不再写死在这个 bundle 里：各所有者目录的 *-set.json 声明「这组配置怎么编辑」，
    // 服务端在加载期组装并校验，再由 GET /dsh-qq-bot/settings 下发。
    // 加一个字段 = 改对应 JSON，这个文件一行都不用动，也不用重新打包。
    var ALL_FIELDS = [];           // 全部字段（保存 / 还原比对用）
    var FIELDS = [];               // 外层逐行渲染的字段
    var MOLI_ADVANCED_FIELDS = []; // 渲染在 moli 卡片内部的高级字段（不占外层位置）
    var STICKER_CARD_FIELDS = [];  // 渲染在表情包卡片内部的参数（不占外层位置）
    var UPDATE_INFO = null;        // 设置模板一起下发的新版本状态（没有更新时为 null）
    var GROUPS = [];               // 标签页骨架
    var SUBGROUPS_BY_TAB = {};     // tab id → 二级标签数组（没有二级标签则为 null）

    /** 用服务端下发的模板填充上面这几个变量。 */
    function applyTemplate(template) {
      UPDATE_INFO = (template.update !== undefined && template.update !== null) ? template.update : null;
      ALL_FIELDS = Array.isArray(template.fields) ? template.fields : [];
      GROUPS = Array.isArray(template.tabs) ? template.tabs : [];
      FIELDS = [];
      MOLI_ADVANCED_FIELDS = [];
      STICKER_CARD_FIELDS = [];
      for (var i = 0; i < ALL_FIELDS.length; i += 1) {
        var field = ALL_FIELDS[i];
        if (field.in === 'moli-card') MOLI_ADVANCED_FIELDS.push(field);
        else if (field.in === 'sticker-card') STICKER_CARD_FIELDS.push(field);
        else FIELDS.push(field);
      }
      SUBGROUPS_BY_TAB = {};
      for (var g = 0; g < GROUPS.length; g += 1) {
        var subs = GROUPS[g].subs;
        SUBGROUPS_BY_TAB[GROUPS[g].id] = (Array.isArray(subs) && subs.length > 0) ? subs : null;
      }
    }

    function groupOf(field) {
      return field.tab === undefined || field.tab === null ? 'advanced' : field.tab;
    }

    function subGroupOf(field) {
      return field.subtab === undefined ? null : field.subtab;
    }

    /** 声明式 when：{ "a.b": 值 } 逐项等值；{ "a.b": { $ne: 值 } } 表示不等。 */
    function whenMatches(when, draft) {
      var keys = Object.keys(when);
      for (var i = 0; i < keys.length; i += 1) {
        var expected = when[keys[i]];
        var actual = getPath(draft, keys[i].split('.'));
        if (expected !== null && typeof expected === 'object' && expected.$ne !== undefined) {
          if (actual === expected.$ne) return false;
        } else if (actual !== expected) return false;
      }
      return true;
    }

    /** 字段此刻是否显示。模板里的 when 是数据，代码里遗留的 when 是函数，两种都认。 */
    function fieldVisible(field, draft) {
      if (field.when === undefined || field.when === null) return true;
      if (typeof field.when === 'function') return field.when(draft) === true;
      return whenMatches(field.when, draft);
    }

    function getPath(object, path) {
      var cursor = object;
      for (var i = 0; i < path.length; i += 1) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
        cursor = cursor[path[i]];
      }
      return cursor;
    }

    function setPath(object, path, value) {
      var next = JSON.parse(JSON.stringify(object === null || object === undefined ? {} : object));
      var cursor = next;
      for (var i = 0; i < path.length - 1; i += 1) {
        if (cursor[path[i]] === null || typeof cursor[path[i]] !== 'object') cursor[path[i]] = {};
        cursor = cursor[path[i]];
      }
      cursor[path[path.length - 1]] = value;
      return next;
    }

    function sameValue(a, b) {
      if (a === b) return true;
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
        return true;
      }
      if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        var ka = Object.keys(a); var kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var j = 0; j < ka.length; j += 1) {
          if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
          if (!sameValue(a[ka[j]], b[ka[j]])) return false;
        }
        return true;
      }
      return false;
    }

    function messageOf(error) {
      if (error === null || error === undefined) return String(error);
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string') return error.message;
      return String(error);
    }

    // 设置 Remote 的返回是 { ok, value } 信封；这里兼容直接返回值的实现。
    function unwrap(response) {
      if (response === null || response === undefined) return undefined;
      if (typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'ok')) {
        return response.ok === true ? response.value : undefined;
      }
      return response;
    }
    function errorOf(response) {
      if (response !== null && response !== undefined && typeof response === 'object' && response.ok === false) {
        return messageOf(response.error);
      }
      return '未知错误';
    }

    // ------------------------------------------------------------------- 样式
    // 用中性色，浅色/深色主题下都可用；不依赖具体主题 token。
    var S = {
      updateNotice: {
        margin: '8px 0 0',
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '13px',
        lineHeight: 1.5,
        background: 'rgba(250, 200, 80, 0.16)',
        border: '1px solid rgba(220, 160, 40, 0.45)',
      },
      wrap: { padding: '4px 2px 24px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '620px' },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      // 密钥字段的状态徽章：已设置用绿框绿字（一眼看出「这里有东西」），未设置用灰框灰字。
      // 颜色写死而不用主题变量：绿色在浅色/深色主题下都要能看清，主题变量里没有语义化的成功色。
      secretRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      secretBadgeOn: {
        fontSize: '12px', fontWeight: 600, lineHeight: '18px', padding: '0 8px', borderRadius: '999px',
        color: '#2ea043', border: '1px solid rgba(46, 160, 67, 0.6)', background: 'rgba(46, 160, 67, 0.14)',
      },
      secretBadgeOff: {
        fontSize: '12px', fontWeight: 400, lineHeight: '18px', padding: '0 8px', borderRadius: '999px',
        color: 'rgba(127, 127, 127, 0.8)', border: '1px dashed rgba(127, 127, 127, 0.45)', background: 'transparent',
      },
      row: { display: 'flex', flexDirection: 'column', gap: '5px' },
      label: { fontSize: '13px', fontWeight: 500 },
      input: {
        fontSize: '13px', padding: '6px 9px', borderRadius: '6px', width: '100%', boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.06)', color: 'inherit',
      },
      // 下拉框：文字/背景用主题变量（--dsw-alias-*），默认主题与 maid-atelier 都能看清。
      select: {
        fontSize: '13px', padding: '6px 9px', borderRadius: '6px', width: '100%', boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      selectDisabled: {
        fontSize: '13px', padding: '6px 9px', borderRadius: '6px', width: '100%', boxSizing: 'border-box',
        border: '1px dashed rgba(127,127,127,0.3)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        color: 'var(--dsw-alias-label-dimmed, rgba(127,127,127,0.55))',
        opacity: 0.75, cursor: 'not-allowed',
      },
      option: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' },
      button: {
        fontSize: '13px', padding: '6px 16px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.14)', color: 'inherit',
      },
      buttonGhost: {
        fontSize: '13px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.25)', background: 'transparent', color: 'inherit',
      },
      notice: { fontSize: '12px', opacity: 0.8 },
      // 提示分级：保存成功用绿、失败/被拒用红、中性提示（没有改动 / 已还原）用默认灰。
      // 以前一律 12px 半透明灰字，保存失败和「已保存」长得一模一样，用户根本注意不到。
      noticeOk: { fontSize: '13px', fontWeight: 600, color: '#2ea043', lineHeight: 1.5 },
      noticeError: {
        fontSize: '13px', fontWeight: 600, color: '#d9534f', lineHeight: 1.5,
        // 失败要让眼睛立刻停住：淡红底 + 红边 + 内边距，与成功提示靠颜色区分即可。
        padding: '4px 10px', borderRadius: '6px',
        background: 'rgba(217, 83, 79, 0.14)', border: '1px solid rgba(217, 83, 79, 0.5)',
      },
      // 标签页外壳：顶端标签 + 可滚动主体 + 常驻底栏（仿 dsh-service 设置顶端）
      shell: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '4px 2px 0', boxSizing: 'border-box' },
      tabBar: {
        flex: 'none', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-end',
        borderBottom: '1px solid rgba(127,127,127,0.28)', paddingBottom: '0',
      },
      tab: {
        fontSize: '13px', lineHeight: '20px', padding: '7px 16px', cursor: 'pointer',
        border: '1px solid transparent', borderBottom: 'none',
        borderRadius: '8px 8px 0 0', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.85))', fontWeight: 500,
        marginBottom: '-1px', transition: 'color .15s, background .15s',
      },
      tabActive: {
        fontSize: '13px', lineHeight: '20px', padding: '7px 16px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.28)', borderBottom: '1px solid var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        borderRadius: '8px 8px 0 0',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
        color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 600,
        marginBottom: '-1px',
      },
      subTabBar: {
        flex: 'none', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center',
        padding: '10px 2px 0',
      },
      subTab: {
        fontSize: '12px', lineHeight: '18px', padding: '4px 12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.28)', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.85))',
        transition: 'background .15s, color .15s',
      },
      subTabActive: {
        fontSize: '12px', lineHeight: '18px', padding: '4px 12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.14))',
        color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 600,
      },
      body: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '14px 2px 12px',
      },
      groupHint: { fontSize: '12px', opacity: 0.6, lineHeight: 1.5, marginBottom: '2px' },
      footer: {
        flex: 'none', position: 'sticky', bottom: 0, zIndex: 2,
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '12px 2px', marginTop: '2px',
        borderTop: '1px solid rgba(127,127,127,0.28)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      error: { fontSize: '13px', color: '#d9534f', lineHeight: 1.6 },
      // 「Moli 渲染抓取」卡片（状态徽标 + 开关 + 检测按钮）
      moliCard: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px',
        border: '1px solid rgba(127,127,127,0.28)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05))',
      },
      moliHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' },
      moliTitles: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      moliTitle: { fontSize: '13px', fontWeight: 600 },
      moliSub: { fontSize: '11px', opacity: 0.6 },
      moliBadgeOk: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(63,160,90,0.45)', background: 'rgba(63,160,90,0.16)', color: 'inherit',
      },
      moliBadgeWarn: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(200,150,40,0.45)', background: 'rgba(200,150,40,0.16)', color: 'inherit',
      },
      moliBadgeBad: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(217,83,79,0.45)', background: 'rgba(217,83,79,0.14)', color: 'inherit',
      },
      moliBadgeIdle: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.12)', color: 'inherit',
      },
      moliBody: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      moliToggle: { display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'pointer' },
      moliToggleDisabled: { display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'not-allowed', opacity: 0.55 },
      moliDetail: { fontSize: '12px', opacity: 0.7, lineHeight: 1.55 },
      moliAdv: {
        display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '10px',
        borderTop: '1px dashed rgba(127,127,127,0.28)',
      },
      moliAdvItem: { display: 'flex', flexDirection: 'column', gap: '4px' },
      // 数字字段（滑条 + 数值框）：滑条占满左半，末尾数值框固定宽度，右侧带单位。
      numberRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      numberRange: { flex: '1 1 auto', minWidth: '120px', accentColor: 'var(--dsw-alias-brand-primary, #4a90d9)', cursor: 'pointer' },
      numberValue: {
        // 行高必须显式给：行高是对齐用的，只设 fontSize 会让数字贴着输入框上沿。
        fontSize: '13px', lineHeight: '20px', height: '32px', padding: '0 8px',
        borderRadius: '6px', width: '96px', flex: '0 0 auto', boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.06)', color: 'inherit',
      },
      numberUnit: { fontSize: '12px', lineHeight: '20px', opacity: 0.65, flex: '0 0 auto', minWidth: '28px' },
      // 时刻选择器要宽一些：time 输入框里还要放小时/分钟分隔符与上下箭头，96px 会挤。
      clockInput: {
        fontSize: '13px', lineHeight: '20px', height: '32px', padding: '0 8px',
        borderRadius: '6px', width: '128px', flex: '0 0 auto', boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.06)', color: 'inherit',
      },
      moliLink: { color: 'var(--dsw-alias-brand-primary, #4a90d9)', textDecoration: 'underline', cursor: 'pointer' },
      moliForced: { fontSize: '12px', color: '#d9534f', lineHeight: 1.5 },
      // 「表情包图库」卡片：状态区（目录/张数/系列/进度）
      stickerStats: {
        display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 10px', borderRadius: '8px',
        border: '1px dashed rgba(127,127,127,0.28)', background: 'rgba(127,127,127,0.06)',
      },
      stickerKv: { fontSize: '12px', lineHeight: 1.6, opacity: 0.85, wordBreak: 'break-all' },
      buttonGhostDisabled: {
        fontSize: '13px', padding: '6px 12px', borderRadius: '6px', cursor: 'not-allowed',
        border: '1px solid rgba(127,127,127,0.2)', background: 'transparent', color: 'inherit', opacity: 0.5,
      },
    };

    // --------------------------------------------------------------- 界面组件

    function QQBotSection(props) {
      var loadConfig = props.loadConfig;
      var saveConfig = props.saveConfig;
      var loadDefaults = props.loadDefaults;
      var loadTemplate = props.loadTemplate;
      var loadModelCatalog = props.loadModelCatalog;

      // 顶部标签：连接 / 基本 / 能力 / 高级。切标签只换视图，不改数据、不触发读写。
      var tabHook = React.useState(GROUPS.length > 0 ? GROUPS[0].id : 'connection');
      var tab = tabHook[0];
      var setTab = tabHook[1];

      // 二级标签：按主标签分别记忆当前选中的子分组（{ basic: 'access', capability: 'vision' }）。
      var subTabHook = React.useState({});
      var subTabMap = subTabHook[0];
      var setSubTabMap = subTabHook[1];

      var subs = SUBGROUPS_BY_TAB[tab] || null;
      var subTab = (subs !== null && subTabMap !== null && typeof subTabMap[tab] === 'string' && subTabMap[tab] !== '')
        ? subTabMap[tab]
        : (subs === null ? '' : subs[0].id);

      var setSubTab = React.useCallback(function (id) {
        setSubTabMap(function (current) {
          var next = Object.assign({}, (current === null || current === undefined) ? {} : current);
          next[tab] = id;
          return next;
        });
      }, [tab]);

      var stateHook = React.useState({ phase: 'loading', error: null, value: null, revision: undefined, secrets: [] });
      var state = stateHook[0];
      var setState = stateHook[1];

      var draftHook = React.useState(null);
      var draft = draftHook[0];
      var setDraft = draftHook[1];

      var noticeHook = React.useState('');
      var notice = noticeHook[0];
      var setNoticeRaw = noticeHook[1];
      // 提示分三级（neutral / ok / error）：保存失败必须一眼能看见，不能和「已保存」同样灰字。
      var noticeLevelHook = React.useState('neutral');
      var noticeLevel = noticeLevelHook[0];
      var setNoticeLevel = noticeLevelHook[1];
      var setNotice = React.useCallback(function (text) {
        setNoticeRaw(text);
        // 文案能直接判定的先按语义分级，调用方也可显式覆盖（见 setNoticeAs）。
        if (text === '') setNoticeLevel('neutral');
        else if (String(text).indexOf('失败') >= 0 || String(text).indexOf('不合法') >= 0 || String(text).indexOf('找不到') >= 0) setNoticeLevel('error');
        else if (String(text).indexOf('已保存') >= 0) setNoticeLevel('ok');
        else setNoticeLevel('neutral');
      }, [setNoticeRaw, setNoticeLevel]);
      var setNoticeAs = React.useCallback(function (level, text) {
        setNoticeRaw(text);
        setNoticeLevel(level);
      }, [setNoticeRaw, setNoticeLevel]);

      var savingHook = React.useState(false);
      var saving = savingHook[0];
      var setSaving = savingHook[1];
      // 「一键还原默认」：默认值取一次缓存住（ref，不触发重渲染）；restoring 只用于禁用按钮。
      var defaultsHook = React.useRef(null);
      var restoringHook = React.useState(false);
      var restoring = restoringHook[0];
      var setRestoring = restoringHook[1];

      var reload = React.useCallback(function () {
        setState({ phase: 'loading', error: null, value: null, revision: undefined, secrets: [] });
        var templatePending = (typeof loadTemplate === 'function')
          ? Promise.resolve(loadTemplate())
          : Promise.resolve({ ok: false, error: '这个版本的插件没有提供设置页模板接口' });
        return Promise.all([Promise.resolve(loadConfig()), templatePending]).then(function (results) {
          var result = results[0];
          var template = results[1];
          // 模板必须比配置先落地：没有字段就没有表单，界面会是一片空白。
          // 所以模板失败要明确报出来，而不是渲染空表单让人以为「配置全没了」。
          if (template === null || template === undefined || template.ok !== true) {
            setState({
              phase: 'error',
              error: '读不到设置页模板：' + ((template && template.error) || '未知原因') + '（前端与插件版本不一致？重启 DSH 后再试）',
              value: null, revision: undefined, secrets: [],
            });
            return;
          }
          applyTemplate(template.value);
          if (result !== null && result !== undefined && result.ok === true) {
            setState({ phase: 'ready', error: null, value: result.value, revision: result.revision, secrets: result.secrets || [] });
            setDraft(JSON.parse(JSON.stringify(result.value === null || result.value === undefined ? {} : result.value)));
          } else {
            setState({ phase: 'error', error: (result && result.error) || '读取设置失败', value: null, revision: undefined, secrets: [] });
          }
        }, function (error) {
          setState({ phase: 'error', error: messageOf(error), value: null, revision: undefined, secrets: [] });
        });
      }, [loadConfig, loadTemplate]);

      React.useEffect(function () { void reload(); }, [reload]);

      // 模型目录（官方 API / 登录账号 / 自定义 providers），供视觉 provider/model 下拉。
      var catalogHook = React.useState(null);
      var catalog = catalogHook[0];
      var setCatalog = catalogHook[1];

      var loadCatalog = React.useCallback(function () {
        if (typeof loadModelCatalog !== 'function') { setCatalog(null); return undefined; }
        setCatalog({ phase: 'loading' });
        return Promise.resolve(loadModelCatalog()).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            setCatalog({ phase: 'ready', groups: (result.value && Array.isArray(result.value.groups)) ? result.value.groups : [] });
          } else {
            setCatalog({ phase: 'error', error: (result && result.error) || '读取模型目录失败' });
          }
        }, function (error) { setCatalog({ phase: 'error', error: messageOf(error) }); });
      }, [loadModelCatalog]);

      React.useEffect(function () { void loadCatalog(); }, [loadCatalog]);

      // Moli 引擎检测：打开面板先自动跑一次；卡片上的「检测」按钮可以手动刷新。
      // advanced 是卡片里「高级设置」的折叠状态，检测刷新时保持不变。
      // advanced = 「高级设置」是否展开；stickerAdvanced = 表情包卡片的参数区是否展开。
      // 两个折叠状态都放在这一份 state 里（而不是各开一个 useState）：
      // 测试桩的 useState 是位置式的，多开一个 hook 会把后面所有组件的位置顶乱。
      var moliHook = React.useState({ phase: 'checking', advanced: false, stickerAdvanced: false });
      var moliState = moliHook[0];
      var setMoliState = moliHook[1];
      // 闸门区：默认锁定；填满 6 位码解锁；保存成功后重新锁上（离开页面随组件销毁，什么都不留）。
      // gateUnlocked=false 表示锁定（默认）；填满 6 位码才置 true；保存成功后复位 false。
      var gateLockHook = React.useState(false);
      var gateUnlocked = gateLockHook[0];
      var setGateUnlocked = gateLockHook[1];
      var probeMoli = props.probeMoli;
      var keepAdvanced = function (current) { return current !== null && current !== undefined && current.advanced === true; };
      var keepStickerAdvanced = function (current) { return current !== null && current !== undefined && current.stickerAdvanced === true; };
      var runMoliProbe = React.useCallback(function () {
        if (typeof probeMoli !== 'function') {
          setMoliState({ phase: 'error', error: '注入面没有检测能力（Host 侧插件版本过旧）', advanced: false, stickerAdvanced: false });
          return undefined;
        }
        setMoliState(function (current) { return { phase: 'checking', advanced: keepAdvanced(current), stickerAdvanced: keepStickerAdvanced(current) }; });
        return Promise.resolve(probeMoli()).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            var info = (result.value === null || result.value === undefined) ? { installed: false, engineState: '' } : result.value;
            setMoliState(function (current) { return { phase: 'ready', value: info, advanced: keepAdvanced(current), stickerAdvanced: keepStickerAdvanced(current) }; });
          } else {
            setMoliState(function (current) { return { phase: 'error', error: (result && result.error) || '检测失败', advanced: keepAdvanced(current), stickerAdvanced: keepStickerAdvanced(current) }; });
          }
        }, function (error) { setMoliState(function (current) { return { phase: 'error', error: messageOf(error), advanced: keepAdvanced(current), stickerAdvanced: keepStickerAdvanced(current) }; }); });
      }, [probeMoli]);

      React.useEffect(function () { void runMoliProbe(); }, [runMoliProbe]);

      var toggleMoliAdvanced = React.useCallback(function () {
        setMoliState(function (current) {
          var base = (current === null || current === undefined) ? { phase: 'idle' } : current;
          return Object.assign({}, base, { advanced: !(base.advanced === true) });
        });
      }, []);

      var toggleStickerAdvanced = React.useCallback(function () {
        setMoliState(function (current) {
          var base = (current === null || current === undefined) ? { phase: 'idle' } : current;
          return Object.assign({}, base, { stickerAdvanced: !(base.stickerAdvanced === true) });
        });
      }, []);

      var updateField = React.useCallback(function (path, value) {
        setDraft(function (current) { return setPath(current === null ? {} : current, path, value); });
        setNotice('');
      }, []);

      // 引擎不可用时把 draft 上的开关强制写回 false：保存时才真正落盘，
      // 避免「界面上关着、配置里开着」的假象。填了引擎路径则视为用户自己负责。
      React.useEffect(function () {
        if (moliState.phase !== 'ready') return;
        var info = moliState.value || {};
        var customExe = String(getPath(draft, ['moli', 'exePath']) || '').trim() !== '';
        var usable = info.engineState === 'installed' || customExe === true
          || (info.installed === true && (info.engineState === undefined || info.engineState === ''));
        if (usable === true) return;
        if (draft !== null && getPath(draft, ['moli', 'enabled']) === true) updateField(['moli', 'enabled'], false);
      }, [moliState, draft, updateField]);

      var save = React.useCallback(function () {
        if (draft === null) return undefined;
        setSaving(true);
        setNotice('');
        // 秘密字段是只写的：读回来的值里没有它，所以只有用户真的敲了新值才提交，
        // 否则会把 access_token 清空。
        var secretPaths = {};
        var secretList = state.secrets || [];
        for (var si = 0; si < secretList.length; si += 1) {
          if (secretList[si] && Array.isArray(secretList[si].path)) secretPaths[secretList[si].path.join(".")] = true;
        }
        var ops = [];
        // moli 卡片「高级设置」那几项（exePath / proxy / defaultTimeoutMs / maxChars / insecureTls
        // / guardProxy / allowGuest / rateLimitPerMin / maxConcurrentRenders）
        // 不在 FIELDS 里，是卡片内部独立的字段集。以前保存只看 FIELDS，于是界面能改、
        // 保存却永远「没有改动」——改了个寂寞。这里把两套合并后再比对。
        var allFields = ALL_FIELDS;
        // 纯数字名单的最后一道闸：界面上已经敲不进非法字符，但粘贴、程序化改 draft、
        // 旧配置里带进来的脏值都还可能漏过来，这里统一拦下，不写进配置。
        var badLists = [];
        for (var bi = 0; bi < allFields.length; bi += 1) {
          var bf = allFields[bi];
          if (bf.kind !== 'list' || bf.numeric !== true) continue;
          var bBad = numericListProblems(getPath(draft, bf.path));
          if (bBad.length > 0) badLists.push(bf.label + '：' + bBad.join('、'));
        }
        if (badLists.length > 0) {
          setSaving(false);
          setNotice('这些名单里有不合法的项（应为 5–12 位纯数字），先改好再保存：' + badLists.join('；'));
          return undefined;
        }
        for (var i = 0; i < allFields.length; i += 1) {
          var field = allFields[i];
          var before = getPath(state.value, field.path);
          var after = getPath(draft, field.path);
          // 纯数字名单统一格式化成「123, 456」再比对/落盘，避免「只差一个空格」也被当成改动。
          if (field.kind === 'list' && field.numeric === true) {
            after = splitList(Array.isArray(after) ? after.join(',') : after, true);
            before = splitList(Array.isArray(before) ? before.join(',') : before, true);
          }
          // 时段字段同样归一化：丢掉解析不出来的段、空段与多余空白；全空 = 不设免打扰（[]）。
          // 以前是自由文本，填了空格或删空就原样送去校验，服务端直接拒。
          if (field.kind === 'clocks') {
            after = clockListProblems(after).clean;
            before = clockListProblems(before).clean;
          }
          if (secretPaths[field.path.join(".")] === true) {
            if (typeof after !== "string" || after === "") continue;
          }
          if (!sameValue(before, after)) {
            ops.push({ op: 'set', path: field.path, value: after === undefined ? null : after });
          }
        }
        if (ops.length === 0) {
          setSaving(false);
          setNotice('没有改动');
          return undefined;
        }
        // 闸门区：动态码开着时改名单、或动「流程授权」开关本身，都必须带一次 6 位码；
        // 带着码保存才算消费。关掉闸门比改名单更狠，不能更容易。
        var flowOn = getPath(draft, ['flowAuth', 'enabled']) === true;
        var gatedChanged = sameValue(getPath(state.value, ['flowAuth', 'gatedTools']), getPath(draft, ['flowAuth', 'gatedTools'])) === false;
        var enabledChanged = sameValue(getPath(state.value, ['flowAuth', 'enabled']), getPath(draft, ['flowAuth', 'enabled'])) === false;
        var gateCode = String(getPath(draft, ['flowAuth', 'gateEditCode']) || '').trim();
        if ((enabledChanged === true || (flowOn === true && gatedChanged === true)) && /^\d{6}$/.test(gateCode) !== true) {
          setSaving(false);
          setNotice(enabledChanged === true
            ? '改「流程授权」开关也要一次码：先在「高级 → 闸门区」的「改名单用的动态码」里填当前 6 位码再保存'
            : '闸门名单已锁定：先在「改名单用的动态码」里填一次 6 位码再保存（不保存不生效）');
          return undefined;
        }
        return Promise.resolve(saveConfig(ops, state.revision)).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            // 码是一次性的：保存成功即重新上锁，并把输入框里的码清掉（服务端也会清）。
            setGateUnlocked(false);
            updateField(['flowAuth', 'gateEditCode'], '');
            setNoticeAs('ok', '已保存');
            setSaving(false);
            return reload();
          }
          setSaving(false);
          setNoticeAs('error', '保存失败：' + ((result && result.error) || '未知错误'));
          return undefined;
        }, function (error) {
          setSaving(false);
          setNoticeAs('error', '保存失败：' + messageOf(error));
          return undefined;
        });
      }, [draft, state.value, state.revision, saveConfig, reload]);

      // ------------------------------------------------------------ 一键还原默认（仅本页）
      // 只改 draft，不写盘：真正落盘仍然要点「保存」，所以还原绕不过保存时的动态码校验，
      // 也不会出现「点一下按钮配置就变了」的意外。
      //
      // **密钥字段一律不碰**。这些框的界面语义是「已设置；留空则保持不变」：读回来的值里本来
      // 就没有密钥，若把默认值（空串）写进 draft，保存时会被当成「没填新值」而跳过——旧密钥
      // 原样留着，用户却以为还原过了，这就是假还原。所以干脆不还原它们，并在提示里说清楚。
      var restorePageDefaults = React.useCallback(function () {
        if (draft === null) return undefined;
        var cached = defaultsHook.current;
        var pending = (cached !== null) ? Promise.resolve({ ok: true, value: cached }) : loadDefaults();
        setRestoring(true);
        setNotice('');
        return Promise.resolve(pending).then(function (result) {
          setRestoring(false);
          if (result === null || result === undefined || result.ok !== true) {
            setNotice('读不到默认值：' + ((result && result.error) || '未知原因') + '（可以先手动改，或检查插件路由是否挂上）');
            return undefined;
          }
          var defaults = result.value;
          defaultsHook.current = defaults;
          var secretPaths = {};
          var secretList = state.secrets || [];
          for (var si = 0; si < secretList.length; si += 1) {
            if (secretList[si] && Array.isArray(secretList[si].path)) secretPaths[secretList[si].path.join('.')] = true;
          }
          var next = draft;
          var touched = 0;
          var skippedSecrets = 0;
          var pageFields = ALL_FIELDS;
          for (var i = 0; i < pageFields.length; i += 1) {
            var field = pageFields[i];
            // 只还原「这一页看得见」的字段：主标签 + 二级标签 + when 条件，三道都和渲染时一致。
            if (groupOf(field) !== tab) continue;
            if (subs !== null) {
              var fieldSub = subGroupOf(field);
              if (fieldSub !== undefined && fieldSub !== subTab) continue;
            }
            if (fieldVisible(field, draft) !== true) continue;
            var fallback = getPath(defaults, field.path);
            if (fallback === undefined) continue;
            if (secretPaths[field.path.join('.')] === true) { skippedSecrets += 1; continue; }
            next = setPath(next, field.path, JSON.parse(JSON.stringify(fallback)));
            touched += 1;
          }
          setDraft(next);
          if (touched === 0 && skippedSecrets === 0) {
            setNotice('这一页没有可还原的字段');
          } else if (touched === 0) {
            setNotice('这一页只有密钥类字段，它们不会被还原（留空 = 保持不变）。要换密钥请直接输入新值');
          } else {
            setNotice('已还原本页 ' + touched + ' 项的默认值（未保存，点「保存」才生效）'
              + (skippedSecrets > 0 ? '；' + skippedSecrets + ' 个密钥类字段未动（留空 = 保持不变）' : ''));
          }
          return undefined;
        }, function (error) {
          setRestoring(false);
          setNotice('读不到默认值：' + messageOf(error));
          return undefined;
        });
      }, [draft, tab, subTab, subs, state.secrets, loadDefaults]);

      if (state.phase === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取设置…'));
      }

      if (state.phase === 'error') {
        return h('div', { style: S.wrap },
          h('div', { style: S.error }, state.error),
          h('div', { style: S.hint }, '如果提示命名空间未注册，说明 Host 侧插件没加载成功。'),
          h('div', { style: S.actions }, h('button', { style: S.button, onClick: reload }, '重试')),
        );
      }

      var rows = [];
      for (var index = 0; index < FIELDS.length; index += 1) {
        var field = FIELDS[index];
        if (groupOf(field) !== tab) continue;                 // 只渲染当前标签的字段
        if (subs !== null) {
          var fieldSub = subGroupOf(field);
          // 有二级分组时再筛一层；未归类的字段在每个二级标签下都显示。
          if (fieldSub !== undefined && fieldSub !== subTab) continue;
        }
        if (fieldVisible(field, draft) !== true) continue;
        var fieldKey = field.path.join('.');
        var isSecret = false;
        // secrets 里每一项都带 set：DSH 的 walk() 对 role(secret) 字段一律登记，
        // set = 值是否存在。所以「是不是密钥字段」看有没有这条，「配没配过」看 set。
        var secretSet = false;
        var totpSecretSet = false;
        for (var si2 = 0; si2 < (state.secrets || []).length; si2 += 1) {
          var entry = (state.secrets || [])[si2];
          if (!entry || !Array.isArray(entry.path)) continue;
          var secretKey = entry.path.join('.');
          if (secretKey === fieldKey) { isSecret = true; secretSet = entry.set === true; }
          // 这里以前只判断「条目存在」，而 secrets 里每个 secret 字段都会登记一条（含 set:false）。
          // 结果：没配过密钥时也显示「密钥已经配置好了」，按钮还被禁用。必须看 set。
          if (secretKey === 'flowAuth.totpSecret') totpSecretSet = entry.set === true;
        }
        // 闸门区：动态码开着、还没解锁时，名单只读（填码即解锁；保存成功后会重新锁上）。
        var gateLocked = gateUnlocked !== true && getPath(draft, ['flowAuth', 'enabled']) === true
          && fieldKey === 'flowAuth.gatedTools';
        rows.push(renderField(field, getPath(draft, field.path), updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, toggleStickerAdvanced, {
          locked: gateLocked,
          secretSet: secretSet,
          onGateCode: function (value) {
            updateField(['flowAuth', 'gateEditCode'], value);
            if (/^\d{6}$/.test(String(value || ''))) setGateUnlocked(true);
          },
        }));
      }

      var currentGroup = null;
      for (var gi = 0; gi < GROUPS.length; gi += 1) {
        if (GROUPS[gi].id === tab) { currentGroup = GROUPS[gi]; break; }
      }

      // 二级标签（有二级分组的主标签才出现；常驻在主标签条下方，不随内容滚动）
      var currentSub = null;
      var subTabBar = null;
      if (subs !== null) {
        for (var si = 0; si < subs.length; si += 1) {
          if (subs[si].id === subTab) { currentSub = subs[si]; break; }
        }
        subTabBar = h('div', { style: S.subTabBar, role: 'tablist', 'aria-label': '二级分组' },
          subs.map(function (group) {
            var active = group.id === subTab;
            return h('button', {
              key: group.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active ? 'true' : 'false',
              'data-subtab': group.id,
              style: active ? S.subTabActive : S.subTab,
              onClick: function () { setSubTab(group.id); },
            }, group.label);
          }));
      }

      // 说明文字跟着当前二级组走
      var activeHint = currentSub !== null
        ? currentSub.hint
        : (currentGroup === null ? '' : currentGroup.hint);

      var tabBar = GROUPS.map(function (group) {
        var active = group.id === tab;
        return h('button', {
          key: group.id,
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          'data-tab': group.id,
          style: active ? S.tabActive : S.tab,
          onClick: function () { setTab(group.id); },
        }, group.label);
      });

      return h('div', { style: S.shell },
        // 顶端标签（仿 dsh-service 设置顶端的切换条）
        h('div', { style: S.tabBar, role: 'tablist' }, tabBar),
        // 有新版本时显示提示（模板里没有 update 时组件返回 null，不占位）
        h(UpdateNotice),
        // 当前主标签的二级标签条（常驻在主标签条下方，无二级分组时为 null）
        subTabBar,
        // 可滚动主体：只显示当前标签（+ 当前二级标签）下的字段
        h('div', { style: S.body },
          activeHint === '' ? null : h('div', { style: S.groupHint }, activeHint),
          rows.length === 0 ? h('div', { style: S.hint }, '这一组暂时没有可配置项。') : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, rows),
        ),
        // 常驻底栏：保存 / 还原本页默认 / 重新读取（切标签时始终可见）
        h('div', { style: S.footer },
          h('button', { style: S.button, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', {
            style: S.buttonGhost,
            onClick: restorePageDefaults,
            disabled: saving || restoring || draft === null,
            title: '把当前这一页的字段改回默认值（只改界面，点「保存」才写进配置；密钥类字段不动）',
          }, restoring ? '还原中…' : '还原本页默认'),
          h('button', { style: S.buttonGhost, onClick: reload, disabled: saving }, '重新读取'),
          notice === '' ? null : h('span', {
            style: noticeLevel === 'ok' ? S.noticeOk : (noticeLevel === 'error' ? S.noticeError : S.notice),
            'data-notice-level': noticeLevel,
          }, notice),
          h('span', { style: S.hint },
            '连接方式（协议/模式/地址/token）改动会自动重启适配器，其它改动对下一条消息生效；',
            '状态可让 Agent 调 qqbot 工具（action=status）查看。'),
        ),
      );
    }

    // 列表字段（群号白名单等）必须用本地 draft 文本编辑：
    // 直接把 value 渲染成 array.join(', ') 会让 React 每次按键都复位输入框，
    // 用户刚敲的分隔符当场消失，多值根本填不进去。
    var LIST_SPLIT = /[,\uFF0C\u3001;\uFF1B\s]+/;

    // 纯数字名单（QQ 号 / 群号）：只放行数字与分隔符，逐项要求 5–12 位，失焦/保存后统一成「123, 456」。
    // 以前任何字符都能填进去、保存也不拦，填错了只有等到消息被静默丢弃才发现。
    //
    // 「只能输数字」和「可以输多个值」是两件事，别再揉成一个开关：
    //   numeric: true   → 多值名单，逗号/顿号/分号/空白都算分隔符（群号白名单这类）
    //   digitsOnly: true → 单值纯数字，连分隔符都不该出现（6 位动态码这类）
    // 以前只有一个开关，结果单值字段也能敲逗号进去。
    var NUMERIC_ITEM_RE = /^\d{5,12}$/;
    var DIGITS_ONLY_STRIP = /[^\d]/g;
    var NUMERIC_LIST_STRIP = /[^\d,\uFF0C\u3001;\uFF1B\s]/g;

    function splitList(text, numeric) {
      var source = String(text === undefined || text === null ? '' : text);
      if (numeric === true) source = source.replace(NUMERIC_LIST_STRIP, '');
      var raw = source.split(LIST_SPLIT);
      var out = [];
      for (var i = 0; i < raw.length; i += 1) {
        var item = raw[i].trim();
        if (item !== '') out.push(item);
      }
      return out;
    }

    /** 纯数字名单里不合规的项（空数组 = 全部合规）。 */
    function numericListProblems(items) {
      var bad = [];
      if (!Array.isArray(items)) return bad;
      for (var i = 0; i < items.length; i += 1) {
        var item = String(items[i] === undefined || items[i] === null ? '' : items[i]).trim();
        if (item === '') continue;
        if (NUMERIC_ITEM_RE.test(item) !== true) bad.push(item);
      }
      return bad;
    }

    /**
     * 时段名单归一化：返回 { clean, bad }。
     *   clean —— 只留下能解析的段，统一成 HH:MM-HH:MM；空段丢弃（删空 = 不设免打扰）。
     *   bad   —— 解析不出来的脏值（理论上界面已经敲不出来，这里兜旧配置与程序化写入）。
     */
    function clockListProblems(items) {
      var clean = [];
      var bad = [];
      var list = Array.isArray(items) ? items : [];
      for (var i = 0; i < list.length; i += 1) {
        var text = String(list[i] === undefined || list[i] === null ? '' : list[i]).trim();
        if (text === '') continue;
        var m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text);
        if (m === null) { bad.push(text); continue; }
        var sh = Number(m[1]); var sm = Number(m[2]); var eh = Number(m[3]); var em = Number(m[4]);
        if (sh > 23 || eh > 23 || sm > 59 || em > 59) { bad.push(text); continue; }
        clean.push(clockText(sh, sm) + '-' + clockText(eh, em));
      }
      return { clean: clean, bad: bad };
    }

    // ---------------------------------------------------------- 新版本提示横幅
    // 数据来自 GET /dsh-qq-bot/settings 的 update 字段（lib/gateway/routes-settings.js）；
    // 只展示、不提供一键升级——升级动作留给用户自己（npm/插件页）。
    function UpdateNotice() {
      var info = UPDATE_INFO;
      if (info === null || info.hasUpdate !== true) return null;
      var target = String(info.latest || '');
      var compat = info.compatible === true ? '' : '（该版本声明的 DSH 范围与当前运行时不一致）';
      return h('div', { style: S.updateNotice },
        '发现新版本 v' + target + '（当前 ' + String(info.current || '') + '）' + compat
        + '　升级：dsh plugin --profile <profile> add @sputnikzaychik/dsh-qq-bot@' + target + '，然后重启。');
    }
    // ---------------------------------------------------------- 数字字段（滑条 + 可手填数值框）
    // 带 slider 声明的数字字段渲染成「横条拖动 + 末尾数值框」：
    //   - 滑条负责快速调，数值框负责精确填（单位写在框右边）；
    //   - 数值框过滤非法字符（空格、字母、全角数字都敲不进去），失焦/回车时按 min/max 夹紧；
    //   - 拖条与手填改的是同一个 draft 值，谁动都能立刻同步。
    // ---------------------------------------------------------- 时段字段（免打扰时段）
    // 值形如 ["23:00-08:00"]。界面上每段渲染成两个 <input type="time">，
    // 彻底不用手打字符串，就不会出现「填了空格 / 删空后保存」这类非法值。
    // 内部仍按 "HH:MM-HH:MM" 存，与服务端 owner-settings 的 clocks 校验、proactive 的解析保持一致。
    var CLOCK_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
    function pad2(n) { return (n < 10 ? '0' : '') + String(n); }
    function clockText(hh, mm) { return pad2(Number(hh) || 0) + ':' + pad2(Number(mm) || 0); }
    /** "23:00-08:00" → { start: "23:00", end: "08:00" }；解析失败返回 null。 */
    function splitRange(text) {
      var m = CLOCK_RE.exec(String(text === undefined || text === null ? '' : text).trim());
      if (m === null) return null;
      var sh = Number(m[1]); var sm = Number(m[2]); var eh = Number(m[3]); var em = Number(m[4]);
      if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
      return { start: clockText(sh, sm), end: clockText(eh, em) };
    }
    function ClockRanges(props) {
      var field = props.field;
      var updateField = props.updateField;
      var locked = props.locked === true;
      var list = Array.isArray(props.value) ? props.value : [];
      // 解析不出结构的脏值先丢掉，免得界面上显示成空白却还在配置里。
      var ranges = [];
      for (var i = 0; i < list.length; i += 1) {
        var r = splitRange(list[i]);
        if (r !== null) ranges.push(r);
      }
      // 至少要有一段可编辑；多了给删按钮。
      if (ranges.length === 0) ranges = [{ start: '23:00', end: '08:00' }];
      function commit(next) {
        updateField(field.path, next.map(function (item) { return item.start + '-' + item.end; }));
      }
      function setBound(index, key, text) {
        var next = ranges.map(function (item, idx) {
          return idx === index ? Object.assign({}, item, (key === 'start' ? { start: text } : { end: text })) : item;
        });
        commit(next);
      }
      var rows = ranges.map(function (item, index) {
        return h('div', { key: 'range-' + index, style: S.numberRow, 'data-clock-row': '1' },
          h('input', {
            type: 'time', style: S.clockInput, disabled: locked === true, value: item.start,
            onChange: function (event) { setBound(index, 'start', event.target.value || item.start); },
          }),
          h('span', { key: 'dash', style: S.numberUnit }, '→'),
          h('input', {
            type: 'time', style: S.clockInput, disabled: locked === true, value: item.end,
            onChange: function (event) { setBound(index, 'end', event.target.value || item.end); },
          }),
          ranges.length > 1
            ? h('button', {
              key: 'del', type: 'button', style: S.buttonGhost, disabled: locked === true,
              onClick: function () { commit(ranges.filter(function (_x, idx) { return idx !== index; })); },
            }, '删除')
            : null,
        );
      });
      var children = rows;
      if (locked !== true) {
        children.push(h('button', {
          key: 'add', type: 'button', style: S.buttonGhost,
          onClick: function () { commit(ranges.concat([{ start: '23:00', end: '08:00' }])); },
        }, '+ 加一段'));
      }
      return h('div', { style: S.moliAdvItem, 'data-clocks': '1' }, children);
    }

    function NumberField(props) {
      var field = props.field;
      var updateField = props.updateField;
      var locked = props.locked === true;
      var value = props.value;
      var hasSlider = field.slider === true && typeof field.min === 'number' && typeof field.max === 'number' && field.max > field.min;
      var lo = hasSlider === true ? Number(field.min) : 0;
      var hi = hasSlider === true ? Number(field.max) : 0;
      var step = (typeof field.step === 'number' && field.step > 0) ? Number(field.step) : 1;
      var unit = typeof field.unit === 'string' ? field.unit : '';
      var current = value === undefined || value === null || value === '' ? '' : String(value);
      var textHook = React.useState(current);
      var text = textHook[0];
      var setText = textHook[1];
      var committedHook = React.useRef(current);
      React.useEffect(function () {
        if (committedHook.current !== current) {
          committedHook.current = current;
          setText(current);
        }
      }, [current]);
      // 输入过程只做「非法字符敲不进去」，合法但越界的值等失焦再夹。
      function normalize(raw) {
        var clean = String(raw).replace(/[^\d.+-]/g, '');
        var parsed = Number(clean);
        if (clean === '' || clean === '-' || Number.isFinite(parsed) !== true) return 0;
        var clamped = parsed;
        if (hasSlider === true) {
          if (clamped < lo) clamped = lo;
          if (clamped > hi) clamped = hi;
        }
        return clamped;
      }
      function commit(raw) {
        var next = normalize(raw);
        committedHook.current = String(next);
        setText(Number.isInteger(next) ? String(next) : String(next));
        updateField(field.path, next);
      }
      function onChange(event) {
        var raw = event.target.value;
        // 硬过滤：空白、字母、全角数字都不让进，省得填完才发现保存报错。
        var filtered = raw.replace(/[^\d.+-]/g, '');
        // 只允许一个前导负号（min >= 0 的字段干脆不认负号）。
        if (filtered.indexOf('-') > 0 || (hasSlider === true && lo >= 0)) filtered = filtered.replace(/[-]/g, '');
        setText(filtered);
        var parsed = Number(filtered);
        if (filtered !== '' && filtered !== '-' && Number.isFinite(parsed) === true) {
          committedHook.current = String(parsed);
          updateField(field.path, parsed);
        }
      }
      function onBlur() {
        if (text.trim() === '') { commit(String(lo)); return; }
        commit(text);
      }
      // 同一行：左边数值输入框（可精确手填），右边横条滑块（拖动快速调），单位跟在输入框后面。
      // 注意顺序：先 push 输入框再 push 滑块，浏览器里就是「输入框在左、滑块在右」。
      var children = [];
      children.push(h('input', {
        key: 'value',
        type: 'text',
        inputMode: hasSlider === true ? 'decimal' : 'numeric',
        style: S.numberValue,
        disabled: locked === true,
        value: text,
        onChange: onChange,
        onBlur: onBlur,
        onKeyDown: function (event) {
          if (event.key === 'Enter') { event.preventDefault(); commit(text); }
        },
      }));
      if (unit !== '') children.push(h('span', { key: 'unit', style: S.numberUnit }, unit));
      if (hasSlider === true) {
        children.push(h('input', {
          key: 'range',
          type: 'range',
          style: S.numberRange,
          min: lo,
          max: hi,
          step: step,
          disabled: locked === true,
          value: current === '' ? lo : String(Math.min(hi, Math.max(lo, Number(current)))),
          onChange: function (event) {
            var next = Number(event.target.value);
            if (Number.isFinite(next) !== true) return;
            committedHook.current = String(next);
            setText(String(next));
            updateField(field.path, next);
          },
        }));
      }
      return h('div', { key: field.path.join('.'), style: S.numberRow, 'data-number-field': hasSlider === true ? 'slider' : 'plain' }, children);
    }

    function ListInput(props) {
      var field = props.field;
      var updateField = props.updateField;
      var numeric = field.numeric === true;
      var canonical = Array.isArray(props.value) ? props.value.join(', ') : '';
      var textHook = React.useState(canonical);
      var text = textHook[0];
      var setText = textHook[1];
      var committedHook = React.useRef(canonical);
      React.useEffect(function () {
        if (committedHook.current !== canonical) {
          committedHook.current = canonical;
          setText(canonical);
        }
      }, [canonical]);
      // 不做行内报错：一旦把 input 包进 div，React 会把 input 当成新节点重挂载，
      // 光标和焦点当场丢掉——输到一半的号码根本没法接着敲。校验放到保存那一步做，
      // 输入过程只做「敲不进非法字符」这一件事。
      return h('input', {
        type: 'text',
        inputMode: numeric === true ? 'numeric' : undefined,
        style: S.input,
        disabled: props.locked === true,
        value: text,
        placeholder: field.placeholder || '',
        onChange: function (event) {
          if (props.locked === true) return;
          var next = event.target.value;
          // 硬过滤：非数字非分隔符的字符根本敲不进去，省得填完才发现。
          if (numeric === true) next = next.replace(NUMERIC_LIST_STRIP, '');
          setText(next);
          var parts = splitList(next, numeric);
          committedHook.current = parts.join(', ');
          updateField(field.path, parts);
        },
        onBlur: function () {
          var normalized = splitList(text, numeric).join(', ');
          committedHook.current = normalized;
          setText(normalized);
        },
      });
    }

    // ============================================================ 绑定二维码（浏览器版）
    // 与 lib/tools/qr.js 同一套算法（字节模式 / 纠错等级 M / 版本 1..9）；服务端那份有 test/test-qr.mjs 的
    // 固定向量守着。**浏览器这份没有逐位比对的自动化测试**（评审时用独立解码器人工比过矩阵哈希），
    // 改这里请顺手用手机扫一次二维码确认能绑上。
    /* QR_BUNDLE_START */
    var QR_EXP = new Uint8Array(512);
    var QR_LOG = new Uint8Array(256);
    (function () {
      var x = 1;
      for (var i = 0; i < 255; i += 1) {
        QR_EXP[i] = x;
        QR_LOG[x] = i;
        x <<= 1;
        if ((x & 0x100) !== 0) x ^= 0x11d;
      }
      for (var j = 255; j < 512; j += 1) QR_EXP[j] = QR_EXP[j - 255];
    })();

    function qrMul(a, b) {
      if (a === 0 || b === 0) return 0;
      return QR_EXP[QR_LOG[a] + QR_LOG[b]];
    }

    function qrGenPoly(degree) {
      var poly = [1];
      for (var i = 0; i < degree; i += 1) {
        var next = [];
        for (var k = 0; k < poly.length + 1; k += 1) next.push(0);
        for (var j = 0; j < poly.length; j += 1) {
          next[j] ^= poly[j];
          next[j + 1] ^= qrMul(poly[j], QR_EXP[i]);
        }
        poly = next;
      }
      return poly;
    }

    function qrRemainder(data, ecLength) {
      var gen = qrGenPoly(ecLength);
      var res = [];
      for (var i = 0; i < ecLength; i += 1) res.push(0);
      for (var d = 0; d < data.length; d += 1) {
        var factor = data[d] ^ res[0];
        res.shift();
        res.push(0);
        for (var j = 0; j < ecLength; j += 1) res[j] ^= qrMul(gen[j + 1], factor);
      }
      return res;
    }

    var QR_EC_M = {
      1: { ec: 10, blocks: [[1, 16]] },
      2: { ec: 16, blocks: [[1, 28]] },
      3: { ec: 26, blocks: [[1, 44]] },
      4: { ec: 18, blocks: [[2, 32]] },
      5: { ec: 24, blocks: [[2, 43]] },
      6: { ec: 16, blocks: [[4, 27]] },
      7: { ec: 18, blocks: [[4, 31]] },
      8: { ec: 22, blocks: [[2, 38], [2, 39]] },
      9: { ec: 22, blocks: [[3, 36], [2, 37]] },
    };
    var QR_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46] };

    function qrCapacity(version) {
      var table = QR_EC_M[version];
      var total = 0;
      for (var i = 0; i < table.blocks.length; i += 1) total += table.blocks[i][0] * table.blocks[i][1];
      return total;
    }

    function qrBytes(text) {
      var out = [];
      var encoded = unescape(encodeURIComponent(String(text)));
      for (var i = 0; i < encoded.length; i += 1) out.push(encoded.charCodeAt(i) & 0xff);
      return out;
    }

    function qrChoose(text) {
      var bytes = qrBytes(text);
      for (var version = 1; version <= 9; version += 1) {
        if (4 + 8 + bytes.length * 8 <= qrCapacity(version) * 8) return { version: version, bytes: bytes };
      }
      return { version: 0, bytes: bytes };
    }

    function qrCodewords(bytes, version) {
      var capacityBits = qrCapacity(version) * 8;
      var bits = [];
      function push(value, length) {
        for (var i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
      }
      push(4, 4);
      push(bytes.length, 8);
      for (var b = 0; b < bytes.length; b += 1) push(bytes[b], 8);
      for (var t = 0; t < 4 && bits.length < capacityBits; t += 1) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);
      var words = [];
      for (var i = 0; i < bits.length; i += 8) {
        var byte = 0;
        for (var j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
        words.push(byte);
      }
      var pad = [0xec, 0x11];
      var padIndex = 0;
      while (words.length < capacityBits / 8) {
        words.push(pad[padIndex % 2]);
        padIndex += 1;
      }
      return words;
    }

    function qrInterleave(words, version) {
      var table = QR_EC_M[version];
      var blocks = [];
      var offset = 0;
      for (var i = 0; i < table.blocks.length; i += 1) {
        var count = table.blocks[i][0];
        var len = table.blocks[i][1];
        for (var c = 0; c < count; c += 1) {
          var data = words.slice(offset, offset + len);
          offset += len;
          blocks.push({ data: data, ec: qrRemainder(data, table.ec) });
        }
      }
      var out = [];
      var maxData = 0;
      for (var m = 0; m < blocks.length; m += 1) maxData = Math.max(maxData, blocks[m].data.length);
      for (var d = 0; d < maxData; d += 1) {
        for (var n = 0; n < blocks.length; n += 1) if (d < blocks[n].data.length) out.push(blocks[n].data[d]);
      }
      for (var e = 0; e < table.ec; e += 1) {
        for (var p = 0; p < blocks.length; p += 1) out.push(blocks[p].ec[e]);
      }
      return out;
    }

    function qrFormatBits(mask) {
      var data = mask;   // 纠错等级 M 的指示位是 00
      var value = data << 10;
      for (var i = 14; i >= 10; i -= 1) if (((value >> i) & 1) !== 0) value ^= 0x537 << (i - 10);
      return ((data << 10) | value) ^ 0x5412;
    }

    function qrVersionBits(version) {
      var value = version << 12;
      for (var i = 17; i >= 12; i -= 1) if (((value >> i) & 1) !== 0) value ^= 0x1f25 << (i - 12);
      return (version << 12) | value;
    }

    var QR_MASKS = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
      function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
    ];

    function qrMatrix(version) {
      var size = 17 + 4 * version;
      var modules = [];
      var reserved = [];
      for (var r = 0; r < size; r += 1) {
        var row = [];
        var rrow = [];
        for (var c = 0; c < size; c += 1) { row.push(false); rrow.push(false); }
        modules.push(row);
        reserved.push(rrow);
      }
      function set(rr, cc, dark) {
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) return;
        modules[rr][cc] = dark === true;
        reserved[rr][cc] = true;
      }
      function finder(row0, col0) {
        for (var rr = -1; rr <= 7; rr += 1) {
          for (var cc = -1; cc <= 7; cc += 1) {
            var dark = (rr >= 0 && rr <= 6 && (cc === 0 || cc === 6))
              || (cc >= 0 && cc <= 6 && (rr === 0 || rr === 6))
              || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
            set(row0 + rr, col0 + cc, dark);
          }
        }
      }
      finder(0, 0);
      finder(0, size - 7);
      finder(size - 7, 0);
      for (var i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
      var centers = QR_ALIGN[version];
      for (var a = 0; a < centers.length; a += 1) {
        for (var b = 0; b < centers.length; b += 1) {
          var row = centers[a];
          var col = centers[b];
          if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
          for (var dr = -2; dr <= 2; dr += 1) {
            for (var dc = -2; dc <= 2; dc += 1) {
              set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
            }
          }
        }
      }
      for (var f = 0; f <= 8; f += 1) {
        if (f !== 6) { set(8, f, false); set(f, 8, false); }
      }
      set(8, 8, false);
      for (var g = 0; g < 8; g += 1) set(8, size - 1 - g, false);
      for (var h = 0; h < 7; h += 1) set(size - 1 - h, 8, false);
      set(size - 8, 8, false);
      if (version >= 7) {
        for (var v = 0; v < 18; v += 1) {
          set(Math.floor(v / 3), size - 11 + (v % 3), false);
          set(size - 11 + (v % 3), Math.floor(v / 3), false);
        }
      }
      return { size: size, modules: modules, reserved: reserved };
    }

    function qrPlace(matrix, words) {
      var size = matrix.size;
      var modules = matrix.modules;
      var reserved = matrix.reserved;
      var bits = [];
      for (var i = 0; i < words.length; i += 1) for (var b = 7; b >= 0; b -= 1) bits.push((words[i] >> b) & 1);
      var bitIndex = 0;
      var upward = true;
      for (var right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (var step = 0; step < size; step += 1) {
          var row = upward ? size - 1 - step : step;
          for (var offset = 0; offset < 2; offset += 1) {
            var col = right - offset;
            if (reserved[row][col]) continue;
            modules[row][col] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
            bitIndex += 1;
          }
        }
        upward = !upward;
      }
    }

    function qrApplyMask(matrix, maskIndex) {
      var fn = QR_MASKS[maskIndex];
      for (var r = 0; r < matrix.size; r += 1) {
        for (var c = 0; c < matrix.size; c += 1) {
          if (matrix.reserved[r][c]) continue;
          if (fn(r, c)) matrix.modules[r][c] = !matrix.modules[r][c];
        }
      }
    }

    function qrPutFormat(matrix, maskIndex) {
      var size = matrix.size;
      var modules = matrix.modules;
      var value = qrFormatBits(maskIndex);
      function bit(i) { return ((value >> i) & 1) === 1; }
      for (var i = 0; i < 15; i += 1) {
        var dark = bit(i);
        if (i < 6) modules[i][8] = dark;
        else if (i < 8) modules[i + 1][8] = dark;
        else modules[size - 15 + i][8] = dark;
        if (i < 8) modules[8][size - 1 - i] = dark;
        else if (i === 8) modules[8][7] = dark;
        else modules[8][15 - i - 1] = dark;
      }
      modules[size - 8][8] = true;
    }

    function qrPutVersion(matrix, version) {
      if (version < 7) return;
      var size = matrix.size;
      var value = qrVersionBits(version);
      for (var i = 0; i < 18; i += 1) {
        var dark = ((value >> i) & 1) === 1;
        var row = Math.floor(i / 3);
        var col = size - 11 + (i % 3);
        matrix.modules[row][col] = dark;
        matrix.modules[col][row] = dark;
      }
    }

    function qrPenalty(matrix) {
      var size = matrix.size;
      var modules = matrix.modules;
      var score = 0;
      function runScore(line) {
        var total = 0;
        var run = 1;
        for (var i = 1; i < line.length; i += 1) {
          if (line[i] === line[i - 1]) run += 1;
          else { if (run >= 5) total += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) total += 3 + (run - 5);
        return total;
      }
      for (var r = 0; r < size; r += 1) score += runScore(modules[r]);
      for (var c = 0; c < size; c += 1) {
        var col = [];
        for (var rr = 0; rr < size; rr += 1) col.push(modules[rr][c]);
        score += runScore(col);
      }
      for (var y = 0; y < size - 1; y += 1) {
        for (var x = 0; x < size - 1; x += 1) {
          var v = modules[y][x];
          if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) score += 3;
        }
      }
      var patternA = [true, false, true, true, true, false, true, false, false, false, false];
      var patternB = [false, false, false, false, true, false, true, true, true, false, true];
      function matches(line, at, pattern) {
        for (var i = 0; i < pattern.length; i += 1) if (line[at + i] !== pattern[i]) return false;
        return true;
      }
      for (var row2 = 0; row2 < size; row2 += 1) {
        for (var cc2 = 0; cc2 + 11 <= size; cc2 += 1) {
          if (matches(modules[row2], cc2, patternA)) score += 40;
          if (matches(modules[row2], cc2, patternB)) score += 40;
        }
      }
      for (var cc3 = 0; cc3 < size; cc3 += 1) {
        var line = [];
        for (var rr2 = 0; rr2 < size; rr2 += 1) line.push(modules[rr2][cc3]);
        for (var at = 0; at + 11 <= size; at += 1) {
          if (matches(line, at, patternA)) score += 40;
          if (matches(line, at, patternB)) score += 40;
        }
      }
      var darkCount = 0;
      for (var d1 = 0; d1 < size; d1 += 1) for (var d2 = 0; d2 < size; d2 += 1) if (modules[d1][d2]) darkCount += 1;
      score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10;
      return score;
    }

    function encodeQr(text) {
      var picked = qrChoose(text);
      if (picked.version === 0) throw new Error('内容太长，无法生成二维码');
      var words = qrInterleave(qrCodewords(picked.bytes, picked.version), picked.version);
      var best = null;
      for (var mask = 0; mask < 8; mask += 1) {
        var matrix = qrMatrix(picked.version);
        qrPlace(matrix, words);
        qrApplyMask(matrix, mask);
        qrPutFormat(matrix, mask);
        qrPutVersion(matrix, picked.version);
        var score = qrPenalty(matrix);
        if (best === null || score < best.score) best = { score: score, mask: mask, matrix: matrix };
      }
      return { version: picked.version, size: best.matrix.size, mask: best.mask, modules: best.matrix.modules };
    }
    /* QR_BUNDLE_END */

    var QR_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    function makeTotpSecret() {
      var bytes = new Uint8Array(20);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      var out = '';
      var buffer = 0;
      var bits = 0;
      for (var j = 0; j < bytes.length; j += 1) {
        buffer = (buffer << 8) | bytes[j];
        bits += 8;
        while (bits >= 5) {
          out += QR_BASE32[(buffer >> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) out += QR_BASE32[(buffer << (5 - bits)) & 31];
      return out;
    }

    function otpauthOf(secret) {
      var issuer = 'dsh-qq-bot';
      var label = encodeURIComponent(issuer) + ':' + encodeURIComponent('owner');
      return 'otpauth://totp/' + label + '?secret=' + encodeURIComponent(secret)
        + '&algorithm=SHA1&digits=6&period=30&issuer=' + encodeURIComponent(issuer);
    }

    function qrSvg(uri) {
      var matrix = encodeQr(uri);
      var scale = 4;
      var quiet = 4;
      var dim = (matrix.size + quiet * 2) * scale;
      var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim + '" viewBox="0 0 ' + dim + ' ' + dim + '">'];
      parts.push('<rect width="' + dim + '" height="' + dim + '" fill="#fff"/>');
      for (var r = 0; r < matrix.size; r += 1) {
        for (var c = 0; c < matrix.size; c += 1) {
          if (!matrix.modules[r][c]) continue;
          parts.push('<rect x="' + ((c + quiet) * scale) + '" y="' + ((r + quiet) * scale) + '" width="' + scale + '" height="' + scale + '" fill="#000"/>');
        }
      }
      parts.push('</svg>');
      return parts.join('');
    }
    /** 绑定区：未确认时显示二维码与密钥（只在这一次会话里），确认后只显示绑定时间。 */
    function renderQrBind(field, value, updateField, isSecret, draft, totpSecretSet) {
      var secret = '';
      var raw = (draft !== null && draft !== undefined && draft.flowAuth) ? draft.flowAuth.totpSecret : '';
      if (typeof raw === 'string') secret = raw.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
      var boundAt = Number(value) || 0;
      var children = [h('div', { key: 'label', style: S.label }, field.label)];
      if (boundAt > 0) {
        children.push(h('div', { key: 'bound', style: S.hint }, '已绑定（' + new Date(boundAt).toLocaleString() + '）：二维码与密钥不再展示；解绑请在私聊发 /flow unbind <6位动态码>。'));
        return h('div', { key: field.path.join('.'), style: S.row }, children);
      }
      var hasPlain = /^[A-Z2-7]{16,64}$/.test(secret);
      // 远程读取时 role(secret) 的值会被脱敏成空串，所以「有没有配过」只能看 secrets 标记；
      // 注意本字段的 path 是 enrolledAt，密钥在 flowAuth.totpSecret 上，得单独查一次。
      var hasSecret = hasPlain === true || isSecret === true || totpSecretSet === true;
      if (hasPlain !== true) {
        if (hasSecret === true) {
          children.push(h('div', { key: 'hint', style: S.hint }, '密钥已经配置好了（远程读取会脱敏，这里看不到明文），但还没有确认绑定：用认证器确认能算出码之后，直接点「我已扫码绑定」；不要点「生成密钥」，那会覆盖正在生效的密钥。'));
        } else {
          children.push(h('div', { key: 'hint', style: S.hint }, '还没有可用密钥：点下面「生成密钥」，就地生成 base32 密钥并显示二维码；用认证器 App 扫码后再点「我已扫码绑定」。'));
        }
      } else {
        var uri = otpauthOf(secret);
        var svg = qrSvg(uri);
        children.push(h('img', { key: 'qr', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), style: { width: '200px', height: '200px', background: '#fff', imageRendering: 'pixelated', border: '1px solid #ddd' }, alt: 'TOTP 绑定二维码' }));
        children.push(h('div', { key: 'uri', style: S.hint }, '密钥：' + secret + '（只在确认绑定前展示；确认后需要重新生成）'));
        children.push(h('div', { key: 'pending', style: S.hint }, '这份密钥已经生效但还没确认绑定（例如从终端 enroll 粘过来的）：扫码后点「我已扫码绑定」就好，别点「生成密钥」——那会覆盖它。'));
      }
      children.push(h('div', { key: 'actions', style: S.actions },
        h('button', { key: 'gen', style: S.button, onClick: function () { updateField(['flowAuth', 'totpSecret'], makeTotpSecret()); updateField(['flowAuth', 'enrolledAt'], 0); } }, hasSecret ? '换一个密钥（覆盖当前）' : '生成密钥'),
        h('button', { key: 'bind', style: S.button, disabled: hasSecret !== true, onClick: function () { if (hasSecret !== true) return; updateField(['flowAuth', 'enrolledAt'], Date.now()); } }, '我已扫码绑定')));
      children.push(h('div', { key: 'save-hint', style: S.hint }, '改完点页面底部「保存」；确认绑定会同时写入绑定时间，之后这里只显示已绑定状态。'));
      return h('div', { key: field.path.join('.'), style: S.row }, children);
    }
    /**
     * 「Moli 渲染抓取」卡片：现场探测 Moli 引擎是否就绪（dsh-moli 插件只负责装引擎）。
     *
     * 开关的判据是**引擎已安装**（`engineState === 'installed'`），不是「插件在运行」：
     * 插件装了但引擎没装/没探测到，开关一样强制关闭且不可点。就绪后才在卡片里展开
     * 「高级设置」，直通 moli 的参数（对齐 dsh-moli 1.1.20 的 Config：
     * defaultTimeoutMs / maxChars / insecureTls / proxy / exePath，qq_webfetch 调 moli 时用的就是这几项）。
     */
    function renderMoliCard(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced) {
      var state = (moliState === null || moliState === undefined) ? { phase: 'idle', advanced: false } : moliState;
      var checking = state.phase === 'checking';
      var advanced = state.advanced === true;
      var info = (state.phase === 'ready' && state.value !== null && state.value !== undefined) ? state.value : null;
      var engineReady = info !== null && info.engineState === 'installed';
      var engineState = (info !== null && typeof info.engineState === 'string') ? info.engineState : '';
      var engineVersion = (info !== null && typeof info.engineVersion === 'string') ? info.engineVersion : '';
      var pluginInstalled = info !== null && info.installed === true;
      var customExe = String(getPath(draft, ['moli', 'exePath']) || '').trim() !== '';
      // 能用开关的三种情况：引擎装好了 / 用户自己指定了引擎路径 / dsh-moli 在但读不到引擎状态（交给 Host 现场探测）。
      var canToggle = engineReady || customExe || (pluginInstalled && engineState === '');
      var on = value === true && canToggle;
      var forcedOff = value === true && canToggle !== true;

      var badge = '检测中…';
      var badgeStyle = S.moliBadgeIdle;
      var badgeKey = state.phase;
      var detail = '正在检测 Moli 引擎…';
      var detailExtra = null;
      if (state.phase === 'error') {
        badge = '检测失败';
        badgeStyle = S.moliBadgeBad;
        detail = String(state.error || '检测失败') + '（开关保持关闭）';
      } else if (info !== null) {
        if (engineReady === true) {
          badge = '引擎就绪';
          badgeStyle = S.moliBadgeOk;
          badgeKey = 'ready';
          detail = '已就绪：开启后 qq_webfetch 用 Moli 引擎渲染（可抓 SPA/JS 页）。'
            + (engineVersion !== '' ? '当前引擎 ' + engineVersion + '。' : '')
            + 'dsh-moli 只用它装引擎，装好之后启不启用它都无所谓。';
        } else if (pluginInstalled === true && engineState !== '') {
          badge = '引擎缺失';
          badgeStyle = S.moliBadgeWarn;
          badgeKey = 'engine-missing';
          detail = 'dsh-moli 在，但引擎没装好（engineState: ' + engineState + '）：去 dsh-moli 的卡片点安装引擎，装完回来点「检测」。';
        } else if (pluginInstalled === true) {
          badge = 'dsh-moli 在 · 引擎状态未知';
          badgeStyle = S.moliBadgeWarn;
          badgeKey = 'unknown';
          detail = '检测到 dsh-moli，但读不到它的引擎状态：实际能不能用由 Host 现场探测（抓取失败会明确报错）。也可以在「高级设置」里直接填引擎路径。';
        } else {
          badge = '未装 dsh-moli';
          badgeStyle = S.moliBadgeBad;
          badgeKey = 'missing';
          detail = '没检测到 dsh-moli——它只是用来装 Moli 引擎的（装一次就行，之后可以不管它）。'
            + '装上并装好引擎后再点「检测」；引擎已经在别处的话，在「高级设置」里填路径即可。';
          detailExtra = h('a', {
            key: 'repo',
            href: MOLI_REPO_URL,
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-moli-repo': '1',
            style: S.moliLink,
          }, '去 GitHub 看 dsh-moli →');
        }
      }

      // 折叠设置：与启用状态无关，点了就展开；展开后逐项渲染 moli 的参数。
      var advancedRows = advanced
        ? MOLI_ADVANCED_FIELDS.map(function (item) {
          return h('div', { key: 'adv-' + item.path.join('.'), style: S.moliAdvItem },
            renderField(item, getPath(draft, item.path), updateField, false, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced));
        })
        : null;

      return h('div', { key: field.path.join('.'), style: S.moliCard },
        h('div', { key: 'head', style: S.moliHead },
          h('div', { key: 'titles', style: S.moliTitles },
            h('div', { key: 'title', style: S.moliTitle }, field.label || 'Moli 渲染抓取'),
            h('div', { key: 'sub', style: S.moliSub }, 'dsh-moli 装引擎 · qq_webfetch 渲染抓取'),
          ),
          h('span', { key: 'badge', 'data-moli-badge': badgeKey, style: badgeStyle }, badge),
        ),
        h('div', { key: 'body', style: S.moliBody },
          h('label', { key: 'toggle', style: canToggle ? S.moliToggle : S.moliToggleDisabled },
            h('input', {
              type: 'checkbox',
              'data-moli-toggle': '1',
              checked: on,
              disabled: canToggle !== true,
              onChange: function (event) { if (canToggle !== true) return; updateField(field.path, event.target.checked); },
            }),
            h('span', null, '启用 Moli 渲染抓取'),
          ),
          h('button', {
            key: 'probe',
            type: 'button',
            'data-moli-probe': '1',
            style: checking ? S.buttonGhostDisabled : S.buttonGhost,
            disabled: checking,
            onClick: function () { if (checking !== true) void runMoliProbe(); },
          }, checking ? '检测中…' : '检测'),
          // 折叠按钮**不跟 canToggle 绑定**：引擎没装好时也能点开看参数（比如先填引擎路径救场）。
          // 以前只有 canToggle 为真才渲染这个按钮，没启用/引擎缺失时整个入口都不见了。
          h('button', {
            key: 'adv',
            type: 'button',
            'data-moli-advanced': '1',
            style: S.buttonGhost,
            onClick: function () { if (typeof toggleMoliAdvanced === 'function') toggleMoliAdvanced(); },
          }, advanced ? '高级设置 ▾' : '高级设置 ▸'),
        ),
        h('div', { key: 'detail', style: S.moliDetail },
          detailExtra === null ? detail : [detail, h('span', { key: 'gap' }, ' '), detailExtra]),
        advancedRows === null ? null : h('div', { key: 'adv', style: S.moliAdv }, advancedRows),
        forcedOff === true
          ? h('div', { key: 'forced', style: S.moliForced }, '配置里这个开关是开的，但引擎当前不可用：保存后会强制写回关闭。')
          : null,
      );
    }

    // ---------------------------------------------------------- 表情包图库卡片
    // 与宿主路由配套（lib/gateway/routes-sticker.js）：
    //   GET  /dsh-qq-bot/sticker          读状态（目录 / 张数 / 系列 / 打标进度）
    //   POST /dsh-qq-bot/sticker/rebuild  后台重建（mode=tag 扫描 + 打标；mode=index 只扫哈希）
    // 卡片本身只管「开关 + 参数 + 状态 + 重建按钮」；扫描、哈希比对、调视觉模型全在宿主侧，
    // 所以这里显示的是**已保存**的配置：改完点保存，再点「刷新」。
    var STICKER_STATE_PATH = '/dsh-qq-bot/sticker';
    var STICKER_REBUILD_PATH = '/dsh-qq-bot/sticker/rebuild';

    function formatStamp(ms) {
      var value = Number(ms);
      if (Number.isFinite(value) !== true || value <= 0) return '';
      var date = new Date(value);
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /** 卡片里的状态区：读一次状态，后台任务在跑时轮询到结束。 */
    function StickerStatus() {
      var stateHook = React.useState({ phase: 'loading', value: null, error: '' });
      var st = stateHook[0];
      var setSt = stateHook[1];

      var load = React.useCallback(function () {
        if (typeof fetch !== 'function') {
          setSt({ phase: 'unavailable', value: null, error: '' });
          return Promise.resolve();
        }
        // 相对 URL 在没有 base 的环境（例如单测里的 Node）会同步抛错：包一层，
        // 让卡片老老实实显示「读取失败」，而不是把异常抛进渲染期。
        var request;
        try { request = fetch(STICKER_STATE_PATH, { credentials: 'same-origin' }); }
        catch (error) { setSt({ phase: 'failed', value: null, error: messageOf(error) }); return Promise.resolve(); }
        return request
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data === null || data === undefined || data.ok === false) {
              setSt({ phase: 'failed', value: null, error: String((data && data.error) || '未知错误') });
              return;
            }
            setSt({ phase: 'ready', value: data, error: '' });
          }, function (error) {
            setSt({ phase: 'failed', value: null, error: messageOf(error) });
          });
      }, []);

      React.useEffect(function () { void load(); }, [load]);

      var info = (st.phase === 'ready' || st.phase === 'busy') ? st.value : null;
      var job = (info !== null && info.job !== null && info.job !== undefined) ? info.job : null;
      var running = job !== null && job.running === true;
      // 后台打标可能要几分钟：唯一一处轮询，任务结束（或组件卸载）就停。
      React.useEffect(function () {
        if (running !== true) return undefined;
        var timer = setInterval(function () { void load(); }, 1500);
        return function () { clearInterval(timer); };
      }, [running, load]);

      var startRebuild = React.useCallback(function (mode) {
        if (typeof fetch !== 'function') return;
        setSt({ phase: 'busy', value: st.value, error: '' });
        var request;
        try {
          request = fetch(STICKER_REBUILD_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: mode }),
          });
        } catch (error) {
          setSt({ phase: 'failed', value: null, error: '启动重建失败：' + messageOf(error) });
          return;
        }
        request.then(function (res) { return res.json(); }).then(function (data) {
          if (data === null || data === undefined || data.ok === false) {
            setSt({ phase: 'failed', value: null, error: String((data && data.error) || '重建失败') });
            return;
          }
          setSt({ phase: 'ready', value: data, error: String(data.error || '') });
        }, function (error) {
          setSt({ phase: 'failed', value: null, error: '启动重建失败：' + messageOf(error) });
        });
      }, [st.value]);

      var rows = [];
      if (st.phase === 'unavailable') {
        rows.push(h('div', { key: 'na', style: S.hint }, '（非 Web 环境：这里读不到运行状态，配置照旧生效）'));
        return h('div', { key: 'sticker-status', style: S.stickerStats }, rows);
      }
      if (info === null) {
        rows.push(h('div', { key: 'loading', style: S.hint }, st.phase === 'failed' ? ('读取状态失败：' + st.error) : '正在读取表情包状态…'));
        if (st.phase === 'failed') {
          rows.push(h('div', { key: 'retry', style: S.actions },
            h('button', { key: 'refresh', type: 'button', style: S.buttonGhost, onClick: function () { void load(); } }, '重试')));
        }
        return h('div', { key: 'sticker-status', style: S.stickerStats }, rows);
      }

      var seriesText = Array.isArray(info.series) && info.series.length > 0
        ? info.series.map(function (entry) { return (entry.name === '' ? '（根目录）' : entry.name) + ' ' + entry.count; }).join('、')
        : '（还没有图）';
      rows.push(h('div', { key: 'dir', style: S.stickerKv }, '目录：' + String(info.dir || '')));
      rows.push(h('div', { key: 'counts', style: S.stickerKv },
        '共 ' + String(info.total || 0) + ' 张 · ' + String(info.series ? info.series.length : 0) + ' 个系列'
        + ' · 已标记 ' + String(info.tagged || 0) + ' / 待标记 ' + String(info.untagged || 0)));
      rows.push(h('div', { key: 'series', style: S.stickerKv }, '系列：' + seriesText));
      rows.push(h('div', { key: 'index', style: S.stickerKv },
        info.indexExists === true
          ? ('索引：index.json（更新于 ' + (formatStamp(info.updatedAt) || '未知时间') + '）')
          : '索引：还没有（第一次用 qq_sticker 或点下面的「扫描并打标」会生成）'));
      if (info.corrupt === true) {
        rows.push(h('div', { key: 'corrupt', style: S.error }, 'index.json 读不出来（内容被改坏了？）：重新扫描会重写它，已有的标签会丢'));
      }
      rows.push(h('div', { key: 'model', style: S.stickerKv },
        info.model === null || info.model === undefined
          ? '打标模型：未配置 —— 自动打标会被跳过，请在下面选 provider 与模型'
          : ('打标模型：' + String(info.model.provider) + ' / ' + String(info.model.model))));
      if (info.autoTag === false) {
        rows.push(h('div', { key: 'autotag-off', style: S.hint },
          'AI 自动标记已关闭：重建只会扫哈希、建索引，不给图打标签（开上面的「AI 自动标记」后再重建才会调模型）。'));
      }
      if (job !== null) {
        if (running === true) {
          rows.push(h('div', { key: 'job', style: S.stickerKv },
            '正在' + (job.mode === 'index' ? '扫描索引' : '自动打标') + '：' + String(job.done || 0) + ' / ' + String(job.total || 0)
            + '（成功 ' + String(job.tagged || 0) + '，失败 ' + String(job.failed || 0) + '）'));
        } else if (job.note !== '' || job.error !== '') {
          rows.push(h('div', { key: 'job', style: S.hint },
            '上次重建（' + (formatStamp(job.finishedAt) || '未知时间') + '）：' + (job.note || '没有变化')
            + (job.error !== '' ? ('；' + job.error) : '')));
        }
      }
      rows.push(h('div', { key: 'actions', style: S.actions },
        h('button', {
          key: 'tag',
          type: 'button',
          'data-sticker-rebuild': 'tag',
          style: running === true ? S.buttonGhostDisabled : S.buttonGhost,
          disabled: running === true,
          onClick: function () { if (running !== true) startRebuild('tag'); },
        }, running === true ? '正在重建…' : '扫描并打标'),
        h('button', {
          key: 'index',
          type: 'button',
          'data-sticker-rebuild': 'index',
          style: running === true ? S.buttonGhostDisabled : S.buttonGhost,
          disabled: running === true,
          onClick: function () { if (running !== true) startRebuild('index'); },
        }, '只重建索引'),
        h('button', { key: 'refresh', type: 'button', style: S.buttonGhost, onClick: function () { void load(); } }, '刷新'),
      ));
      return h('div', { key: 'sticker-status', style: S.stickerStats }, rows);
    }

    /**
     * 「表情包图库」卡片：开关 + 目录/自动打标/模型等参数 + 运行状态 + 重建按钮。
     * 参数字段用 in: "sticker-card" 声明，由模板组装后放进 STICKER_CARD_FIELDS，
     * 所以这里不需要知道具体有哪几项（加字段只改 JSON）。
     */
    function renderStickerCard(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, toggleStickerAdvanced) {
      var on = value === true;
      // 折叠口径与 moli 卡片对齐：折叠与否只看用户点没点「高级设置」，
      // **不再**跟启用开关联动——没启用也能点开，先看参数/状态再决定要不要开。
      var state = (moliState === null || moliState === undefined) ? { stickerAdvanced: false } : moliState;
      var advanced = state.stickerAdvanced === true;
      var paramRows = advanced
        ? STICKER_CARD_FIELDS.map(function (item) {
          return h('div', { key: 'st-' + item.path.join('.'), style: S.moliAdvItem },
            renderField(item, getPath(draft, item.path), updateField, false, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, toggleStickerAdvanced));
        })
        : null;
      return h('div', { key: field.path.join('.'), style: S.moliCard, 'data-sticker-card': '1' },
        h('div', { key: 'head', style: S.moliHead },
          h('div', { key: 'titles', style: S.moliTitles },
            h('div', { key: 'title', style: S.moliTitle }, field.label || '表情包图库'),
            h('div', { key: 'sub', style: S.moliSub }, '目录 = 图库 · 子目录 = 系列 · index.json = 索引'),
          ),
          h('span', { key: 'badge', 'data-sticker-badge': on ? 'on' : 'off', style: on ? S.moliBadgeOk : S.moliBadgeIdle },
            on ? '已开启' : '已关闭'),
        ),
        h('div', { key: 'body', style: S.moliBody },
          h('label', { key: 'toggle', style: S.moliToggle },
            h('input', {
              type: 'checkbox',
              'data-sticker-toggle': '1',
              checked: on,
              onChange: function (event) { updateField(field.path, event.target.checked); },
            }),
            h('span', null, '启用表情包图库'),
          ),
          h('button', {
            key: 'adv',
            type: 'button',
            'data-sticker-advanced': '1',
            style: S.buttonGhost,
            onClick: function () { if (typeof toggleStickerAdvanced === 'function') toggleStickerAdvanced(); },
          }, advanced ? '高级设置 ▾' : '高级设置 ▸'),
        ),
        field.hint ? h('div', { key: 'hint', style: S.hint }, field.hint) : null,
        // 参数与状态都跟着折叠按钮走：展开后即使图库没启用，也能看到目录/打标模型/重建按钮与当前状态。
        advanced === true ? h(StickerStatus, { key: 'status' }) : null,
        on !== true
          ? h('div', { key: 'collapsed', style: S.hint, 'data-sticker-collapsed': '1' },
            '图库当前未启用：勾上上面的开关才会真正扫描与打标（Agent 侧 qq_sticker 也不可用）。')
          : null,
        paramRows === null ? null : h('div', { key: 'params', style: S.moliAdv }, paramRows),
      );
    }

    // ---------------------------------------------------------- 官方 Bot 扫码绑定卡片
    // 与宿主路由（lib/gateway/routes-bind.js）配套：只读状态 + 刷新二维码；appSecret 永远不出宿主。
    var QQ_BIND_STATE = '/dsh-qq-bot/bind';
    var QQ_BIND_REFRESH = '/dsh-qq-bot/bind/refresh';
    // 默认值（「一键还原默认」用）。与扫码绑定同源，只回默认值、不回当前配置。
    var QQ_DEFAULTS_PATH = '/dsh-qq-bot/defaults';
    // 设置页模板：标签页骨架 + 全部字段。字段定义住在各所有者目录的 *-set.json 里，
    // 由服务端在加载期组装并校验，这里只负责取回来渲染。
    var QQ_SETTINGS_PATH = '/dsh-qq-bot/settings';
    function QqBindCard() {
      var stateHook = React.useState({ phase: 'loading' });
      var st = stateHook[0];
      var setSt = stateHook[1];
      var Qr = qrSvg;
      var load = React.useCallback(function () {
        return fetch(QQ_BIND_STATE, { credentials: 'same-origin' })
          .then(function (res) { return res.json(); })
          .then(function (data) { setSt(Object.assign({ phase: 'idle' }, data)); }, function (error) {
            setSt({ phase: 'failed', error: '读取绑定状态失败：' + messageOf(error) });
          });
      }, []);
      React.useEffect(function () { void load(); }, [load]);
      React.useEffect(function () {
        if (st.phase !== 'waiting') return undefined;
        var timer = setInterval(function () { void load(); }, 2000);
        return function () { clearInterval(timer); };
      }, [st.phase, load]);
      var startScan = React.useCallback(function () {
        setSt({ phase: 'waiting', url: '' });
        fetch(QQ_BIND_REFRESH, { method: 'POST', credentials: 'same-origin' })
          .then(function (res) { return res.json(); })
          .then(function (data) { setSt(Object.assign({ phase: 'idle' }, data)); }, function (error) {
            setSt({ phase: 'failed', error: '启动扫码失败：' + messageOf(error) });
          });
      }, []);
      var children = [];
      if (st.phase === 'loading') {
        children.push(h('div', { key: 'load', style: S.hint }, '正在读取绑定状态…'));
      } else if (st.phase === 'waiting' && st.url) {
        children.push(h('img', { key: 'qr', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(Qr(st.url)), alt: 'QQ 扫码绑定', style: { width: '200px', height: '200px', background: '#fff', imageRendering: 'pixelated', border: '1px solid #ddd' } }));
        children.push(h('div', { key: 'hint', style: S.hint }, '手机 QQ 扫码 → 确认 → AppID/AppSecret 自动写入设置（密钥不出宿主，页面只回显 AppID）。'));
      } else if (st.phase === 'waiting') {
        children.push(h('div', { key: 'wait', style: S.hint }, '正在生成二维码…'));
      } else if (st.phase === 'saving') {
        children.push(h('div', { key: 'save', style: S.hint }, '扫码成功，正在保存凭据…'));
      } else if (st.phase === 'failed') {
        children.push(h('div', { key: 'err', style: S.hint }, String(st.error || '扫码不可用')));
      } else if (String(st.appId || '').trim() !== '') {
        // 用去空白后的非空判断：以前 `st.appId` 直接当真值用，配置里只剩空格也会显示「已绑定」。
        children.push(h('div', { key: 'bound', style: S.hint }, '已绑定 AppID：' + String(st.appId).trim()));
      }
      children.push(h('button', { key: 'btn', style: S.button, onClick: startScan }, st.phase === 'waiting' ? '刷新二维码' : (String(st.appId || '').trim() !== '' ? '重新扫码绑定' : '扫码绑定')));
      return h('div', { key: 'qqbind', style: S.row }, children);
    }

    /**
     * provider 下拉的选项：目录里的分组 + 「留空」。
     * 关键：**已配置但不在目录里的值必须保留成一个选项**——否则 <select> 找不到匹配项会渲染成空，
     * 界面上看起来像「没配」，用户再保存任何改动就可能把 provider 写空（历史坑：
     * proactive.speakProvider / sticker.provider 都这样丢过值）。
     * @param {Array|null} groups 模型目录分组
     * @param {any} current 当前配置值
     * @param {string} emptyLabel 「留空」那一项的文案
     * @returns {Array<[string,string]>} [value, label] 对
     */
    function providerOptionsOf(groups, current, emptyLabel) {
      var value = current === undefined || current === null ? '' : String(current).trim();
      var options = [['', emptyLabel]];
      var list = Array.isArray(groups) ? groups : [];
      var seen = false;
      for (var i = 0; i < list.length; i += 1) {
        var group = list[i];
        if (group === null || group === undefined || typeof group.id !== 'string') continue;
        if (group.id === value) seen = true;
        var label = group.id === 'deepseek-account' ? '登录账号 API（' + (group.name || group.id) + '）' : (group.name || group.id);
        options.push([group.id, label]);
      }
      if (value !== '' && seen !== true) options.push([value, value + '（不在模型目录里，已保留）']);
      return options;
    }

    /**
     * model 字段对应的 provider 字段路径。
     * `model` → `provider`；`speakModel` → `speakProvider`（**不能**一律换成 `provider`：
     * 那会让主动发言的「发言阶段模型」去列「判断阶段 provider」的模型，两段式配置直接错位）。
     * @param {Array<string>} path model 字段的路径
     * @returns {Array<string>} provider 字段的路径
     */
    function providerPathOf(path) {
      var list = Array.isArray(path) ? path.slice() : [];
      if (list.length === 0) return list;
      var last = String(list[list.length - 1]);
      var seg = 'provider';
      if (last !== 'model') {
        if (last.length > 5 && last.slice(-5) === 'Model') seg = last.slice(0, last.length - 5) + 'Provider';
      }
      list[list.length - 1] = seg;
      return list;
    }

    function renderField(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, toggleStickerAdvanced, flags) {
      var gateFlags = (flags !== null && typeof flags === 'object') ? flags : {};
      var locked = gateFlags.locked === true;
      var secretSet = gateFlags.secretSet === true;
      var children = [];

      if (field.kind === 'qqbind') return h(QqBindCard, { key: field.path.join('.') });
      if (field.kind === 'qr') return renderQrBind(field, value, updateField, isSecret, draft, totpSecretSet);

      if (field.kind === 'moli') {
        return renderMoliCard(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced);
      }

      if (field.kind === 'sticker') {
        return renderStickerCard(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, toggleStickerAdvanced);
      }

      if (field.kind === 'bool') {
        children.push(h('div', { key: 'row', style: S.checkboxRow },
          h('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: function (event) { updateField(field.path, event.target.checked); },
          }),
          h('span', { style: S.label }, field.label),
        ));
        if (field.hint) children.push(h('div', { key: 'hint', style: S.hint }, field.hint));
        return h('div', { key: field.path.join('.'), style: S.row }, children);
      }

      children.push(h('div', { key: 'label', style: S.label }, field.label));

      if (field.kind === 'select' && field.dynamic === 'provider') {
        // 视觉 provider 下拉：留空 = 会话模型；否则从 DSH 会话模型目录里选。
        var pGroups = (catalog && catalog.phase === 'ready' && Array.isArray(catalog.groups)) ? catalog.groups : null;
        if (pGroups === null) {
          children.push(h('input', {
            key: 'input',
            type: 'text',
            style: S.input,
            placeholder: field.placeholder || '',
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }));
          if (catalog && catalog.phase === 'error' && catalog.error) {
            children.push(h('div', { key: 'warn', style: S.hint }, '模型目录不可用（' + catalog.error + '），已退回手动填写。'));
          }
        } else {
          var emptyProviderLabel = (typeof field.placeholder === 'string' && field.placeholder !== '') ? field.placeholder : '（留空 = 会话模型）';
          var pOptions = providerOptionsOf(pGroups, value, emptyProviderLabel);
          children.push(h('select', {
            key: 'input',
            style: S.select,
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }, pOptions.map(function (pair) {
            return h('option', { key: pair[0], value: pair[0], style: S.option }, pair[1]);
          })));
        }
      } else if (field.kind === 'select' && field.dynamic === 'model') {
        // model 下拉：跟随**同一个阶段的** provider（vision.* / proactive.* / proactive.speak* 各是一对）。
        var providerPath = providerPathOf(field.path);
        var chosenProvider = getPath(draft, providerPath) || '';
        var speakProviderEmpty = field.path[0] === 'proactive' && String(field.path[1] || '').slice(-5) === 'Model' && chosenProvider === '';
        // 两段式的发言阶段：**provider 留空 = 与判断阶段相同，发言模型自动跟随判断模型，不给单独设**。
        // 只有显式选了发言 provider 才让选发言模型——避免「provider 是判断的、model 是别处的」错位。
        var isSpeakStage = field.path[0] === 'proactive' && String(field.path[1] || '').slice(-5) === 'Model';
        var effectiveProvider = speakProviderEmpty === true ? '' : chosenProvider;
        var mGroups = (catalog && catalog.phase === 'ready' && Array.isArray(catalog.groups)) ? catalog.groups : null;
        var chosenGroup = null;
        if (mGroups !== null) {
          for (var gi = 0; gi < mGroups.length; gi += 1) {
            if (mGroups[gi].id === effectiveProvider) { chosenGroup = mGroups[gi]; break; }
          }
        }
        if (effectiveProvider === '') {
          // 真正没有 provider 可用：普通场景=跟随会话模型；发言阶段=连判断阶段都没配。
          var inheritLabel = (typeof field.placeholder === 'string' && field.placeholder !== '') ? field.placeholder : '（留空 = 会话模型）';
          children.push(h('select', {
            key: 'input',
            style: S.selectDisabled,
            disabled: true,
            value: '',
          }, h('option', { key: '', value: '', style: S.option }, inheritLabel)));
          children.push(h('div', { key: 'warn', style: S.hint },
            isSpeakStage === true
              ? '发言阶段 provider 留空 = 与判断阶段相同：发言模型自动跟随判断模型，不用单独设。要单独指定发言模型，先在上面选一个「发言阶段 provider」。'
              : '留空 = 跟随会话模型；想指定模型，先在上面的 provider 里选一个。'));
        } else if (chosenGroup === null) {
          // provider 不在目录里或目录不可用：回退手动填。
          children.push(h('input', {
            key: 'input',
            type: 'text',
            style: S.input,
            placeholder: field.placeholder || '',
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }));
          if (mGroups === null && catalog && catalog.phase === 'error' && catalog.error) {
            children.push(h('div', { key: 'warn', style: S.hint }, '模型目录不可用（' + catalog.error + '），已退回手动填写。'));
          } else {
            children.push(h('div', { key: 'warn', style: S.hint }, 'provider "' + effectiveProvider + '" 不在模型目录里，可手动填模型 id。'));
          }
        } else {
          var emptyModelLabel = (typeof field.placeholder === 'string' && field.placeholder !== '') ? field.placeholder : '（留空 = 会话模型）';
          var mOptions = [['', emptyModelLabel]].concat((Array.isArray(chosenGroup.models) ? chosenGroup.models : []).map(function (model) {
            return [model.id, model.name || model.id];
          }));
          children.push(h('select', {
            key: 'input',
            style: S.select,
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }, mOptions.map(function (pair) {
            return h('option', { key: pair[0], value: pair[0], style: S.option }, pair[1]);
          })));
        }
      } else if (field.kind === 'select') {
        // 连接方式等普通下拉：同样用主题变量样式，默认主题与 maid-atelier 都清晰。
        var options = field.options.map(function (pair) {
          return h('option', { key: pair[0], value: pair[0], style: S.option }, pair[1]);
        });
        children.push(h('select', {
          key: 'input',
          style: S.select,
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) { updateField(field.path, event.target.value); },
        }, options));
      } else if (field.kind === 'list') {
        children.push(h(ListInput, { key: 'input', field: field, value: value, updateField: updateField, locked: locked }));
        if (locked === true) children.push(h('div', { key: 'locked', style: S.hint }, '🔒 已锁定：先在「改名单用的动态码」里填一次 6 位码再改（保存才算消费）'));
      } else if (field.kind === 'clocks') {
        // 时段字段（免打扰时段这类）：每段两个时间选择器，而不是让用户在一行里手打「23:00-08:00」。
        // 以前是自由文本框，填了空格或清空后保存就送空串进去，服务端校验直接拒——这里从根上不给打错的机会。
        children.push(h(ClockRanges, { key: 'input', field: field, value: value, updateField: updateField, locked: locked }));
        if (locked === true) children.push(h('div', { key: 'locked', style: S.hint }, '🔒 已锁定：先在「改名单用的动态码」里填一次 6 位码再改（保存才算消费）'));
      } else if (field.kind === 'multiline') {
        children.push(h('textarea', {
          key: 'input',
          style: S.input,
          rows: 6,
          value: (value === undefined || value === null) ? '' : String(value),
          onChange: function (event) { updateField(field.path, event.target.value); },
        }));
      } else if (field.kind === 'number') {
        children.push(h(NumberField, { key: 'input', field: field, value: value, updateField: updateField, locked: locked }));
      } else {
        var isGateCode = field.path[0] === 'flowAuth' && field.path[1] === 'gateEditCode';
        // 单值纯数字字段（6 位动态码这类）：连逗号都不该敲进去。以前只有一个 numeric
        // 开关，而它同时意味着「多值」，于是单值字段也能打进分隔符。
        var digitsOnly = field.digitsOnly === true || isGateCode === true;
        children.push(h('input', {
          key: 'input',
          type: field.kind === 'password' ? 'password' : 'text',
          inputMode: digitsOnly === true ? 'numeric' : undefined,
          style: S.input,
          disabled: locked === true,
          placeholder: field.placeholder || '',
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) {
            var next = digitsOnly === true ? String(event.target.value).replace(DIGITS_ONLY_STRIP, '') : event.target.value;
            if (isGateCode === true && typeof gateFlags.onGateCode === 'function') gateFlags.onGateCode(next);
            else updateField(field.path, next);
          },
        }));
      }

      if (isSecret === true) {
        children.push(h('div', { key: 'secret', style: S.secretRow }, [
          h('span', { key: 'badge', style: secretSet === true ? S.secretBadgeOn : S.secretBadgeOff }, secretSet === true ? '已设置' : '未设置'),
          h('span', { key: 'note', style: S.hint }, secretSet === true
            ? '留空则保持不变，只有输入新值才会覆盖。'
            : '还没有填写；填写并保存后才会生效。'),
        ]));
      }
      if (field.hint) children.push(h('div', { key: 'hint', style: S.hint }, field.hint));
      return h('div', { key: field.path.join('.'), style: S.row }, children);
    }

    // -------------------------------------------------------------- 插件定义

    var name = PREFIX;
    // dsh-client-ui-settings 明确要求每个使用方自己声明 remote.settings，
    // 否则拿不到设置 Remote。slots 是宿主一定提供的插槽服务。
    // remote.session 用来拉 DSH 会话界面的模型目录（官方 API + 登录账号 + 自定义 providers），
    // 让视觉 provider/model 可以下拉选择而不是手打。
    var inject = ['slots', 'remote', 'remote.settings', 'remote.session'];

    /** 惰性解析设置 Remote：兼容 ctx.get / ctx["remote.settings"] / ctx.remote.settings 三种形态。 */
    function settingsApi(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          var direct = ctx.get('remote.settings');
          if (direct !== undefined && direct !== null) return direct;
        }
      } catch (error) { /* 继续尝试其它形态 */ }
      try {
        if (ctx['remote.settings'] !== undefined && ctx['remote.settings'] !== null) return ctx['remote.settings'];
      } catch (error) { /* 继续 */ }
      try {
        if (ctx.remote !== undefined && ctx.remote !== null && ctx.remote.settings !== undefined) return ctx.remote.settings;
      } catch (error) { /* 继续 */ }
      return null;
    }

    /** 惰性解析会话 Remote（模型目录）：兼容 ctx.get / ctx["remote.session"] / ctx.remote.session 三种形态。 */
    function sessionApi(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          var direct = ctx.get('remote.session');
          if (direct !== undefined && direct !== null) return direct;
        }
      } catch (error) { /* 继续尝试其它形态 */ }
      try {
        if (ctx['remote.session'] !== undefined && ctx['remote.session'] !== null) return ctx['remote.session'];
      } catch (error) { /* 继续 */ }
      try {
        if (ctx.remote !== undefined && ctx.remote !== null && ctx.remote.session !== undefined) return ctx.remote.session;
      } catch (error) { /* 继续 */ }
      return null;
    }

    /**
     * 惰性解析插件清单 Remote（remote.pluginManager）：只用来判断 dsh-moli 装没装。
     * 刻意不写进 inject——老版本 DSH 没这个服务时，声明 inject 会让整个插件加载失败；
     * 而 cordis 的 ctx.get 本来就是弱访问，拿不到只返回 undefined。
     */
    function pluginManagerApi(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          var direct = ctx.get('remote.pluginManager');
          if (direct !== undefined && direct !== null) return direct;
        }
      } catch (error) { /* 继续尝试其它形态 */ }
      try {
        if (ctx['remote.pluginManager'] !== undefined && ctx['remote.pluginManager'] !== null) return ctx['remote.pluginManager'];
      } catch (error) { /* 继续 */ }
      try {
        if (ctx.remote !== undefined && ctx.remote !== null && ctx.remote.pluginManager !== undefined) return ctx.remote.pluginManager;
      } catch (error) { /* 继续 */ }
      return null;
    }

    function apply(ctx) {
      // 实际生效的命名空间：loadConfig 解析出来后写回这里，保存时按它下发。
      var activeNs = NS;

      var faces = {
        loadConfig: function () {
          var settings = settingsApi(ctx);
          if (settings === null) return Promise.resolve({ ok: false, error: '拿不到设置服务（remote.settings）' });
          return Promise.resolve(settings.describe()).then(function (response) {
            var view = unwrap(response);
            if (view === undefined) return { ok: false, error: errorOf(response) };
            var namespaces = (view && Array.isArray(view.namespaces)) ? view.namespaces : [];
            var row = null;
            for (var i = 0; i < namespaces.length; i += 1) {
              if (namespaces[i] && namespaces[i].ns === NS) { row = namespaces[i]; break; }
            }
            if (row === null) {
              var matches = [];
              for (var j = 0; j < namespaces.length; j += 1) {
                var candidate = namespaces[j];
                if (candidate && typeof candidate.ns === 'string' && NS_FALLBACK.test(candidate.ns)) matches.push(candidate);
              }
              if (matches.length === 1) row = matches[0];
            }
            if (row === null) {
              return {
                ok: false,
                error: '设置里找不到条目 "' + NS + '"（Host 侧插件可能没加载，'
                  + '或插件的 Config schema 缺少 .volatile() 字段）',
              };
            }
            activeNs = row.ns;
            return { ok: true, value: row.value, revision: row.revision, secrets: Array.isArray(row.secrets) ? row.secrets : [] };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        saveConfig: function (ops, revision) {
          var settings = settingsApi(ctx);
          if (settings === null) return Promise.resolve({ ok: false, error: '拿不到设置服务（remote.settings）' });
          return Promise.resolve(settings.mutate(activeNs, ops, revision)).then(function (response) {
            var view = unwrap(response);
            if (view === undefined && response !== null && response !== undefined
              && Object.prototype.hasOwnProperty.call(response, 'ok') && response.ok === false) {
              return { ok: false, error: errorOf(response) };
            }
            return { ok: true, value: view };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        // 设置页模板：只取「怎么显示」，不含任何配置值。
        loadTemplate: function () {
          return fetch(QQ_SETTINGS_PATH, { credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (data === null || data === undefined || data.ok !== true) {
                return { ok: false, error: '模板接口返回了意外内容' };
              }
              if (!Array.isArray(data.tabs) || data.tabs.length === 0) return { ok: false, error: '模板里没有标签页' };
              if (!Array.isArray(data.fields) || data.fields.length === 0) return { ok: false, error: '模板里没有字段' };
              return { ok: true, value: { tabs: data.tabs, fields: data.fields } };
            }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        // 「一键还原默认」的数据源：插件自己的路由 GET /dsh-qq-bot/defaults。
        // 只取默认值（编译期常量，不含任何真实密钥），当前生效配置仍然走 loadConfig。
        loadDefaults: function () {
          return fetch(QQ_DEFAULTS_PATH, { credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (data === null || data === undefined || data.ok !== true || typeof data.defaults !== 'object' || data.defaults === null) {
                return { ok: false, error: '默认值接口返回了意外内容' };
              }
              return { ok: true, value: data.defaults };
            }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        loadModelCatalog: function () {
          var session = sessionApi(ctx);
          if (session === null) return Promise.resolve({ ok: false, error: '拿不到会话 Remote（remote.session），无法列出模型目录' });
          return Promise.resolve(session.modelCatalog()).then(function (response) {
            var view = unwrap(response);
            if (view === undefined) return { ok: false, error: errorOf(response) };
            return { ok: true, value: view };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        // 检测 dsh-moli 插件是否已注册（不依赖上面的 inject 面：走 remote.pluginManager 的插件清单）。
        // 检测 Moli 引擎是否就绪：dsh-moli 的插件清单（装没装）＋ 它自己的设置命名空间里的
        // engineState/engineVersion（引擎装没装）。dsh-moli 只在装引擎时用得到，运行期不依赖它。
        probeMoli: function () {
          var manager = pluginManagerApi(ctx);
          var settings = settingsApi(ctx);

          var pluginPromise = (manager === null)
            ? Promise.resolve({ installed: false, enabled: false, known: false })
            : Promise.resolve(manager.listPlugins()).then(function (response) {
              if (response === null || response === undefined || response.ok !== true) {
                return { installed: false, enabled: false, known: false };
              }
              var list = Array.isArray(response.value) ? response.value : [];
              for (var i = 0; i < list.length; i += 1) {
                var row = list[i];
                if (row === null || row === undefined) continue;
                if (row.entryId === 'dsh-moli' || row.moduleName === 'dsh-moli') {
                  return {
                    installed: true,
                    enabled: row.enabled === true,
                    known: true,
                    fiberPhase: row.fiberPhase === undefined ? null : row.fiberPhase,
                  };
                }
              }
              return { installed: false, enabled: false, known: true };
            }, function () { return { installed: false, enabled: false, known: false }; });

          // dsh-moli 把引擎状态写在自己的命名空间里（engineState / engineVersion），
          // 设置 describle 能看到所有命名空间，直接读它就不用再猜。
          var enginePromise = (settings === null)
            ? Promise.resolve(null)
            : Promise.resolve(settings.describe()).then(function (response) {
              var view = unwrap(response);
              if (view === undefined || view === null || !Array.isArray(view.namespaces)) return null;
              for (var i = 0; i < view.namespaces.length; i += 1) {
                var ns = view.namespaces[i];
                if (ns !== null && ns !== undefined && ns.ns === 'dsh-moli') {
                  return (ns.value === null || ns.value === undefined) ? {} : ns.value;
                }
              }
              return null;
            }, function () { return null; });

          return Promise.all([pluginPromise, enginePromise]).then(function (both) {
            var plugin = both[0] || { installed: false, enabled: false, known: false };
            var engine = both[1];
            return {
              ok: true,
              value: {
                installed: plugin.installed === true,
                enabled: plugin.enabled === true,
                // 只回卡片真正会读的几个字段。以前还额外返回 pluginKnown / engineConfiguredPath，
                // 前端一处都没读，等于把「检测到什么」的信息藏在没人看的地方。
                engineState: (engine !== null && typeof engine.engineState === 'string') ? engine.engineState : '',
                engineVersion: (engine !== null && typeof engine.engineVersion === 'string') ? engine.engineVersion : '',
              },
            };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
      };

      // 注册到「插件」页的 bundle 配置面板（与 dsh-soul-md 一致）：
      // 打开插件管理里本插件的详情页时，配置区就是这整套表单。
      // 旧 settings.section 入口不再保留（设置页顶层不再单开「QQ 机器人」选项卡）。
      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PKG_NAME,
          inject: function () { return faces; },
        }, QQBotSection);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // 单测钩子：状态区是卡片里嵌的子组件，位置式 hook 的测试桩渲染不到它内部，
    // 这里单独暴露一次渲染入口（运行时不调用，只在 test/test-client.mjs 里用）。
    exports.__stickerStatusForTest = function () { return h(StickerStatus, null); };
    exports.__providerOptionsForTest = providerOptionsOf;
    exports.__providerPathForTest = providerPathOf;
    return module.exports;
  },
});
