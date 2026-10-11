/**
 * dsh-qq-bot —— 客户端半边（浏览器）。
 *
 * 这是一个手写的模块 bundle，格式由 DSH 的客户端模块加载器决定：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * 只有 `react` 是外部依赖（由运行时提供），其余能力都从 apply(ctx) 注入的服务拿。
 *
 * 作用：在「设置」面板里加一个「QQ 机器人」选项卡，直接改插件配置，
 * 读写走内置的设置 Remote（ctx.remote.settings），不需要自定义 RPC。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    // DSH ≥ 0.1.7 的「设置命名空间」就是 profile 里的条目 id。本插件的 bundle 补丁
    // 插入的 id 是 'dsh-qq-bot'（0.1.6 时代用的是自定义命名空间 'qq-bot'，该 API 已移除）。
    var NS = 'dsh-qq-bot';
    // 条目 id 可能被用户改名，所以再加一条「以 qq-bot 结尾且唯一」的回退匹配。
    var NS_FALLBACK = /(^|[-_])qq-bot$/;
    var PREFIX = 'dsh-qq-bot';

    // ---------------------------------------------------------------- 表单模型

    var FIELDS = [
      {
        path: ['mode'], label: '连接方式', kind: 'select',
        hint: '正向 = DSH 主动连 NapCat（同机/同容器最简单）；反向 = NapCat 连 DSH（跨容器/跨网络）',
        options: [['forward', '正向 WebSocket（DSH → NapCat）'], ['reverse', '反向 WebSocket（NapCat → DSH）']],
      },
      { path: ['onebot', 'wsUrl'], label: '正向 WS 地址', kind: 'text', placeholder: 'ws://127.0.0.1:3001', when: function (v) { return v.mode !== 'reverse'; } },
      { path: ['onebot', 'listen'], label: '反向 WS 监听地址', kind: 'text', placeholder: '0.0.0.0:6199', when: function (v) { return v.mode === 'reverse'; } },
      { path: ['onebot', 'httpUrl'], label: 'HTTP API 地址', kind: 'text', placeholder: 'http://127.0.0.1:3000', hint: '留着用来发消息；清空则退回用 WebSocket action' },
      { path: ['onebot', 'accessToken'], label: 'access_token', kind: 'password', hint: 'NapCat 里设了 token 就填这里' },
      { path: ['group', 'enabled'], label: '启用群聊', kind: 'bool' },
      { path: ['group', 'requireAt'], label: '群里必须 @ 机器人才回复', kind: 'bool' },
      { path: ['group', 'allow'], label: '群号白名单', kind: 'list', hint: '逗号分隔；留空 = 所有群' },
      { path: ['private', 'enabled'], label: '启用私聊', kind: 'bool' },
      { path: ['private', 'allow'], label: '私聊白名单', kind: 'list', hint: '逗号分隔；留空 = 所有人' },
      { path: ['commandPrefix'], label: '命令前缀', kind: 'text', placeholder: '（留空 = 不限制）', hint: '例如 /ai，只有带前缀的消息才会被处理' },
      { path: ['reply', 'maxChars'], label: '单条最大字数', kind: 'number' },
      { path: ['reply', 'ackAfterMs'], label: '慢回复提示阈值（毫秒）', kind: 'number', hint: '0 = 关闭「正在处理」提示' },
      { path: ['reply', 'ackText'], label: '慢回复提示文案', kind: 'text' },
      { path: ['reply', 'contextHeader'], label: '消息附带来源前缀', kind: 'bool', hint: '形如 [QQ群 123 · 小明(22222)]' },
      { path: ['vision', 'enabled'], label: '图片视觉（识别 QQ 图片并入回复）', kind: 'bool', hint: '关闭后图片保持 [图片] 占位符' },
      { path: ['vision', 'provider'], label: '视觉 provider 路由', kind: 'select', dynamic: 'provider', placeholder: '（留空 = 会话模型）', hint: '复用 DSH 会话界面同一份模型目录（官方 API / 登录账号 / 自定义 providers，如你的自定义 provider）；baseURL/apiKey 沿用原配置' },
      { path: ['vision', 'model'], label: '视觉模型 id', kind: 'select', dynamic: 'model', placeholder: '（留空 = 会话模型）', hint: '跟随上面选的 provider 列出模型；例如 deepseek-v4-flash-vision-exp；模型不支持图片时会提示切换' },
      { path: ['vision', 'maxImages'], label: '单条最多图片数', kind: 'number' },
      { path: ['vision', 'downloadTimeoutMs'], label: '图片下载超时（毫秒）', kind: 'number' },
      { path: ['perChatSession'], label: '每个 QQ 会话独立 DSH 会话', kind: 'bool' },
      { path: ['agentPreset'], label: 'Agent preset', kind: 'text', placeholder: '（留空 = 部署默认）', hint: '换人格/工具集' },
      { path: ['logAdapterFrames'], label: '日志打印每一帧（排错）', kind: 'bool' },

      // ---- 权限（三路并行）----
      { path: ['auth', 'owners'], label: '拥有者 QQ 号', kind: 'list', hint: '逗号分隔。拥有者 = 全部权限 + 永久授权 + 可走独立会话；留空则无人是拥有者' },
      { path: ['auth', 'superAdmins'], label: '后台设定的高级管理员', kind: 'list', hint: '逗号分隔。有群管理权限，但不能永久授权' },
      { path: ['auth', 'ownerPreset'], label: '拥有者会话的 agent preset（人格分离用）', kind: 'text', placeholder: '（留空则不分流）', hint: '只是换人格，不是安全边界；工具隔离由下面的「访客工具闸」负责' },
      { path: ['auth', 'guestPreset'], label: '非拥有者会话的 agent preset（人格分离用）', kind: 'text', placeholder: '（留空则与拥有者共用会话）' },
      { path: ['auth', 'grantTtlMinutes'], label: '动态授权默认时长（分钟）', kind: 'number' },
      { path: ['auth', 'grantMaxTtlMinutes'], label: '群管理员单次可授最长（分钟）', kind: 'number' },
      { path: ['auth', 'guestDshTools'], label: '允许非拥有者使用 DSH 内部工具', kind: 'bool', hint: '默认关闭：访客不能用 bash/读写/子代理等（执行级拦截，不是靠提示词）' },
      { path: ['auth', 'guestToolAllow'], label: '访客仍可用的工具白名单', kind: 'list', hint: '逗号分隔，默认 qqbot,qqgroup。用白名单能自动挡住 run_code 这类不在全局层的特殊工具' },

      // ---- 群管理 ----
      { path: ['admin', 'enabled'], label: '启用群管理', kind: 'bool', hint: '总开关；关掉后指令与 qqgroup 工具都会拒绝' },
      { path: ['admin', 'manageGroups'], label: '可管理的群号', kind: 'list', hint: '逗号分隔；留空 = 回退用「群号白名单」，再空 = 不限制到群' },
      { path: ['admin', 'requireGroupAdmin'], label: '承认「本群管理员」这一路权限', kind: 'bool', hint: '关闭后只有静态名单与动态授权生效' },
      { path: ['admin', 'prefix'], label: '指令前缀（必须在消息首位）', kind: 'text', placeholder: '/' },
      { path: ['admin', 'dryRun'], label: '演练模式（只回复将执行什么）', kind: 'bool', hint: '先用它确认指令解析是否正确，再关掉真执行' },
      { path: ['admin', 'allowConsole'], label: '允许非 QQ 来源调用管理工具', kind: 'bool', hint: '例如从 Web UI 会话里直接让 Agent 踢人；默认关闭' },
    ];

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
      wrap: { padding: '4px 2px 24px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '620px' },
      heading: { fontSize: '15px', fontWeight: 600 },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
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
      error: { fontSize: '13px', color: '#d9534f', lineHeight: 1.6 },
    };

    // --------------------------------------------------------------- 界面组件

    function QQBotSection(props) {
      var loadConfig = props.loadConfig;
      var saveConfig = props.saveConfig;
      var loadModelCatalog = props.loadModelCatalog;

      var stateHook = React.useState({ phase: 'loading', error: null, value: null, revision: undefined, secrets: [] });
      var state = stateHook[0];
      var setState = stateHook[1];

      var draftHook = React.useState(null);
      var draft = draftHook[0];
      var setDraft = draftHook[1];

      var noticeHook = React.useState('');
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];

      var savingHook = React.useState(false);
      var saving = savingHook[0];
      var setSaving = savingHook[1];

      var reload = React.useCallback(function () {
        setState({ phase: 'loading', error: null, value: null, revision: undefined, secrets: [] });
        return Promise.resolve(loadConfig()).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            setState({ phase: 'ready', error: null, value: result.value, revision: result.revision, secrets: result.secrets || [] });
            setDraft(JSON.parse(JSON.stringify(result.value === null || result.value === undefined ? {} : result.value)));
          } else {
            setState({ phase: 'error', error: (result && result.error) || '读取设置失败', value: null, revision: undefined, secrets: [] });
          }
        }, function (error) {
          setState({ phase: 'error', error: messageOf(error), value: null, revision: undefined, secrets: [] });
        });
      }, [loadConfig]);

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

      var updateField = React.useCallback(function (path, value) {
        setDraft(function (current) { return setPath(current === null ? {} : current, path, value); });
        setNotice('');
      }, []);

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
        for (var i = 0; i < FIELDS.length; i += 1) {
          var field = FIELDS[i];
          var before = getPath(state.value, field.path);
          var after = getPath(draft, field.path);
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
        return Promise.resolve(saveConfig(ops, state.revision)).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            setNotice('已保存');
            setSaving(false);
            return reload();
          }
          setSaving(false);
          setNotice('保存失败：' + ((result && result.error) || '未知错误'));
          return undefined;
        }, function (error) {
          setSaving(false);
          setNotice('保存失败：' + messageOf(error));
          return undefined;
        });
      }, [draft, state.value, state.revision, saveConfig, reload]);

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
        if (typeof field.when === 'function' && field.when(draft) !== true) continue;
        var fieldKey = field.path.join('.');
        var isSecret = false;
        for (var si2 = 0; si2 < (state.secrets || []).length; si2 += 1) {
          var entry = (state.secrets || [])[si2];
          if (entry && Array.isArray(entry.path) && entry.path.join('.') === fieldKey) { isSecret = true; break; }
        }
        rows.push(renderField(field, getPath(draft, field.path), updateField, isSecret, draft, catalog));
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.heading }, 'QQ 机器人'),
        h('div', { style: S.hint },
          '改完点「保存」。连接方式（模式/地址/token）改动会自动重启适配器，其它改动对下一条消息生效。',
          h('br'),
          '连接状态可在对话里让 Agent 调用 qqbot 工具（action=status）查看。'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, rows),
        h('div', { style: S.actions },
          h('button', { style: S.button, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', { style: S.buttonGhost, onClick: reload, disabled: saving }, '重新读取'),
          notice === '' ? null : h('span', { style: S.notice }, notice),
        ),
      );
    }

    function renderField(field, value, updateField, isSecret, draft, catalog) {
      var children = [];

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
          var pOptions = [['', '（留空 = 会话模型）']].concat(pGroups.map(function (group) {
            var label = group.id === 'deepseek-account' ? '登录账号 API（' + (group.name || group.id) + '）' : (group.name || group.id);
            return [group.id, label];
          }));
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
        // 视觉 model 下拉：跟随上面选的 provider；留空 = 会话模型。
        var chosenProvider = getPath(draft, ['vision', 'provider']) || '';
        var mGroups = (catalog && catalog.phase === 'ready' && Array.isArray(catalog.groups)) ? catalog.groups : null;
        var chosenGroup = null;
        if (mGroups !== null) {
          for (var gi = 0; gi < mGroups.length; gi += 1) {
            if (mGroups[gi].id === chosenProvider) { chosenGroup = mGroups[gi]; break; }
          }
        }
        if (chosenProvider === '') {
          // provider 留空 = 用会话模型：model 下拉禁用，不可点击/不可编辑。
          children.push(h('select', {
            key: 'input',
            style: S.selectDisabled,
            disabled: true,
            value: '',
          }, h('option', { key: '', value: '', style: S.option }, '（留空 = 会话模型）')));
          children.push(h('div', { key: 'warn', style: S.hint }, '留空 = 跟随会话模型；想指定模型，先在上面的 provider 里选一个。'));
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
            children.push(h('div', { key: 'warn', style: S.hint }, 'provider "' + chosenProvider + '" 不在模型目录里，可手动填模型 id。'));
          }
        } else {
          var mOptions = [['', '（留空 = 会话模型）']].concat((Array.isArray(chosenGroup.models) ? chosenGroup.models : []).map(function (model) {
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
        children.push(h('input', {
          key: 'input',
          type: 'text',
          style: S.input,
          value: Array.isArray(value) ? value.join(', ') : '',
          onChange: function (event) {
            var parts = event.target.value.split(/[,，\s]+/).filter(function (item) { return item !== ''; });
            updateField(field.path, parts);
          },
        }));
      } else if (field.kind === 'number') {
        children.push(h('input', {
          key: 'input',
          type: 'number',
          style: S.input,
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) {
            var parsed = Number(event.target.value);
            updateField(field.path, Number.isFinite(parsed) ? parsed : 0);
          },
        }));
      } else {
        children.push(h('input', {
          key: 'input',
          type: field.kind === 'password' ? 'password' : 'text',
          style: S.input,
          placeholder: field.placeholder || '',
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) { updateField(field.path, event.target.value); },
        }));
      }

      if (isSecret === true) children.push(h('div', { key: 'secret', style: S.hint }, '已设置；留空则保持不变，只有输入新值才会覆盖。'));
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
        loadModelCatalog: function () {
          var session = sessionApi(ctx);
          if (session === null) return Promise.resolve({ ok: false, error: '拿不到会话 Remote（remote.session），无法列出模型目录' });
          return Promise.resolve(session.modelCatalog()).then(function (response) {
            var view = unwrap(response);
            if (view === undefined) return { ok: false, error: errorOf(response) };
            return { ok: true, value: view };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
      };

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 65,
          label: 'QQ 机器人',
          inject: function () { return faces; },
        }, QQBotSection);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
