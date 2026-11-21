// 配置契约模块：DEFAULTS 默认值 + Config schema（volatile 设置契约）+ 配置合并工具。
// 被 index.js 用作插件配置来源；设置页(client.js)按 volatile 字段渲染表单。
// Config 契约与 DSH ≥0.1.7 的设置契约：可编辑字段必须标 .volatile()，
// volatile 字段运行时是引用（config.xxx.get()），由 plainConfig 还原成普通对象。
import Schema from '@deepseek-ai/schemastery';
import { SEARCH_DEFAULT_ORDER, SEARCH_ORDER_MAX, SEARCH_PER_QUERY_MAX, BACKEND_LABELS } from './tools/websearch.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------ 默认值组装（自动发现）
// 默认参数不写死在本文件：**谁拥有这组配置，默认值就放在谁的目录里**，用同名 JSON 存。
//   lib/core-conf.json            不属于具体工具/阀门的核心组（传输 / 消息 / 网关 / 会话 / 全局配置）
//   lib/tools/*-conf.json          工具自己的参数（文件名与工具同名，如 websearch.js ↔ websearch-conf.json）
//   lib/valve/<阀门>/*-conf.json   阀门自己的参数（如 valve/security/auth-conf.json）
//   后缀必须带：扫描只认 CONF_SUFFIX（-conf.json），少了后缀的文件会被静默忽略。
//
// 目录是**遍历出来的**，路径一个都不写死：加新工具只需要往对应目录丢一个 JSON，
// 不用回来改本文件。每个 JSON 的形状：
//   { "group": "<配置树里的键>", "defaults": { ... } }
// group 必须写成 DEFAULTS / Config schema 里的那个键（如 webSearch、flowAuth）；
// 文件名只用于定位报错，不参与映射——这样 websearch-conf.json 可以管 webSearch，
// 也不用逼文件名去迁就驼峰。
//
// 核心组 JSON 由同目录 core-conf.json 提供；schema 只声明类型 / volatile / 描述，通过 defaultsOf('__core__') 取唯一默认值。
const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认值模板的后缀：<名字>-conf.json。 */
export const CONF_SUFFIX = '-conf.json';
/** 设置页模板的后缀：<名字>-set.json。 */
export const SET_SUFFIX = '-set.json';

/**
 * 列出目录里指定后缀的 JSON。
 * 后缀是「这份 JSON 归谁管」的区分：-conf.json 是默认值，-set.json 是设置页模板。
 * 两类文件可以放在同一个目录（同一个所有者），互不干扰。
 */
function listJsonFiles(dir, suffix) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { return []; }
  const out = [];
  for (const entry of entries) {
    if (entry.isFile() !== true) continue;
    if (entry.name.endsWith(suffix) !== true) continue;
    out.push(join(dir, entry.name));
  }
  return out.sort();
}

function readDefaultsFile(fullPath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    throw new Error('默认配置 JSON 读取/解析失败：' + label + '（' + String(error && error.message ? error.message : error) + '）');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('默认配置 JSON 必须是对象：' + label);
  }
  const group = typeof parsed.group === 'string' ? parsed.group.trim() : '';
  if (group === '') {
    throw new Error('默认配置 JSON 缺少 group 字段（要写配置树里的键，如 webSearch）：' + label);
  }
  const defaults = parsed.defaults;
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error('默认配置 JSON 的 defaults 必须是对象：' + label);
  }
  return { group, defaults, file: label };
}

/** 遍历 tools/*.json 与 valve/<阀门>/*.json，按文件里声明的 group 组装成默认值表。 */
function discoverDefaults() {
  const targets = [];
  // 核心配置文件放在 lib 根：使用内部组名 __core__，最终会展开到顶层而不形成 DEFAULTS.__core__。
  for (const full of listJsonFiles(HERE, CONF_SUFFIX)) {
    targets.push([full, full.slice(HERE.length + 1).split('\\').join('/')]);
  }
  for (const full of listJsonFiles(join(HERE, 'tools'), CONF_SUFFIX)) {
    targets.push([full, full.slice(HERE.length + 1).split('\\').join('/')]);
  }
  let valveEntries = [];
  try { valveEntries = readdirSync(join(HERE, 'valve'), { withFileTypes: true }); } catch (error) { valveEntries = []; }
  valveEntries.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
  for (const entry of valveEntries) {
    if (entry.isDirectory() !== true) continue;
    for (const full of listJsonFiles(join(HERE, 'valve', entry.name), CONF_SUFFIX)) {
      targets.push([full, full.slice(HERE.length + 1).split('\\').join('/')]);
    }
  }
  const byGroup = new Map();
  const sources = [];
  for (const [full, label] of targets) {
    const found = readDefaultsFile(full, label);
    const previous = byGroup.get(found.group);
    if (previous !== undefined) {
      throw new Error('默认配置组重复：' + found.group + ' 同时出现在 ' + previous.file + ' 与 ' + label);
    }
    byGroup.set(found.group, found);
    sources.push(Object.freeze({ group: found.group, file: label }));
  }
  return { byGroup, sources };
}

// ------------------------------------------------------------ 设置页模板（自动发现）
// 设置页的字段也不写死在客户端 bundle 里：**谁拥有这组配置，谁连「怎么编辑它」一起拥有**。
// 与默认值同一个目录、同一个前缀，只是后缀不同：
//   lib/tools/websearch-conf.json   默认值
//   lib/tools/websearch-set.json    设置页里这些字段怎么显示
//
// 加一个字段 = 往对应 -set.json 里加一条，客户端的 settings.js 一行都不用改。
//
// 形状（path 一律写绝对路径，不做「相对 group」的隐式约定，少一层猜）：
//   { "group": "webSearch",
//     "fields": [ { "path": ["webSearch","maxUses"], "label": "最多搜索轮数",
//                   "kind": "number", "tab": "capability", "subtab": "retrieval",
//                   "hint": "…", "when": { "…": "…" } } ] }

// kind 决定用哪个控件。moli / qqbind / qr / sticker / clocks 这几类不是普通输入框，
// 而是整块的自定义组件（moli 卡片 / 扫码绑定 / 二维码 / 表情包卡片 / 时段选择器），内部结构留在客户端代码里，
// 模板只负责声明「这一块要出现在哪个位置」。
// 「控件」kind：不是输入框，而是卡片里的一块自定义 UI（排序表 / 运行状态 / 引擎状态）。
// 它们只声明「放在哪一组」（in），真正的渲染与动作在客户端的 WIDGETS 表里实现。
const WIDGET_KINDS = ['searchorder', 'sticker-status', 'moli-status'];
const FIELD_KINDS = new Set(['text', 'password', 'bool', 'number', 'list', 'select', 'multiline', 'moli', 'qqbind', 'qr', 'sticker', 'clocks', 'card', ...WIDGET_KINDS]);

/**
 * 卡片声明（kind: "card" 的 card 字段）校验与归一。
 *
 * 一张卡由四部分组成，全部是数据：
 *   header    —— label（标题）+ sub（展开时的副标题）+ badge（徽标：布尔字段驱动或 "auto" 交给控件）
 *   summary   —— 收起时那行摘要（字面量 / "auto" 交给控件算）
 *   body      —— 槽位数组：{"in": "<组名>"} 把 in 相同的字段整组渲染，可选 title 作小节标题
 *   actions   —— 按钮数组：{"id": "<动作 id>", "label": "..."}，id 由控件实现（见客户端的 WIDGETS）
 *
 * 校验只做「结构对不对」，不校验控件是否认识这个动作 id —— 那是客户端的事，
 * 而且一张卡在没有对应控件时也不该让整个设置页加载失败。
 */
function normalizeCardSpec(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('kind=card 的字段必须带 card 对象：' + where);
  }
  const id = raw.id;
  if (typeof id !== 'string' || id === '') throw new Error('card.id 必须是非空字符串：' + where);
  const spec = { id };
  if (typeof raw.defaultOpen === 'boolean') spec.defaultOpen = raw.defaultOpen;
  // 头部与内容区的 DOM 标记由模板给：客户端不硬编码，测试也只认模板里写的名字。
  for (const key of ['dataAttr', 'toggleAttr', 'toggleLabel']) {
    if (typeof raw[key] === 'string' && raw[key] !== '') spec[key] = raw[key];
  }
  // badge：字符串 "auto" = 交给控件；对象 = 由某个配置路径驱动（on / off 两套文案）。
  if (raw.badge === 'auto') spec.badge = 'auto';
  else if (raw.badge !== undefined && raw.badge !== null) {
    const badge = raw.badge;
    if (typeof badge !== 'object' || Array.isArray(badge)) throw new Error('card.badge 必须是 "auto" 或对象：' + where);
    if (!Array.isArray(badge.path) || badge.path.length === 0) throw new Error('card.badge.path 必须是数组：' + where);
    const out = { path: badge.path.slice() };
    for (const key of ['on', 'off', 'toneOn', 'toneOff']) {
      if (typeof badge[key] === 'string' && badge[key] !== '') out[key] = badge[key];
    }
    spec.badge = out;
  }
  if (raw.summary === 'auto') spec.summary = 'auto';
  else if (typeof raw.summary === 'string' && raw.summary !== '') spec.summary = raw.summary;
  // headerToggle：头部是否是折叠开关。默认 true（整卡折叠，点头部展开）；
  // false = 卡片常驻，折叠交给 advancedLabel 那个「高级设置」按钮（参数区默认收起）。
  if (typeof raw.headerToggle === 'boolean') spec.headerToggle = raw.headerToggle;
  const slotList = (value, key) => value.map((slot, index) => {
    if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) throw new Error('card.' + key + ' 第 ' + (index + 1) + ' 项必须是对象：' + where);
    // 槽位有两种：{"in": "<组名>"} 渲染一组字段；{"actions": "open"|"idle"|"always"} 把按钮插在这里。
    // 后者让「恢复默认顺序」可以紧跟排序表、排在后面的参数区之前——顺序完全由模板说了算。
    if (slot.actions !== undefined) {
      const when = slot.actions;
      if (when !== 'open' && when !== 'idle' && when !== 'always') throw new Error('card.' + key + ' 第 ' + (index + 1) + ' 项的 actions 只能是 open/idle/always：' + where);
      return { actions: when };
    }
    if (typeof slot.in !== 'string' || slot.in === '') throw new Error('card.' + key + ' 第 ' + (index + 1) + ' 项缺少 in：' + where);
    const out2 = { in: slot.in };
    if (typeof slot.title === 'string' && slot.title !== '') out2.title = slot.title;
    return out2;
  });
  // body / advanced：默认「所有 in=card.id 的字段」。advanced 只在「高级设置」展开时渲染。
  if (raw.body !== undefined && raw.body !== null) {
    if (!Array.isArray(raw.body)) throw new Error('card.body 必须是数组：' + where);
    spec.body = slotList(raw.body, 'body');
  }
  if (raw.advanced !== undefined && raw.advanced !== null) {
    if (!Array.isArray(raw.advanced)) throw new Error('card.advanced 必须是数组：' + where);
    spec.advanced = slotList(raw.advanced, 'advanced');
  }
  if (typeof raw.advancedLabel === 'string' && raw.advancedLabel !== '') spec.advancedLabel = raw.advancedLabel;
  if (typeof raw.advancedAttr === 'string' && raw.advancedAttr !== '') spec.advancedAttr = raw.advancedAttr;
  // toggle：卡片自带的启用开关（绑定 card 自己的 path）。可用性交给控件判断：
  // disabledByWidget=true 时问卡片里的控件（例如 moli 卡片在引擎没装好时开关必须禁用）。
  if (raw.toggle !== undefined && raw.toggle !== null) {
    const toggle = raw.toggle;
    if (typeof toggle !== 'object' || Array.isArray(toggle)) throw new Error('card.toggle 必须是对象：' + where);
    if (typeof toggle.label !== 'string' || toggle.label === '') throw new Error('card.toggle.label 必须是非空字符串：' + where);
    const outToggle = { label: toggle.label };
    if (typeof toggle.attr === 'string' && toggle.attr !== '') outToggle.attr = toggle.attr;
    if (toggle.disabledByWidget === true) outToggle.disabledByWidget = true;
    spec.toggle = outToggle;
  }
  // forcedOffNotice：开关值仍是 true、但控件判定不可用时显示的一行提示（保存时会写回关闭）。
  if (raw.forcedOffNotice !== undefined && raw.forcedOffNotice !== null) {
    if (typeof raw.forcedOffNotice !== 'object' || Array.isArray(raw.forcedOffNotice)) throw new Error('card.forcedOffNotice 必须是对象：' + where);
    if (typeof raw.forcedOffNotice.text !== 'string' || raw.forcedOffNotice.text === '') throw new Error('card.forcedOffNotice 缺少 text：' + where);
    spec.forcedOffNotice = { text: raw.forcedOffNotice.text };
    if (typeof raw.forcedOffNotice.attr === 'string' && raw.forcedOffNotice.attr !== '') spec.forcedOffNotice.attr = raw.forcedOffNotice.attr;
  }
  // notices：卡片里那些「某个配置值不满足时出现」的提示行，条件语义与字段的 when 一致。
  if (raw.notices !== undefined && raw.notices !== null) {
    if (!Array.isArray(raw.notices)) throw new Error('card.notices 必须是数组：' + where);
    spec.notices = raw.notices.map((notice, index) => {
      if (notice === null || typeof notice !== 'object' || Array.isArray(notice)) throw new Error('card.notices 第 ' + (index + 1) + ' 项必须是对象：' + where);
      if (typeof notice.text !== 'string' || notice.text === '') throw new Error('card.notices 第 ' + (index + 1) + ' 项缺少 text：' + where);
      const out4 = { text: notice.text };
      if (notice.when !== undefined) out4.when = notice.when;
      if (typeof notice.tone === 'string' && notice.tone !== '') out4.tone = notice.tone;
      if (typeof notice.attr === 'string' && notice.attr !== '') out4.attr = notice.attr;
      return out4;
    });
  }
  // actions：按钮全部由 id 声明，客户端按 id 找控件实现；找不到就跳过这个按钮（不报错）。
  if (raw.actions !== undefined && raw.actions !== null) {
    if (!Array.isArray(raw.actions)) throw new Error('card.actions 必须是数组：' + where);
    spec.actions = raw.actions.map((action, index) => {
      if (action === null || typeof action !== 'object' || Array.isArray(action)) throw new Error('card.actions 第 ' + (index + 1) + ' 项必须是对象：' + where);
      if (typeof action.id !== 'string' || action.id === '') throw new Error('card.actions 第 ' + (index + 1) + ' 项缺少 id：' + where);
      if (typeof action.label !== 'string' || action.label === '') throw new Error('card.actions 第 ' + (index + 1) + ' 项缺少 label：' + where);
      const out3 = { id: action.id, label: action.label };
      if (typeof action.attr === 'string' && action.attr !== '') out3.attr = action.attr;
      // 出现时机：onlyWhenAlways=true 常驻；onlyWhenOpen=true 只在展开时；false 只在收起时。
      if (typeof action.onlyWhenAlways === 'boolean') out3.onlyWhenAlways = action.onlyWhenAlways;
      if (typeof action.onlyWhenOpen === 'boolean') out3.onlyWhenOpen = action.onlyWhenOpen;
      return out3;
    });
  }
  return spec;
}

/**
 * 数字字段的显示声明归一成 `num`。
 *
 * 以前这些信息散在四个平铺键上（slider / min / max / step / unit / digitsOnly），
 * 客户端要自己拼「有没有滑条」「步长多少」「单位写哪」；而且表达不了「百分比」「显示值缩放」
 * 这类需求（0.01 步长的概率显示成 0.01 而不是 1%）。
 *
 * 现在统一成一份：
 *   min / max / step   数值范围与步长（滑条也用它）
 *   unit              单位文案（跟在输入框后面）
 *   mode              'slider'（数值框 + 滑条）| 'plain'（只数值框）| 'digits'（只收纯数字）
 *                     —— 老的 slider:true / digitsOnly:true 会被推导成这里
 *   display           显示缩放：{ scale: 100, suffix: '%' } 表示内部值 0.01 → 界面显示 1%
 *                     （回写时按 scale 反算，所以输入框里敲 1 存进去就是 0.01）
 *
 * 校验只做「结构对不对」；范围本身的语义（0 表示不限之类）由字段自己的 hint 说清楚。
 */
function normalizeNumSpec(raw, where) {
  const spec = (raw.num !== undefined && raw.num !== null && typeof raw.num === 'object' && !Array.isArray(raw.num))
    ? raw.num
    : raw;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('num 必须是对象：' + where);
  const out = {};
  for (const key of ['min', 'max', 'step']) {
    const value = spec[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || Number.isFinite(value) !== true) throw new Error('num.' + key + ' 必须是有限数字：' + where);
    if (key === 'step' && value <= 0) throw new Error('num.step 必须大于 0：' + where);
    out[key] = value;
  }
  if (out.min !== undefined && out.max !== undefined && out.max <= out.min) {
    throw new Error('num.max 必须大于 num.min：' + where);
  }
  if (typeof spec.unit === 'string' && spec.unit !== '') out.unit = spec.unit;
  // mode：显式写了就用；否则按老开关推导（digitsOnly → digits，slider → slider，其余 plain）。
  let mode = spec.mode;
  if (mode === undefined || mode === null || mode === '') {
    mode = raw.digitsOnly === true ? 'digits' : (raw.slider === true ? 'slider' : 'plain');
  }
  if (mode !== 'slider' && mode !== 'plain' && mode !== 'digits') {
    throw new Error('num.mode 只能是 slider / plain / digits：' + where);
  }
  // slider 必须有完整范围，否则滑条没有意义（客户端也没法画）。
  if (mode === 'slider') {
    if (out.min === undefined || out.max === undefined) throw new Error('num.mode=slider 需要同时给 min 与 max：' + where);
    if (out.step === undefined) out.step = 1;
  }
  out.mode = mode;
  if (spec.display !== undefined && spec.display !== null) {
    if (typeof spec.display !== 'object' || Array.isArray(spec.display)) throw new Error('num.display 必须是对象：' + where);
    const display = {};
    const scale = spec.display.scale;
    if (scale !== undefined && scale !== null) {
      if (typeof scale !== 'number' || Number.isFinite(scale) !== true || scale <= 0) throw new Error('num.display.scale 必须是大于 0 的数字：' + where);
      display.scale = scale;
    }
    if (typeof spec.display.suffix === 'string' && spec.display.suffix !== '') display.suffix = spec.display.suffix;
    if (typeof spec.display.decimals === 'number' && Number.isFinite(spec.display.decimals) === true) display.decimals = Math.max(0, Math.trunc(spec.display.decimals));
    if (Object.keys(display).length > 0) out.display = display;
  }
  return out;
}

/** when 条件：{ "a.b": "值" } 逐项等值；值写成 { "$ne": "x" } 表示不等。 */
function normalizeWhen(when, label) {
  if (when === undefined || when === null) return undefined;
  if (typeof when !== 'object' || Array.isArray(when)) {
    throw new Error('设置页模板的 when 必须是对象：' + label);
  }
  const out = {};
  for (const key of Object.keys(when)) {
    const value = when[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const ops = Object.keys(value);
      if (ops.length !== 1 || ops[0] !== '$ne') {
        throw new Error('设置页模板的 when 只支持 { "$ne": 值 }，收到：' + key + ' → ' + JSON.stringify(value) + '（' + label + '）');
      }
      out[key] = { $ne: value.$ne };
      continue;
    }
    if (Array.isArray(value)) {
      throw new Error('设置页模板的 when 值不能是数组（要「等于其中之一」请显式用 { "$ne": … } 表达否定）：' + key + '（' + label + '）');
    }
    out[key] = value;
  }
  return out;
}

function readSettingsFile(fullPath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    throw new Error('设置页模板读取/解析失败：' + label + '（' + String(error && error.message ? error.message : error) + '）');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('设置页模板必须是对象：' + label);
  }
  // group 可选：所有者目录里的模板写它（一份文件只管一组，便于校验与报错定位）；
  // 核心模板装的是好几组字段（传输/消息/网关/会话……不属于任何工具或阀门），
  // 这时不写 group，每条的 path[0] 就是它的组。
  const group = typeof parsed.group === 'string' ? parsed.group.trim() : '';
  // priority：这份模板的字段在它落到的那个**标签页/二级标签内**排第几。
  // 以前靠文件名排序，于是「图片反搜」排在「moli」前面、moli 卡片跑到分区中间——
  // 顺序是文件名的副产品，改个文件名就换一次版面。
  // priority 只在同一个分区内比较，所以它记的是「我在这个分区里排第几位」：
  // 内置模板一律用 100 / 200 / 300（第 1 / 2 / 3 位），不同分区复用同一个号是常态。
  // 这样以后加内容只需要看自己那个分区，不必去全局序列里找空档，也就不会插个号把别人的顺序顶乱；
  // 真要落在同一分区又撞了号，才回退到文件名（确定，但不再是版面的大局）。
  // 需要跨模板交织（①自定义 → ②按身份 → ③兜底）时，给具体字段写 priority，见下面的字段级 priority。
  let priority = DEFAULT_SETTINGS_PRIORITY;
  if (parsed.priority !== undefined && parsed.priority !== null) {
    if (typeof parsed.priority !== 'number' || Number.isFinite(parsed.priority) !== true) {
      throw new Error('设置页模板的 priority 必须是有限数字：' + label + '（收到 ' + JSON.stringify(parsed.priority) + '）');
    }
    priority = parsed.priority;
  }
  // tab / subtab 写在文件头 = 这份模板的字段默认落在哪个标签页；
  // 单个字段再写 tab / subtab 就覆盖它（auth 那种跨「基础·准入」和「高级·会话」的必须能覆盖）。
  // 一份模板通常只管一个工具，整份都在同一个标签页，写一遍比每条重复一遍更不容易写错。
  const headerTab = typeof parsed.tab === 'string' ? parsed.tab.trim() : '';
  const headerSubtab = typeof parsed.subtab === 'string' ? parsed.subtab.trim() : '';
  const fields = parsed.fields;
  if (!Array.isArray(fields)) throw new Error('设置页模板的 fields 必须是数组：' + label);

  const out = [];
  for (let i = 0; i < fields.length; i += 1) {
    const raw = fields[i];
    const where = label + ' 第 ' + (i + 1) + ' 个字段';
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('字段必须是对象：' + where);
    const path = raw.path;
    if (!Array.isArray(path) || path.length === 0 || path.some((seg) => typeof seg !== 'string' || seg === '')) {
      throw new Error('字段的 path 必须是非空字符串数组：' + where);
    }
    const kind = raw.kind;
    if (FIELD_KINDS.has(kind) !== true) {
      throw new Error('字段 kind 不认识：' + String(kind) + '（' + where + '，可选 ' + Array.from(FIELD_KINDS).join('/') + '）');
    }
    const label2 = typeof raw.label === 'string' ? raw.label : '';
    if (label2 === '') throw new Error('字段缺少 label：' + where);
    const tab = (typeof raw.tab === 'string' && raw.tab !== '') ? raw.tab : headerTab;
    if (tab === '') throw new Error('字段缺少 tab（文件头也没写）：' + where);
    // subtab 三级取值：字段自己写了就用它；显式 null 表示「这个标签页没有二级标签」；
    // 都没写就继承文件头（文件头也没有则为 null）。
    let subtab = null;
    if (raw.subtab === null) subtab = null;
    else if (typeof raw.subtab === 'string' && raw.subtab !== '') subtab = raw.subtab;
    else subtab = headerSubtab === '' ? null : headerSubtab;
    const field = {
      path,
      label: label2,
      kind,
      tab,
      subtab,
      group,
      source: label,
    };
    if (typeof raw.hint === 'string' && raw.hint !== '') field.hint = raw.hint;
    // sub：副标题（卡片头部那一行小字）。以前卡片把这句话写死在客户端，现在模板自己说。
    if (typeof raw.sub === 'string' && raw.sub !== '') field.sub = raw.sub;
    if (typeof raw.placeholder === 'string') field.placeholder = raw.placeholder;
    if (raw.numeric === true) field.numeric = true;
    // digitsOnly / slider 这两个老开关只作为 normalizeNumSpec 的输入（推导 mode），
    // 推导完不再往客户端透传平铺键——客户端只认 field.num，避免两套并存的半吊子状态。
    // 例外：**文本类字段**（kind 不是 number）的 digitsOnly 仍然透传，
    // 它说的是「这个文本框只许敲数字」（6 位动态码、纯数字名单这类），与数值范围无关。
    if (kind !== 'number' && raw.digitsOnly === true) field.digitsOnly = true;
    if (raw.secret === true) field.secret = true;
    // virtual：这条不是配置键，只是「某块自定义 UI 放这里」的锚点（扫码绑定那类）。
    // 它没有对应的 schema 路径，所以下面跳过路径校验——但 kind 仍然要合法。
    if (raw.virtual === true) field.virtual = true;
    // card：把一个**容器**变成声明式。kind=card 的字段本身通常同时是 virtual（它只是锚点，
    // 真实配置挂在 body 里那些字段上），它声明「这张卡长什么样、body 有哪些槽、有哪些动作」，
    // 客户端按这份声明渲染，不再为每张卡写一个 renderXxxCard。
    // 新加一张「只有字段和按钮」的卡片 = 只改 JSON；只有引入全新控件才动前端。
    if (kind === 'card') field.card = normalizeCardSpec(raw.card, where);
    // in：这条字段不单独成行，而是渲染在某个自定义块内部（目前只有 moli 卡片里的「高级设置」）。
    // 保存与还原仍然把它当普通字段处理，只是不占外层的位置。
    if (raw.in !== undefined) {
      if (typeof raw.in !== 'string' || raw.in === '') throw new Error('字段 in 必须是非空字符串：' + where);
      field.in = raw.in;
    }
    if (typeof raw.dynamic === 'string' && raw.dynamic !== '') field.dynamic = raw.dynamic;
    // 数字字段的滑条声明：min/max/step/unit/slider 只有服务端模板知道，
    // 不在这里透传给客户端的话，前端拿到的模板里就没有范围信息，只能退回纯输入框。
    if (kind === 'number') field.num = normalizeNumSpec(raw, where);
    if (raw.options !== undefined) {
      if (!Array.isArray(raw.options)) throw new Error('字段 options 必须是 [[值, 显示名], …]：' + where);
      field.options = raw.options.map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error('options 每项必须是 [值, 显示名]：' + where);
        return [String(pair[0]), String(pair[1])];
      });
    }
    const when = normalizeWhen(raw.when, where);
    if (when !== undefined) field.when = when;
    // 字段级 priority：默认继承模板级。模板级只能决定「整块排在同一分区的哪儿」，
    // 需要跨模板交织时（①自定义 → ②按身份 → ③兜底）只能靠字段自己声明。
    let fieldPriority = priority;
    if (raw.priority !== undefined && raw.priority !== null) {
      if (typeof raw.priority !== 'number' || Number.isFinite(raw.priority) !== true) {
        throw new Error('字段的 priority 必须是有限数字：' + where + '（收到 ' + JSON.stringify(raw.priority) + '）');
      }
      fieldPriority = raw.priority;
    }
    field.priority = fieldPriority;
    if (group !== '' && path[0] !== group) {
      throw new Error('字段路径的组与文件声明的 group 不一致：' + path.join('.') + ' 不属于 ' + group + '（' + where + '）');
    }
    out.push(Object.freeze(field));
  }
  return { group, priority, fields: out, file: label };
}

/** 整页骨架的文件名。它也是 -set.json，但装的是标签页目录而不是字段，扫描时要跳过。 */
const PAGE_FILE = 'settings-page-set.json';

/**
 * 没写 priority 的模板文件排在哪儿。
 *
 * 内置模板占 100~900（整百，相邻两份之间留 99 个空位，加东西不必改别人的号），
 * 所以不写 priority 的一律落在 1000 —— 排在全部内置之后，既不插队到连接页前面，
 * 也不会因为「恰好撞上某份内置的号」触发排序冲突。
 */
const DEFAULT_SETTINGS_PRIORITY = 1000;

function eachOwnerDir() {
  const dirs = [HERE, join(HERE, 'tools')];
  let valveEntries = [];
  try { valveEntries = readdirSync(join(HERE, 'valve'), { withFileTypes: true }); } catch (error) { valveEntries = []; }
  valveEntries.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
  for (const entry of valveEntries) {
    if (entry.isDirectory() === true) dirs.push(join(HERE, 'valve', entry.name));
  }
  return dirs;
}

function listOwnerFiles(suffix) {
  const targets = [];
  for (const dir of eachOwnerDir()) {
    for (const full of listJsonFiles(dir, suffix)) {
      targets.push([full, full.slice(HERE.length + 1).split('\\').join('/')]);
    }
  }
  return targets;
}

/** 遍历各所有者目录里的 -set.json，收集设置页字段。 */
function discoverSettings(page) {
  const parsedFiles = [];
  for (const [full, label] of listOwnerFiles(SET_SUFFIX)) {
    if (label === PAGE_FILE) continue;
    parsedFiles.push(readSettingsFile(full, label));
  }

  // 排序口径：先把字段归到「标签页 → 二级标签」的桶里，桶内再按 priority 升序。
  // 以前排的是**文件**（priority 升序 → 文件路径升序），再把整份文件的字段连块塞进去，
  // 有两个毛病：
  //   1) 跨模板交织的次序永远排不对——「①自定义 → ②按身份 → ③兜底」里 auth 的 ②
  //      整块落在 core 的 ③ 后面，因为文件级 priority 只能决定整块的位置；
  //   2) 同优先级时退回文件名排序，版面成了文件名的副产品，改个文件名就换一次顺序。
  // 现在文件级 priority 只决定「同一分区内这一块排在哪」，跨模板交织用字段级 priority。
  const tabOrder = new Map();
  const subOrder = new Map();
  for (let i = 0; i < page.tabs.length; i += 1) {
    const tab = page.tabs[i];
    tabOrder.set(tab.id, i);
    for (let j = 0; j < tab.subs.length; j += 1) subOrder.set(tab.id + '\u0000' + tab.subs[j].id, j);
  }
  const rank = (map, key) => {
    const value = map.get(key);
    return value === undefined ? Number.MAX_SAFE_INTEGER : value;
  };
  const subRank = (field) => (field.subtab === null ? -1 : rank(subOrder, field.tab + '\u0000' + field.subtab));

  const entries = [];
  for (const found of parsedFiles) {
    for (let i = 0; i < found.fields.length; i += 1) {
      entries.push({ field: found.fields[i], file: found.file, index: i });
    }
  }

  entries.sort((a, b) => {
    const ta = rank(tabOrder, a.field.tab);
    const tb = rank(tabOrder, b.field.tab);
    if (ta !== tb) return ta - tb;
    const sa = subRank(a.field);
    const sb = subRank(b.field);
    if (sa !== sb) return sa - sb;
    if (a.field.priority !== b.field.priority) return a.field.priority - b.field.priority;
    // 同一分区里同优先级：不同模板才回退到文件名（与旧行为一致，确定但不再影响版面大局），
    // 同一份模板内保持声明顺序。跨分区的同优先级不参与比较，所以怎么撞都不影响谁先谁后。
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.index - b.index;
  });

  const byGroup = new Map();
  for (const found of parsedFiles) {
    const previous = byGroup.get(found.group);
    if (previous !== undefined) {
      throw new Error('设置页模板组重复：' + found.group + ' 同时出现在 ' + previous.file + ' 与 ' + found.file);
    }
    byGroup.set(found.group, found);
  }
  // sources 只是元信息（谁贡献了几条字段），按 priority 列出，不参与版面。
  const sources = parsedFiles
    .map((found) => Object.freeze({ group: found.group, file: found.file, priority: found.priority, count: found.fields.length }))
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : (a.file < b.file ? -1 : (a.file > b.file ? 1 : 0))));
  const fields = entries.map((entry) => entry.field);
  return { byGroup, sources, fields };
}

/** 读设置页骨架（标签页与二级标签的目录）。这是整页唯一的结构文件。 */
function loadPageCatalog() {
  const fullPath = join(HERE, 'settings-page-set.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    throw new Error('设置页骨架读取/解析失败：settings-page-set.json（' + String(error && error.message ? error.message : error) + '）');
  }
  const tabs = parsed === null || typeof parsed !== 'object' ? null : parsed.tabs;
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw new Error('设置页骨架缺少 tabs 数组：settings-page-set.json');
  }
  const byId = new Map();
  const out = [];
  for (const raw of tabs) {
    const id = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
    if (id === '') throw new Error('设置页骨架里有标签页缺少 id');
    if (byId.has(id) === true) throw new Error('设置页骨架里标签页 id 重复：' + id);
    const subs = [];
    for (const subRaw of Array.isArray(raw.subs) ? raw.subs : []) {
      const subId = subRaw && typeof subRaw.id === 'string' ? subRaw.id.trim() : '';
      if (subId === '') throw new Error('标签页 ' + id + ' 里有二级标签缺少 id');
      if (subs.some((s2) => s2.id === subId) === true) throw new Error('标签页 ' + id + ' 里二级标签 id 重复：' + subId);
      subs.push(Object.freeze({ id: subId, label: String(subRaw.label || subId), hint: String(subRaw.hint || '') }));
    }
    const tab = Object.freeze({ id, label: String(raw.label || id), hint: String(raw.hint || ''), subs: Object.freeze(subs) });
    byId.set(id, tab);
    out.push(tab);
  }
  return { tabs: Object.freeze(out), byId };
}

// 骨架先读：字段排序要按标签页/二级标签的顺序分桶，所以装配前就得知道目录。
const PAGE = loadPageCatalog();
const DISCOVERED_SETTINGS = discoverSettings(PAGE);
/** 每个设置页模板 JSON 管哪个配置组（诊断与测试用，顺序稳定）。 */
export const SETTINGS_SOURCES = Object.freeze(DISCOVERED_SETTINGS.sources);
/** 设置页字段（由各所有者目录的 -set.json 组装而成）。 */
export const SETTINGS_FIELDS = Object.freeze(DISCOVERED_SETTINGS.fields);

const DISCOVERED = discoverDefaults();
/** 每个默认值 JSON 管哪个配置组（诊断与测试用，顺序稳定）。 */
export const DEFAULTS_SOURCES = Object.freeze(DISCOVERED.sources);
// 核心组用内部名 CORE_GROUP 装：它的字段直接摊在配置树顶层，不能变成 DEFAULTS.core.xxx。
const CORE_GROUP = 'core';
const JSON_DEFAULTS = Object.freeze(Object.fromEntries(
  Array.from(DISCOVERED.byGroup, ([group, found]) => [group, found.defaults]).filter(([group]) => group !== CORE_GROUP),
));

/** 密钥字段：空串 / 纯空白一律归成 undefined——这样 DSH 的 `set` 判定才会是 false。
 *  以前这些字段都写 `.default('')`，求值结果里"一定有这个键"，于是 `redactSecrets`
 *  一律标成 `set: true`，设置页把**没填过**的生图 key / token 显示成「已设置」。 */
const secretString = (description) => Schema.transform(Schema.string(), (value) => (
  typeof value === 'string' && value.trim() === '' ? undefined : value
)).role('secret').volatile().description(description);

/**
 * 取某组默认值；文件被删/改名时给出可读错误，而不是在 schema 里抛
 * 「Cannot read properties of undefined」。
 */
const defaultsOf = (group) => {
  const table = group === CORE_GROUP
    ? (DISCOVERED.byGroup.get(CORE_GROUP) || {}).defaults
    : JSON_DEFAULTS[group];
  if (table === undefined || table === null) {
    throw new Error('缺少默认配置组 "' + group + '"：请在 lib/core-conf.json、lib/tools/ 或 lib/valve/<阀门>/ 下放一个 '
      + '{"group":"' + group + '","defaults":{...}} 的 JSON');
  }
  return table;
};

// 核心组的默认值全部来自 lib/core-conf.json（由 discoverDefaults 自动发现）。
// 以前这里还有一份手写的核心默认值常量，和 schema 里的字面量重复维护、互相遮蔽，
// 改它不生效。现在只剩 JSON 一个来源，加字段只改 JSON。

// 默认值：由 discoverDefaults() 扫描 lib/core-conf.json、lib/tools/*.json 与 lib/valve/<阀门>/*.json
// 自动并进来。加新字段只需要改对应目录的那个 JSON，这里不用改。
// 核心组 JSON 摊平到顶层（不能变成 DEFAULTS.core.xxx，配置树里没有这一层）。
const CORE_FROM_JSON = (DISCOVERED.byGroup.get(CORE_GROUP) || {}).defaults || {};
const DEFAULTS = { ...CORE_FROM_JSON, ...JSON_DEFAULTS };
/** 摊平前的核心组默认值（诊断与测试用：核对每个字段都在 schema 顶层）。 */
export const CORE_DEFAULT_FIELDS = CORE_FROM_JSON;

// -------------------------------------------------------------- 配置契约
// 只有 volatile 字段能被「设置」页改（settings 服务会校验 isVolatilePath），
// 所以凡是出现在设置界面里的字段都必须标 .volatile()。adapterPath / nodePath /
// restart / reply.firstTurnHint 不在界面上，故意保持普通字段：改它们会走
// 「整体重挂插件」这条更稳的路径。
export const Config = Schema.object({
  adapterPath: Schema.string().default(defaultsOf('core').adapterPath).description('OneBot 适配器脚本路径（留空 = 用包内自带）'),
  nodePath: Schema.string().default(defaultsOf('core').nodePath).description('node 可执行文件（留空 = 自动解析）'),

  protocol: Schema.union([
    Schema.const('onebot11'), Schema.const('onebot12'), Schema.const('satori'),
    Schema.const('milky'), Schema.const('qq-official'),
  ]).default(defaultsOf('core').protocol).volatile()
    .description('协议适配器：onebot11 / onebot12 / satori / milky / qq-official（切换后适配器自动重启）'),
  mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default(defaultsOf('core').mode).volatile()
    .description('连接方式：forward = DSH 连协议端；reverse = 协议端连 DSH'),
  onebot: Schema.object({
    wsUrl: Schema.string().default(defaultsOf('core').onebot.wsUrl).volatile().description('正向 WebSocket 地址'),
    listen: Schema.string().default(defaultsOf('core').onebot.listen).volatile().description('反向 WebSocket 监听地址'),
    httpUrl: Schema.string().default(defaultsOf('core').onebot.httpUrl).volatile().description('HTTP API 地址（留空 = 改用 WS action 发送）'),
    accessToken: secretString('协议端的 access_token（只写字段）'),
  }),
  protocols: Schema.object({
    onebot12: Schema.object({
      mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default(defaultsOf('core').protocols.onebot12.mode).volatile().description('OneBot 12 接入方式'),
      wsUrl: Schema.string().default(defaultsOf('core').protocols.onebot12.wsUrl).volatile().description('OneBot 12 正向 WS'),
      listen: Schema.string().default(defaultsOf('core').protocols.onebot12.listen).volatile().description('OneBot 12 反向 WS 监听'),
      httpUrl: Schema.string().default(defaultsOf('core').protocols.onebot12.httpUrl).volatile().description('OneBot 12 HTTP API'),
      accessToken: secretString('OneBot 12 access_token'),
    }),
    satori: Schema.object({
      wsUrl: Schema.string().default(defaultsOf('core').protocols.satori.wsUrl).volatile().description('Satori WS 地址（Koishi 默认 5140）'),
      httpUrl: Schema.string().default(defaultsOf('core').protocols.satori.httpUrl).volatile().description('Satori HTTP API'),
      token: secretString('Satori access token'),
      platform: Schema.string().default(defaultsOf('core').protocols.satori.platform).volatile().description('Satori 平台标识（qq / onebot / discord…）'),
      selfId: Schema.string().default(defaultsOf('core').protocols.satori.selfId).volatile().description('机器人自身 id（留空 = 首条事件里取）'),
    }),
    milky: Schema.object({
      wsUrl: Schema.string().default(defaultsOf('core').protocols.milky.wsUrl).volatile().description('Milky 事件 WS（/event）'),
      httpUrl: Schema.string().default(defaultsOf('core').protocols.milky.httpUrl).volatile().description('Milky API 基址（/api/:api）'),
      accessToken: secretString('Milky access_token'),
    }),
    qqOfficial: Schema.object({
      mode: Schema.union([Schema.const('webhook'), Schema.const('ws')]).default(defaultsOf('core').protocols.qqOfficial.mode).volatile().description('QQ 官方机器人接入方式'),
      appId: Schema.string().default(defaultsOf('core').protocols.qqOfficial.appId).volatile().description('AppID'),
      appSecret: secretString('AppSecret'),
      botSecret: secretString('Webhook 回调校验用 secret'),
      listen: Schema.string().default(defaultsOf('core').protocols.qqOfficial.listen).volatile().description('Webhook 监听地址（端口只能 80/443/8080/8443）'),
      path: Schema.string().default(defaultsOf('core').protocols.qqOfficial.path).volatile().description('Webhook 回调路径'),
      selfId: Schema.string().default(defaultsOf('core').protocols.qqOfficial.selfId).volatile().description('机器人自己的 QQ 号（webhook 模式下用它判断「是否 @ 了我」；留空则退化成「正文里有 @ 就响应」）'),
      streaming: Schema.boolean().default(defaultsOf('core').protocols.qqOfficial.streaming).volatile()
        .description('私聊流式回复（stream_messages，仅官方 API v2 C2C）：开启后用增量桥把中间输出合并成一条流式消息'),
    }),
  }),

  group: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('core').group.enabled).volatile().description('启用群聊'),
    allow: Schema.array(Schema.string()).default(defaultsOf('core').group.allow).volatile().description('群号白名单（空 = 所有群）'),
    requireAt: Schema.boolean().default(defaultsOf('core').group.requireAt).volatile().description('群里必须 @ 机器人才回复'),
  }),
  private: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('core').private.enabled).volatile().description('启用私聊'),
    allow: Schema.array(Schema.string()).default(defaultsOf('core').private.allow).volatile().description('私聊白名单（空 = 所有人）'),
  }),

  commandPrefix: Schema.string().default(defaultsOf('core').commandPrefix).volatile().description('命令前缀（空 = 不限制）'),

  reply: Schema.object({
    maxChars: Schema.number().min(0).max(8000).default(defaultsOf('core').reply.maxChars).volatile().description('单条消息最大字数'),
    ackAfterMs: Schema.number().min(0).max(60000).default(defaultsOf('core').reply.ackAfterMs).volatile().description('慢回复提示阈值（毫秒，0 = 关闭）'),
    ackText: Schema.string().default(defaultsOf('core').reply.ackText).volatile().description('慢回复提示文案'),
    firstTurnHint: Schema.string().default(DEFAULTS.reply.firstTurnHint).description('首轮提示词'),
    stylePrompt: Schema.string().default(DEFAULTS.reply.stylePrompt).volatile()
      .description('输出风格提示（挂成 agent 级 system prompt，只对 QQ 会话生效；留空 = 不注入）'),
    imageHint: Schema.string().default(DEFAULTS.reply.imageHint).volatile()
      .description('图片相关提示（挂成 agent 级 system prompt；留空 = 不注入，改由消息内的提示兜底）'),
    contextHeader: Schema.boolean().default(defaultsOf('core').reply.contextHeader).volatile().description('消息附带来源前缀'),
    botReply: Schema.boolean().default(defaultsOf('core').reply.botReply).volatile()
      .description('被回复（引用）机器人消息时视同 @ 处理并响应（含最近相关发言上下文）'),
    interim: Schema.boolean().default(defaultsOf('core').reply.interim).volatile()
      .description('中间发言：长回合里模型先说的那几句话单独发一条（不引用、不 @），最终结论照常回复'),
    interimMaxPerTurn: Schema.number().min(0).max(20).default(defaultsOf('core').reply.interimMaxPerTurn).volatile()
      .description('中间发言：每个回合最多几条（0 = 关闭）'),
    interimMinGapMs: Schema.number().min(0).max(60000).default(defaultsOf('core').reply.interimMinGapMs).volatile()
      .description('中间发言：两条之间最短间隔（毫秒）'),
    bubbleSplit: Schema.boolean().default(defaultsOf('core').reply.bubbleSplit).volatile()
      .description('按空行把回复拆成多个气泡：2–3 段、每段单行且不超过 80 字时拆分；代码块 / 表格 / 列表 / 标题 / 引用块不拆'),
    bubbleGapMinMs: Schema.number().min(0).max(10000).default(defaultsOf('core').reply.bubbleGapMinMs).volatile()
      .description('气泡之间最短延迟（毫秒）：相邻两个气泡的等待下限'),
    bubbleGapMaxMs: Schema.number().min(0).max(10000).default(defaultsOf('core').reply.bubbleGapMaxMs).volatile()
      .description('气泡之间最长延迟（毫秒）：每个间隔在 [最短, 最长] 里随机取值；与最短相同即固定间隔'),
  }),

  limits: Schema.object({
    perMinute: Schema.number().min(1).max(200).default(defaultsOf('core').limits.perMinute).volatile()
      .description('入站限流：每个（会话, 用户）每分钟最多驱动几个回合'),
    queueMax: Schema.number().min(0).max(20).default(defaultsOf('core').limits.queueMax).volatile()
      .description('同一会话最多排几个待处理回合（超了直接拒收）'),
    maxChars: Schema.number().min(0).max(8000).default(defaultsOf('core').limits.maxChars).volatile()
      .description('单条消息正文上限（超出截断）'),
  }),

  auth: Schema.object({
    owners: Schema.array(Schema.string()).default(defaultsOf('auth').owners).volatile().description('拥有者账号（QQ 号 / OpenID；留空则不驱动任何会话，必填）'),
    superAdmins: Schema.array(Schema.string()).default(defaultsOf('auth').superAdmins).volatile().description('高级管理员 QQ 号'),
    ownerPreset: Schema.string().default(defaultsOf('auth').ownerPreset).volatile().description('拥有者会话的 agent preset（空 = 不分流）'),
    guestPreset: Schema.string().default(defaultsOf('auth').guestPreset).volatile().description('非拥有者会话的 agent preset（空 = 与拥有者共用）'),
    grantTtlMinutes: Schema.number().min(0).max(1440).default(defaultsOf('auth').grantTtlMinutes).volatile().description('动态授权默认时长（分钟）'),
    grantMaxTtlMinutes: Schema.number().min(0).max(10080).default(defaultsOf('auth').grantMaxTtlMinutes).volatile().description('群管理员单次可授最长时长（分钟）'),
    guestToolAllow: Schema.array(Schema.string()).default(defaultsOf('auth').guestToolAllow).volatile().description('访客仍可用的工具白名单（默认 qqgroup/qq_websearch/qq_webfetch/qq_imgsearch/qq_history/qq_sticker；qqbot 与 qqconfig 只给拥有者，moli_fetch 不给访客——它能写文件/eval/读本机 cookie 且不校验内网地址）'),
    guestDshTools: Schema.boolean().default(defaultsOf('auth').guestDshTools).volatile().description('允许非拥有者使用 DSH 内部工具'),
    ownerSettings: Schema.boolean().default(defaultsOf('auth').ownerSettings).volatile()
      .description('允许拥有者在 QQ 私聊里通过 qqconfig 改一部分设置（白名单字段，走 DSH 设置服务，两步确认 + 限流 + 审计）'),
    ownerSettingsMaxPerHour: Schema.number().min(0).max(100).default(defaultsOf('auth').ownerSettingsMaxPerHour).volatile().description('拥有者改设置每小时上限'),
    ownerSettingsMaxPerDay: Schema.number().min(0).max(1000).default(defaultsOf('auth').ownerSettingsMaxPerDay).volatile().description('拥有者改设置每天上限'),
  }),

  moli: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('moli').enabled).volatile()
      .description('启用 Moli 渲染抓取：qq_webfetch 改用 Moli 无头浏览器渲染（可抓 SPA/JS 渲染页）。引擎由 dsh-moli 安装；设置页卡片检测引擎是否就绪，未就绪时开关不可启用。可用范围：拥有者私聊一直可用；群聊与其它私聊（访客）也可用，但必须挂着下面的「内网防护」——关掉它访客就退回普通抓取；Web UI / 子代理等非 QQ 会话不放行'),
    exePath: Schema.string().default(defaultsOf('moli').exePath).volatile()
      .description('moli 可执行文件路径（留空 = 自动探测 ~/.local/bin/moli 与 PATH）'),
    proxy: Schema.string().default(defaultsOf('moli').proxy).volatile()
      .description('渲染抓取的 HTTP 代理（留空 = 透传 webSearch.proxy）'),
    defaultTimeoutMs: Schema.number().min(0).max(300000).default(defaultsOf('moli').defaultTimeoutMs).volatile()
      .description('渲染超时（毫秒），对应 moli 的 -t'),
    maxChars: Schema.number().default(defaultsOf('moli').maxChars).volatile()
      .description('单次渲染输出的字符上限（超出按头尾省略）'),
    insecureTls: Schema.boolean().default(defaultsOf('moli').insecureTls).volatile()
      .description('跳过 TLS 证书校验（默认开；关掉后走严格校验，自签名证书、企业 TLS 拦截或 CRL 不可达时渲染会失败）'),
    guardProxy: Schema.boolean().default(defaultsOf('moli').guardProxy).volatile()
      .description('内网防护：把 moli 的全部流量收进本地校验代理，重定向、子资源、页面 JS 请求一样过内网 IP 黑名单（默认开；关掉只校验入口域名）'),
    allowGuest: Schema.boolean().default(defaultsOf('moli').allowGuest).volatile()
      .description('允许访客渲染：群聊与别人的私聊也能触发无头浏览器（默认开）。关掉后只有拥有者私聊可用，访客退回普通抓取；与「内网防护」相互独立'),
    rateLimitPerMin: Schema.number().min(0).max(600).default(defaultsOf('moli').rateLimitPerMin).volatile()
      .description('每个会话每分钟最多渲染几次（0 = 不限；只影响 moli 渲染，普通抓取不受限）'),
    maxConcurrentRenders: Schema.number().min(0).max(8).default(defaultsOf('moli').maxConcurrentRenders).volatile()
      .description('全局同时最多几个渲染在跑（跨会话，0 = 不限）。一次渲染起一个无头浏览器，并发太多会吃满内存；超出的请求直接返回忙'),
  }),

  admin: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('core').admin.enabled).volatile().description('启用群管理（指令 + qqgroup 工具）'),
    manageGroups: Schema.array(Schema.string()).default(defaultsOf('core').admin.manageGroups).volatile().description('可管理的群号（空 = 回退群号白名单）'),
    requireGroupAdmin: Schema.boolean().default(defaultsOf('core').admin.requireGroupAdmin).volatile().description('承认「本群管理员」这一路权限'),
    prefix: Schema.string().default(defaultsOf('core').admin.prefix).volatile().description('指令前缀（必须在消息首位）'),
    dryRun: Schema.boolean().default(defaultsOf('core').admin.dryRun).volatile().description('演练模式：只回复将执行什么'),
    allowConsole: Schema.boolean().default(defaultsOf('core').admin.allowConsole).volatile().description('允许非 QQ 来源调用管理工具'),
  }),

  perChatSession: Schema.boolean().default(defaultsOf('core').perChatSession).volatile().description('每个 QQ 会话一个独立 DSH 会话'),
  agentPreset: Schema.string().default(defaultsOf('core').agentPreset).volatile().description('Agent preset（默认 standard；空 = 跟随部署默认）'),
  logAdapterFrames: Schema.boolean().default(defaultsOf('core').logAdapterFrames).volatile().description('日志打印适配器每一帧（排错）'),

  vision: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('vision').enabled).volatile().description('图片视觉：QQ 收到图片时进入会话；provider/model 都留空 = 图片作为附件直接提交给会话模型'),
    provider: Schema.string().default(defaultsOf('vision').provider).volatile().description('识图 provider 路由（与 model 都留空 = 复用会话模型，图片当附件直接进会话；填了则先识别再并入文本）'),
    model: Schema.string().default(defaultsOf('vision').model).volatile().description('识图模型 id（与 provider 都留空 = 会话模型自己看图；填了则用该模型识别，如 deepseek-v4-flash-vision-exp）'),
    maxImages: Schema.number().min(1).max(20).default(defaultsOf('vision').maxImages).volatile().description('单条消息最多送入的图片数'),
    downloadTimeoutMs: Schema.number().min(0).max(120000).default(defaultsOf('vision').downloadTimeoutMs).volatile().description('图片下载超时（毫秒）'),
  }),

  // 联网搜索（qq_websearch）：一个**搜索后端优先级**列表 + 每查询条数 + Tavily Key + 代理。
  // DeepSeek 的检索后端走 ctx.web 的 provider，端点与凭据（先官方 key、后 DSH 登录账号）
  // 由 provider 自己选，本插件不填端点、不做回退。
  // 升级到本版时，旧键 maxUses / multiEngine / baseUrl / apiKeyEnv 由 staleConfigPaths 自动清掉。
  webSearch: Schema.object({
    order: Schema.array(Schema.string()).default(defaultsOf('webSearch').order).volatile()
      .description('搜索后端优先级：从上到下依次尝试，某后端未注册/不可用/失败/整批无简介时降级到下一个。'
        + '可填 dsh-qq-bot-free（内置免 Key 多引擎）与任意已注册的 web provider id（如 deepseek-search-api / zhipu-web-search-prime）'),
    perQuery: Schema.number().min(0).max(50).default(defaultsOf('webSearch').perQuery).volatile().description('单条查询最多保留几条来源（0–50，0 = 沿用后端默认）；实际条数还受后端自身限制'),
    tavilyKey: secretString('Tavily API Key（可选）：写入后搜索优先走 Tavily 官方 API，用尽后降级到免 Key 引擎；留空 = 只读环境变量 TAVILY_API_KEY'),
    proxy: Schema.string().default(defaultsOf('webSearch').proxy).volatile().description('搜索与抓取出网用的 HTTP 代理 http://host:port（留空 = 直连；由网络阀门统一管控）'),
  }),

  imgSearch: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('imgSearch').enabled).volatile().description('图片反搜（qq_imgsearch：TraceMoe/IQDB/Yandex/Copyseeker/Tineye/SauceNAO，请求受 webSearch.proxy 管控）；关闭后工具返回「已关闭」'),
    maxResults: Schema.number().min(1).max(20).default(defaultsOf('imgSearch').maxResults).volatile().description('每次图片反搜最多返回结果数'),
    saucenaoKey: secretString('SauceNAO API key（saucenao.com 注册可得）；留空不启用 SauceNAO'),
    weightedShuffle: Schema.boolean().default(defaultsOf('imgSearch').weightedShuffle).volatile().description('有代理时按体量权重随机重排引擎顺序（Yandex/Tineye/Copyseeker 权重高）'),
  }).description('图片反搜'),

  imageGen: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('imageGen').enabled).volatile().description('生图（qq_draw）：关闭后工具直接返回「未启用」'),
    baseUrl: Schema.string().default(defaultsOf('imageGen').baseUrl).volatile().description('生图 API 地址（OpenAI 兼容；会请求 <地址>/images/generations）'),
    apiKeyEnv: Schema.string().default(defaultsOf('imageGen').apiKeyEnv).volatile().description('API key 环境变量名（apiKey 留空时才读它）'),
    apiKey: secretString('生图 API key（只写字段；留空 = 读环境变量）'),
    model: Schema.string().default(defaultsOf('imageGen').model).volatile().description('默认生图模型（如 seedream-5.0-lite / gpt-image-2 / glm-image-1）'),
    size: Schema.string().default(defaultsOf('imageGen').size).volatile().description('默认尺寸（如 1024x1024 / 1024x1536）'),
    timeoutMs: Schema.number().min(0).max(300000).default(defaultsOf('imageGen').timeoutMs).volatile().description('单次请求超时（毫秒）'),
    maxAttempts: Schema.number().min(1).max(10).default(defaultsOf('imageGen').maxAttempts).volatile().description('失败重试次数（含首次）'),
    retryIntervalMs: Schema.number().min(0).max(60000).default(defaultsOf('imageGen').retryIntervalMs).volatile().description('失败重试间隔（毫秒）'),
    poll: Schema.boolean().default(defaultsOf('imageGen').poll).volatile().description('供应商返回 task_id 时继续轮询结果'),
    pollIntervalMs: Schema.number().min(0).max(60000).default(defaultsOf('imageGen').pollIntervalMs).volatile().description('轮询间隔（毫秒）'),
    maxPolls: Schema.number().min(0).max(100).default(defaultsOf('imageGen').maxPolls).volatile().description('最多轮询次数'),
  }).description('生图（qq_draw）'),

  // 表情包图库：**目录就是库**，不额外搬运文件。
  //   <dir>/<系列>/<图>   —— 子目录 = 系列
  //   <dir>/index.json    —— 索引（每个文件的 sha1 + 标签 + 描述），AI 按它挑图
  // 扫描是「先比大小与 mtime，可疑了再算 sha1」：内容没变的图一个字节都不重算，
  // 变了的才清空标签重新打标 —— 这就是「首次使用或文件变动时才重建」的落地方式。
  sticker: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('sticker').enabled).volatile()
      .description('表情包图库：扫描本地目录（每个子目录 = 一个系列）、按文件内容哈希建索引、AI 自动打标；开启后 Agent 可用 qq_sticker 挑图发表情'),
    dir: Schema.string().default(defaultsOf('sticker').dir).volatile()
      .description('表情包目录（留空 = QQ_msg/sticker；相对路径按 QQ_msg 解析）。索引写在目录根部的 index.json'),
    autoTag: Schema.boolean().default(defaultsOf('sticker').autoTag).volatile()
      .description('AI 自动标记：首次使用或文件内容变动（哈希比对）时，只给有变动的图重新打标签与描述'),
    gifCompat: Schema.boolean().default(defaultsOf('sticker').gifCompat).volatile()
      .description('GIF 兼容模式：关闭（默认）时 GIF 原样发给模型打标；开启则在本地解出首帧转 PNG，给不认 image/gif 的模型用'),
    provider: Schema.string().default(defaultsOf('sticker').provider).volatile()
      .description('打标 provider 路由（留空 = 跟随 vision.provider；两者都留空 = 跟随会话模型；复用 DSH 自定义 providers）'),
    model: Schema.string().default(defaultsOf('sticker').model).volatile()
      .description('打标模型 id（留空 = 跟随 vision.model；两者都留空 = 跟随会话模型；必须是支持图片的模型）'),
    maxPerRun: Schema.number().min(1).max(1000).default(defaultsOf('sticker').maxPerRun).volatile()
      .description('一次重建里最多给几张新图打标（超出的留到下次，避免一次烧太多 token）'),
    timeoutMs: Schema.number().min(5000).max(300000).default(defaultsOf('sticker').timeoutMs).volatile()
      .description('单张打标请求超时（毫秒）'),
    chance: Schema.number().min(0).max(1).default(defaultsOf('sticker').chance).volatile()
      .description('主动配图概率（0–1）：模型自己决定配表情包时按这个概率真正发出；用户明确要求不受限'),
    maxPerHour: Schema.number().min(0).max(100).default(defaultsOf('sticker').maxPerHour).volatile()
      .description('同一个群每小时最多发几张表情包（含用户明确要求的），0 = 不限'),
    dupTTLHours: Schema.number().min(0).max(168).default(defaultsOf('sticker').dupTTLHours).volatile()
      .description('同一张图多少小时内不重复发（用户明确要求时不受限），0 = 关'),
    // 偷表情包（issue #97）：群/私聊里别人发的图，模型认得出是「表情包」的收进图库。
    // 收来的图一律进 <dir>/get_stickers 系列，不跟用户自己的系列搅在一起。
    collect: Schema.boolean().default(defaultsOf('sticker').collect).volatile()
      .description('偷表情包（默认关）：按消息元数据（sub_type / summary / .gif）判定是表情包还是普通图片，只把表情包收进图库的 get_stickers 系列'),
    collectMaxMb: Schema.number().min(0.1).max(10).default(defaultsOf('sticker').collectMaxMb).volatile()
      .description('收图大小上限（MB，最大 10）：超过的不收，避免把大照片/原图塞进图库'),
    collectMaxCount: Schema.number().default(defaultsOf('sticker').collectMaxCount).volatile()
      .description('get_stickers 系列的条数上限（0 = 不限）：到上限后不再收新图；配合下面的「自动删最早」则改为滚动替换。只算自动收来的图'),
    collectAutoTrim: Schema.boolean().default(defaultsOf('sticker').collectAutoTrim).volatile()
      .description('收图超上限时自动删除最早收的那些（默认关）：只删 get_stickers 系列里自己收的图，删文件 + 索引同步'),
    collectChance: Schema.number().min(0).max(1).default(defaultsOf('sticker').collectChance).volatile()
      .description('收图概率（0–1）：群里的表情包按这个概率才收进库；0 = 一张都不收，1 = 全收。避免群里刷图时把图库塞爆'),
  }).description('表情包图库（qq_sticker）'),

  persona: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('core').persona.enabled).volatile().description('启用自定义人格：每个新会话第一轮附带身份设定'),
    name: Schema.string().default(defaultsOf('core').persona.name).volatile().description('人格名字'),
    text: Schema.string().default(defaultsOf('core').persona.text).volatile().description('人格设定（性格 / 说话风格 / 禁忌）'),
  }).description('人格（人设）'),

  agentPresetCustom: Schema.string().default(defaultsOf('core').agentPresetCustom).volatile()
    .description('自定义 agent preset id（如 qq）；非空时优先于上面的下拉'),

  history: Schema.object({
    scopeMessages: Schema.number().min(1).max(200).default(defaultsOf('history').scopeMessages).volatile().description('识图往回找几条消息：从触发消息往前，这么多条消息内的图片才会识别（默认 5）'),
    imageLimit: Schema.number().min(1).max(20).default(defaultsOf('history').imageLimit).volatile().description('上面那个范围里最多识别几张图，从最新的开始数（默认 3）'),
  }).description('聊天记录工具（qq_history）'),

  proactive: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('core').proactive.enabled).volatile().description('启用主动发言：按间隔看群里的最近消息，由模型判断是否接话（默认关）'),
    groups: Schema.array(Schema.string()).default(defaultsOf('core').proactive.groups).volatile().description('生效群号（必须显式列；留空 = 不启用）'),
    intervalMinutes: Schema.number().min(5).max(240).default(defaultsOf('core').proactive.intervalMinutes).volatile().description('检查间隔（分钟，最小 5）'),
    windowMessages: Schema.number().min(0).max(100).default(defaultsOf('core').proactive.windowMessages).volatile().description('每次拉取最近多少条消息'),
    minNewMessages: Schema.number().min(0).max(100).default(defaultsOf('core').proactive.minNewMessages).volatile().description('至少有多少条新消息才考虑接话'),
    quietHours: Schema.array(Schema.string()).default(defaultsOf('core').proactive.quietHours).volatile().description('免打扰时段，如 23:00-08:00（可多段）'),
    maxPerHour: Schema.number().min(0).max(60).default(defaultsOf('core').proactive.maxPerHour).volatile().description('每小时最多主动发言次数'),
    maxPerDay: Schema.number().min(0).max(500).default(defaultsOf('core').proactive.maxPerDay).volatile().description('每天最多主动发言次数'),
    minGapMinutes: Schema.number().min(0).max(240).default(defaultsOf('core').proactive.minGapMinutes).volatile().description('两次主动发言最小间隔（分钟）'),
    eventGuard: Schema.boolean().default(defaultsOf('core').proactive.eventGuard).volatile().description('事件去重：跳过过气的事件、只应答一句的插话和刚聊过的话题（关掉 = 退回旧行为，照旧可能重复回复）'),
    staleMinutes: Schema.number().min(1).max(120).default(defaultsOf('core').proactive.staleMinutes).volatile().description('最新消息超过这么多分钟就视为事件已过气，不接话（避免对已经聊完的事重复回复）'),
    topicCooldownMinutes: Schema.number().min(0).max(2880).default(defaultsOf('core').proactive.topicCooldownMinutes).volatile().description('同一话题在这么多分钟内不再重复接话'),
    provider: Schema.string().default(defaultsOf('core').proactive.provider).volatile().description('DSH provider（留空 = 跟随该群会话的模型，和识图一致）'),
    model: Schema.string().default(defaultsOf('core').proactive.model).volatile().description('模型 id（留空 = 跟随该群会话的模型）'),
    speakProvider: Schema.string().default(defaultsOf('core').proactive.speakProvider).volatile().description('发言阶段 provider（留空 = 与判断阶段相同）'),
    speakModel: Schema.string().default(defaultsOf('core').proactive.speakModel).volatile().description('发言阶段模型：填了它才启用两段式——判断只出 JSON，正文由这个模型单独写（留空 = 单段模式）'),
    timeoutMs: Schema.number().min(0).max(300000).default(defaultsOf('core').proactive.timeoutMs).volatile().description('单次判断请求超时（毫秒）'),
    maxChars: Schema.number().min(20).max(2000).default(defaultsOf('core').proactive.maxChars).volatile().description('单条主动发言最大字数'),
    idleTimeoutMs: Schema.number().min(0).max(1800000).default(defaultsOf('core').proactive.idleTimeoutMs).volatile()
      .description('主动回合最长等多久（毫秒）：超时就放弃本次发言并取消残留回合。0 = 不设上限'),
    interests: Schema.string().default(defaultsOf('core').proactive.interests).volatile().description('话题偏好（可空；接什么仍由模型决定）'),
    persona: Schema.string().default(defaultsOf('core').proactive.persona).volatile().description('主动发言用的人设（留空 = 用 persona.text）'),
    dryRun: Schema.boolean().default(defaultsOf('core').proactive.dryRun).volatile().description('演练：只记日志不发送'),
    verbose: Schema.boolean().default(defaultsOf('core').proactive.verbose).volatile().description('日志打印每次判断结果'),
  }).description('主动发言（让 bot 自己找话题接话）'),

  session: Schema.object({
    fixedName: Schema.boolean().default(defaultsOf('core').session.fixedName).volatile().description('固定新建会话名为 私聊_<QQ号> / 群聊_<群号>（替代 LLM 自动起标题）'),
    recallArchived: Schema.boolean().default(defaultsOf('core').session.recallArchived).volatile()
      .description('自动召回已归档会话：QQ 消息触发该会话时把它从 DSH 的「归档」里拉回可见（关闭后归档会话收不到回复）'),
  }).description('会话命名与归档召回'),

  flowAuth: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('flowAuth').enabled).volatile()
      .description('流程授权：子代理 / 队友 / 工作流开跑前，主人在私聊里回 6 位动态码（标准 TOTP，无万能码）'),
    totpSecret: secretString('TOTP 密钥（base32；在服务器上 node lib/valve/security/totp-cli.mjs enroll 生成后粘到这里，密钥不经 QQ）'),
    enrolledAt: Schema.number().default(defaultsOf('flowAuth').enrolledAt).volatile()
      .description('确认绑定的时间戳（0 = 未确认；确认后设置页不再展示二维码与明文）'),
    grantTtlSeconds: Schema.number().min(30).max(3600).default(defaultsOf('flowAuth').grantTtlSeconds).volatile().description('一次授权的有效期（秒，默认 30；小于 30 按 30 处理）'),
    maxAttempts: Schema.number().min(1).max(20).default(defaultsOf('flowAuth').maxAttempts).volatile().description('连续输错几次锁定'),
    lockoutMinutes: Schema.number().min(1).max(1440).default(defaultsOf('flowAuth').lockoutMinutes).volatile().description('锁定时长（分钟）'),
    gatedTools: Schema.array(Schema.string()).default(defaultsOf('flowAuth').gatedTools).volatile()
      .description('要授权才能用的工具名（逗号分隔；开启动态码后改这份名单要填一次动态码）'),
    gateEditCode: secretString('改闸门名单时一次性填写的动态码（校验通过后自动清空；不填则本次改动会被回滚）'),
    recoveryHashes: Schema.array(Schema.string()).default(defaultsOf('flowAuth').recoveryHashes).volatile()
      .description('恢复码的 scrypt 哈希（hex，盐填 recoverySalt；一次性；留空 = 不支持恢复码）'),
    recoverySalt: secretString('恢复码哈希用的盐'),
  }).description('流程授权（私聊二次验证）'),
  flow: Schema.object({
    deliver: Schema.string().default(defaultsOf('core').flow.deliver).volatile().description('产物投递：private / group:<群号> / none'),
    maxBytes: Schema.number().default(defaultsOf('core').flow.maxBytes).volatile().description('产物打包上限（字节）'),
    maxFiles: Schema.number().default(defaultsOf('core').flow.maxFiles).volatile().description('最多打包文件数'),
    skipHidden: Schema.boolean().default(defaultsOf('core').flow.skipHidden).volatile().description('跳过以 . 开头的文件与目录'),
  }).description('流程产物投递'),
  restart: Schema.object({
    baseMs: Schema.number().default(defaultsOf('core').restart.baseMs),
    maxMs: Schema.number().default(defaultsOf('core').restart.maxMs),
  }),
  updateCheck: Schema.object({
    enabled: Schema.boolean().default(defaultsOf('core').updateCheck.enabled).volatile()
      .description('探测上游新版本并在设置页提示（只提示、不自动升级；6 小时内最多查一次）'),
  }).description('新版本探测'),
}).description('把 QQ 接到 DSH Agent（OneBot 11 / Milky / Satori 等协议）');

// 安全护栏：JSON 里声明的 group 必须在 schema 里存在。
// 少了这一步，一个笔误（group 写成 webSerach）会让这组默认值成为「schema 不认识的键」，
// 而 staleConfigPaths 恰恰是拿 schema 判断哪些键是废弃字段——启动清理会把它当垃圾删掉，
// 用户配置静默丢失。宁可在加载时就炸，也不要带着这种坑跑。
const unknownDefaultGroups = Object.keys(JSON_DEFAULTS)
  .filter((group) => Config.dict === undefined || Config.dict === null || Config.dict[group] === undefined);
if (unknownDefaultGroups.length > 0) {
  const where = unknownDefaultGroups
    .map((group) => group + '（' + DEFAULTS_SOURCES.filter((s) => s.group === group).map((s) => s.file).join('、') + '）')
    .join('；');
  throw new Error('默认配置 JSON 声明的 group 不在 Config schema 里：' + where
    + '。要么改 JSON 的 group，要么在 Config 里补上对应字段');
}

// 反向护栏：核心组 JSON 里**每个叶子**都必须在 schema 里存在，且每个 schema 叶子都要有默认值。
//
// 为什么必须有反向这一半：上面那条只查顶层键，缺一个嵌套叶子（比如删掉 group.requireAt）
// 加载期不报错，DEFAULTS 与 schema 求值都变成 undefined；而消费方多半写成 `=== true` 判据
// （turn-runtime 的 requireAt 就是这样），于是群聊悄悄不再要求 @ —— 权限被静默放宽。
// 这类「缺一个字段就改行为」的配置，必须在启动时就炸，而不是等线上发现。
const coreLeafPaths = (() => {
  const out = [];
  const walk = (value, prefix) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) walk(value[key], prefix.concat(key));
      return;
    }
    out.push(prefix);
  };
  for (const key of Object.keys(CORE_FROM_JSON)) walk(CORE_FROM_JSON[key], [key]);
  return out;
})();
// 方向 1（JSON → schema）：JSON 里写了 schema 不认识的东西；
const coreLeavesMissingInSchema = coreLeafPaths.filter((leaf) => schemaHasPath(leaf) !== true);
if (coreLeavesMissingInSchema.length > 0) {
  throw new Error('核心默认值里有 schema 不认识的叶子：'
    + coreLeavesMissingInSchema.map((leaf) => leaf.join('.')).join('、')
    + '（来自 core-conf.json）。要么在 Config 里补上字段，要么从 JSON 里删掉——'
    + '否则这个键在运行期会被当成废弃字段清理，用户看到「改了又变回去」');
}


// ------------------------------------------------------------ 设置页模板的三道护栏
// 与默认值那边的 group 护栏同理：模板写错一个字母，不该在运行时变成「配置莫名其妙丢了」，
// 而应该在**加载时就炸**，并且指名是哪个文件的哪个字段。

/** 沿着 schema 的 dict 走一遍 path，返回该位置是否真实存在。 */
function schemaHasPath(path) {
  let cursor = Config;
  for (const segment of path) {
    // 注意：schema 的 dict 里存的是 Schema 构造器本身（typeof 是 'function'），不是普通对象。
    // 只判 'object' 会把每一层都判成不存在。
    if (cursor === null || cursor === undefined) return false;
    if (typeof cursor !== 'object' && typeof cursor !== 'function') return false;
    const dict = cursor.dict;
    if (dict === null || dict === undefined) return false;
    if (Object.prototype.hasOwnProperty.call(dict, segment) !== true) return false;
    cursor = dict[segment];
  }
  return true;
}

/** 设置页的标签页骨架（连接 / 基本 / 能力 / 高级 + 各自二级标签）。 */
export const SETTINGS_TABS = PAGE.tabs;

/**
 * 「网络搜索」卡片随模板一起下发的数据：默认优先级 / 上限 / 展示名。
 * 客户端只允许 require('react')，读不到 lib/tools/websearch.js，所以这份对照表由服务端带下去
 * （route-settings 下发，测试的模板桩也从这里取，两边不各写一份）。
 */
export const SETTINGS_SEARCH_ORDER = Object.freeze({
  defaults: SEARCH_DEFAULT_ORDER.slice(),
  max: SEARCH_ORDER_MAX,
  perQueryMax: SEARCH_PER_QUERY_MAX,
  labels: BACKEND_LABELS,
});

const settingsProblems = [];
for (const field of SETTINGS_FIELDS) {
  const where = field.source + ' → ' + field.label + '（' + field.path.join('.') + '）';
  // 1) 字段必须真的存在于 Config schema。写错路径的话，这条字段永远不会被渲染成有效配置，
  //    更糟的是 staleConfigPaths 会把用户存进去的值当成废弃键删掉。
  if (field.virtual !== true && schemaHasPath(field.path) !== true) {
    settingsProblems.push(where + '：路径不在 Config schema 里');
    continue;
  }
  // 2) 标签页与二级标签必须存在，否则字段会掉进一个谁也点不到的页。
  const tab = PAGE.byId.get(field.tab);
  if (tab === undefined) {
    settingsProblems.push(where + '：tab "' + field.tab + '" 不在设置页骨架里');
    continue;
  }
  if (field.subtab !== null && tab.subs.some((sub) => sub.id === field.subtab) !== true) {
    settingsProblems.push(where + '：subtab "' + field.subtab + '" 不在标签页 "' + field.tab + '" 下');
  }
}
if (settingsProblems.length > 0) {
  throw new Error('设置页模板有问题：\n  ' + settingsProblems.join('\n  '));
}

// cordis 的配置引用标记（cosmokit 的共享 symbol），用于把 volatile 字段还原成普通值。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const isVolatileRef = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value;

/** 把（可能含 volatile 引用的）已解析配置还原成普通对象。 */
function plainConfig(value) {
  if (isVolatileRef(value)) return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plainConfig(value[key]);
    return out;
  }
  return value;
}

/** 只递归合并普通对象；数组/标量直接覆盖 */
function mergeConfig(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? out : override;
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined) continue;
    const current = out[key];
    if (current !== null && typeof current === 'object' && !Array.isArray(current)
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const describeError = (error) => (error === null || error === undefined) ? String(error)
  : (typeof error === 'string' ? error : (typeof error.message === 'string' ? error.message : String(error)));

/**
 * 找出 patch 层里 schema 不认识的键（版本升级删掉的旧字段就长这样）。
 *
 * 只报最浅的一层：整段不认识的子树报一次就够，删掉父键下面自然全没了。
 * 数组、以及没有 dict 的 schema 节点都算叶子——里面的内容由用户决定，不检查。
 *
 * 返回「路径数组」而不是点号字符串：配置键名本身可能带点（如 'a.b'），
 * 用点号拼路径再拆回来会删错键——字面键 'a.b' 会被当成 a 下面的 b。
 *
 * @param {Record<string, any>} raw patch 层里的显式配置
 * @param {object} [schema] 默认用本插件的 Config
 * @returns {string[][]} 每个元素是一条键路径，例如 ['proactive', 'judgeProvider']
 */
export function staleConfigPaths(raw, schema) {
  const root = schema === undefined || schema === null ? Config : schema;
  const out = [];
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return out;
  // !!js 表达式（DSH 配置里允许的 js-yaml 标签）解析出来是类实例，不是配置子树。
  // 不跳过的话 cleanup 会把它当成「未知子键」整段删掉，用户的表达式被静默换回默认值。
  const isOpaque = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return true;
    if (Object.getOwnPropertySymbols(value).length > 0) return true;
    return Object.prototype.hasOwnProperty.call(value, '__jsExpr');
  };
  const walk = (value, node, trail) => {
    // 未知键：哪怕值是 null 也算残留（以前 null/undefined 直接 return，这类脏键永远清不掉）。
    if (node === undefined || node === null) { out.push(trail); return; }
    if (value === null || value === undefined) return;
    if (isOpaque(value) === true) return;
    if (node.dict === undefined || node.dict === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      // DSH 把 !!js 表达式存成 { __jsExpr: ... } 这种带下划线前缀的包装键，不是配置子键。
      if (key.startsWith('__') === true) continue;
      const child = Object.prototype.hasOwnProperty.call(node.dict, key) ? node.dict[key] : undefined;
      walk(value[key], child, trail.concat(key));
    }
  };
  walk(raw, root, []);
  return out;
}

export { DEFAULTS, plainConfig, mergeConfig, describeError };

// 方向 2（schema → JSON）才是这次的关键：JSON **少写**一个叶子时方向 1 完全看不见
// （缺的键根本不在 coreLeafPaths 里），而 schema 那边照样求值，两侧出现「schema 有、JSON 没有」
// 的缺口——消费方写成恒等判据的写法会拿到 undefined：轻则群聊悄悄不再要求 @，重则权限放宽。
//
// 判据不能依赖 meta.default：JSON 漏写字段时 defaultsOf 返回 undefined，meta.default 也跟着没了，
// 缺口自己就消失（等于没查）。所以改用「非密钥叶子都必须有默认值」这条硬规则——
// 密钥叶子（role=secret）是唯一合法的无默认值字段，它们本来就该在 DEFAULTS 里缺席。
const schemaNonSecretLeaves = (() => {
  const out = [];
  const walk = (node, prefix) => {
    // schema 的 dict 里存的是 Schema 构造器本身（typeof 是 'function'），
    // 只判 'object' 会让每一层都走不进去、叶子数为 0，这条护栏就成了摆设。
    if (node === null || node === undefined) return;
    if (typeof node !== 'object' && typeof node !== 'function') return;
    const dict = node.dict;
    if (dict !== null && dict !== undefined && typeof dict === 'object') {
      for (const key of Object.keys(dict)) walk(dict[key], prefix.concat(key));
      return;
    }
    const meta = node.meta;
    const role = (meta === null || meta === undefined) ? undefined : meta.role;
    if (role === 'secret') return;
    out.push(prefix);
  };
  walk(Config, []);
  return out;
})();
const defaultsMissingLeaves = schemaNonSecretLeaves.filter((leaf) => {
  let cursor = DEFAULTS;
  for (const segment of leaf) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return true;
    if (Object.prototype.hasOwnProperty.call(cursor, segment) !== true) return true;
    cursor = cursor[segment];
  }
  return cursor === undefined;
});
if (defaultsMissingLeaves.length > 0) {
  throw new Error('schema 有字段、DEFAULTS 里却没有默认值的叶子：'
    + defaultsMissingLeaves.map((leaf) => leaf.join('.')).join('、')
    + '。多半是 core-conf.json 漏写了——运行期会变成 undefined，'
    + '而恒等判据会把它当成 false（行为静默放宽）。补回 JSON 即可');
}

// 核心组的原始 JSON（摊平前的形态）：测试用它逐个叶子核对 schema 是否覆盖了每个字段。
