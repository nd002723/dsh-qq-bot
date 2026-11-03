/**
 * 网关层入口 —— 路由挂载的统一入口。
 *
 * 本插件的「路由」有两类，以前分散在两处挂载，改一个忘一个：
 *   1. **HTTP 路由**：挂在 DSH webServer 上，与设置页同源（扫码绑定两条 + 默认值一条 + 设置页模板一条）；
 *   2. **消息路由**：入站帧 → 会话 → 出站，走的是适配器管道（见 plugin.js）。
 *
 * 这里把 1 收成一张表：新增路由只往 ROUTE_MOUNTS 里加一条，挂载点、注销时机、
 * 失败降级（webServer 不可用时静默跳过）全部由本文件统一处理，调用方只管给依赖。
 *
 * 设计要点：
 *   - 挂载失败只打一行日志，绝不影响收发消息（桌面端没有 webServer 是正常情况）；
 *   - 每条路由返回自己的 unregister，卸载时按注册的逆序注销；
 *   - 路由处理器不接触密钥：需要密钥的动作只走回调，不进 HTTP 响应。
 */

import { registerBindRoutes } from './routes-bind.js';
import { registerDefaultsRoutes } from './routes-defaults.js';
import { registerSettingsRoutes } from './routes-settings.js';
import { registerStickerRoutes } from './routes-sticker.js';

/**
 * HTTP 路由表。每项：
 *   id      路由组标识（日志用）
 *   mount   挂载函数，返回 { ok, error?, unregister }
 *   needs   该路由组需要的依赖键（缺了就不挂，不报错）
 */
const ROUTE_MOUNTS = [
  { id: 'bind', needs: ['webServer', 'bind'], mount: (deps) => registerBindRoutes(deps) },
  { id: 'defaults', needs: ['webServer'], mount: (deps) => registerDefaultsRoutes(deps) },
  { id: 'settings', needs: ['webServer'], mount: (deps) => registerSettingsRoutes(deps) },
  // 表情包：状态 + 后台重建（设置页卡片的按钮与进度都走它）。
  { id: 'sticker', needs: ['webServer', 'sticker'], mount: (deps) => registerStickerRoutes(deps) },
];

/**
 * 把全部 HTTP 路由挂到 DSH webServer 上。
 *
 * @param {Record<string, any>} deps 路由依赖（webServer / bind / boundAppId / log ...）
 * @returns {{ok: boolean, mounted: string[], unregister: () => void, skipped: Array<{id: string, error: string}>}}
 */
export function mountHttpRoutes(deps) {
  const log = (typeof deps.log === 'function') ? deps.log : () => {};
  const mounted = [];
  const skipped = [];
  const disposers = [];

  for (const route of ROUTE_MOUNTS) {
    const missing = route.needs.filter((key) => deps[key] === undefined || deps[key] === null);
    if (missing.length > 0) {
      skipped.push({ id: route.id, error: '缺少依赖：' + missing.join(',') });
      continue;
    }
    try {
      const registered = route.mount(deps);
      if (registered !== null && registered !== undefined && registered.ok === true) {
        mounted.push(route.id);
        disposers.push(() => {
          try { registered.unregister(); } catch (error) { /* 注销失败不影响卸载 */ }
        });
      } else {
        skipped.push({ id: route.id, error: (registered && registered.error) || '未注册' });
      }
    } catch (error) {
      skipped.push({ id: route.id, error: String(error && error.message ? error.message : error) });
    }
  }

  for (const item of skipped) log('路由 ' + item.id + ' 未挂载：' + item.error);
  if (mounted.length > 0) log('已挂载路由：' + mounted.join(', '));

  return {
    ok: skipped.length === 0,
    mounted,
    skipped,
    // 逆序注销：后挂的先拆，避免依赖倒挂
    unregister: () => {
      for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]();
    },
  };
}

/**
 * 在 Cordis 服务上下文里挂路由：等 webServer 服务就绪再挂，卸载时自动注销。
 * @param {Record<string, any>} ctx 插件上下文
 * @param {(webServer: Record<string, any>) => Record<string, any>} buildDeps 用 webServer 组装路由依赖
 * @param {(line: string) => void} log
 */
export function mountRoutesWhenReady(ctx, buildDeps, log) {
  const say = (typeof log === 'function') ? log : () => {};
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        const service = (webCtx.webServer !== undefined && webCtx.webServer !== null)
          ? webCtx.webServer
          : (typeof webCtx.get === 'function' ? webCtx.get('webServer') : undefined);
        const mounted = mountHttpRoutes(buildDeps(service));
        return () => mounted.unregister();
      });
    });
    return { ok: true };
  } catch (error) {
    say('路由挂载入口不可用（不影响收发消息）：' + String(error && error.message ? error.message : error));
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

