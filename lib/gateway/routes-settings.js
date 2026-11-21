/**
 * 设置页模板的数据源（挂在 DSH webServer 上，和设置页同源）。
 *
 * 一条：
 *   GET /dsh-qq-bot/settings   返回整页模板：标签页骨架 + 全部字段
 *
 * 为什么要有这条路由：设置页的字段定义不再写死在客户端 bundle 里，而是散在
 * 各所有者目录的 `-set.json`（`lib/tools/*-set.json`、`lib/valve/<阀门>/*-set.json`）。
 * 客户端 bundle 读不到 lib/ 下的文件（它只允许 `require('react')`），所以由服务端
 * 在加载期组装好，运行时按需下发。
 *
 * 设计要点：
 *   - **只回模板，不回配置值**。字段里没有 label 之外的用户数据；默认值走 /defaults 那条。
 *   - 模板是加载期常量，组装时就已校验过（路径在 schema 里、标签页存在），
 *     所以这里不会再出错——真出错会在插件启动时就抛出来。
 *   - 加一个字段 = 改对应 `-set.json`，不用碰客户端代码，也不用重新打包。
 *   - webServer 不可用时静默跳过（桌面端没有该服务是正常情况），
 *     设置页会退化成「读不到模板，请检查插件版本」，不影响其它功能。
 */

import { SETTINGS_TABS, SETTINGS_FIELDS, SETTINGS_SOURCES, SETTINGS_SEARCH_ORDER } from '../config.js';
// 闸门保护面清单：客户端保存前要用它判断「这次是不是动了保护面」，只下发字段名不含值。
import { GATE_SECURITY_FIELDS } from '../valve/tool/gate-guard.js';

export const SETTINGS_PATH = '/dsh-qq-bot/settings';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function registerSettingsRoutes(deps) {
  const webServer = deps === undefined || deps === null ? undefined : deps.webServer;
  const log = (deps !== undefined && deps !== null && typeof deps.log === 'function') ? deps.log : () => {};
  // 鉴权闸门由调用方注入（见 route-auth.js）；拿不到就放行，保持桌面端/老版本可用。
  const guard = (deps !== undefined && deps !== null && typeof deps.guard === 'function') ? deps.guard : () => true;
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    return { ok: false, error: 'webServer 服务不可用（设置页会退化成读不到模板）', unregister: () => {} };
  }

  const handleSettings = async (req, res) => {
    if (guard(req, res) !== true) return;
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    // 新版本提示随模板一起下发：客户端不必再单独发一次 fetch（少一条路由、少一次外网探测）。
    let update = null;
    try {
      if (deps !== undefined && deps !== null && deps.update !== undefined && deps.update !== null
        && typeof deps.update.check === 'function') update = await deps.update.check();
    } catch (error) { update = null; }
    // 搜索后端的目录：内置的只有免 Key 多引擎一家 + web seam 里已注册的 provider。
    // 只下发 id 与展示名，不含任何配置值；可用性由后端在执行时判定并按列表自动降级。
    let searchBackends = [];
    try {
      if (deps !== undefined && deps !== null && typeof deps.listSearchBackends === 'function') {
        searchBackends = deps.listSearchBackends();
      }
    } catch (error) { searchBackends = []; }
    json(res, 200, {
      ok: true,
      tabs: SETTINGS_TABS,
      fields: SETTINGS_FIELDS,
      // 只给「哪个文件贡献了几个字段」，方便排错；不含任何配置值。
      sources: SETTINGS_SOURCES,
      update,
      // 「网络搜索」卡片要用的：默认优先级、上限、展示名（编译期常量）+ 运行时可选后端目录。
      searchOrder: {
        defaults: SETTINGS_SEARCH_ORDER.defaults.slice(),
        max: SETTINGS_SEARCH_ORDER.max,
        perQueryMax: SETTINGS_SEARCH_ORDER.perQueryMax,
        backends: searchBackends,
        labels: SETTINGS_SEARCH_ORDER.labels,
      },
      // 闸门「保护面」字段名：客户端保存前要用它判断「这次是不是动了保护面」，
      // 否则会出现「界面说已保存、服务端静默回滚」的假成功。只泄露字段名（不含值），
      // 与已经下发的 sources 同一性质。清单以服务端为准，避免客户端硬编码第二份。
      gateSecurityFields: GATE_SECURITY_FIELDS,
    });
  };

  const unregisters = [];
  try {
    unregisters.push(webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: handleSettings }));
  } catch (error) {
    log('注册设置页模板路由失败：' + String(error && error.message ? error.message : error));
    for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } }
    return { ok: false, error: '注册路由失败：' + String(error && error.message ? error.message : error), unregister: () => {} };
  }
  return {
    ok: true,
    unregister: () => { for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } } },
  };
}
