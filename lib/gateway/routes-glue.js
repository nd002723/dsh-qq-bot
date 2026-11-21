// 扫码绑定 / 版本探测 / 路由挂载的接线层。
// 从 gateway/plugin.js 搬出（P3 2.4 第二阶段，只搬不改）：状态机在 api/qq-bind.js，
// 版本探测在 api/update-check.js，路由鉴权在 route-auth.js；这里只负责把它们接起来。
import { createQqBind, loadOfficialConnect } from '../api/qq-bind.js';
import { createUpdateChecker, fetchJsonDefault, readPackageVersion } from '../api/update-check.js';
import { createRouteGuard } from './route-auth.js';
import { mountRoutesWhenReady } from './index.js';

export function createRouteGlue(deps) {
  const { ctx, TAG, getConfig, getState, setConfig, writeSettingsPatch, packageUrl, resolveConfig } = deps;
  /**
   * 可选的搜索后端目录（设置页「网络搜索」卡片的排序表用）：
   * 内置的只有「免 Key 多引擎」一家（DeepSeek Messages 那条已经从本插件删掉了），
   * 其余全部来自 web seam 的注册表（注册顺序即列表顺序）。
   * 只回 id + 展示名，不回任何配置值。
   */
  const listSearchBackends = () => {
    // 只有「内置免 Key 多引擎」是本插件自己的后端；其余一律来自 provider 注册表。
    // 列表该反映「真的能选什么」——写死一个没挂载的 id，用户勾了也只会被静默跳过。
    const builtin = [
      { id: 'dsh-qq-bot-free' },
    ];
    const registered = [];
    try {
      const web = (typeof ctx.get === 'function') ? ctx.get('web') : undefined;
      const registry = (web !== null && web !== undefined) ? web.searchProviders : undefined;
      if (registry !== undefined && registry !== null && typeof registry.forEach === 'function') {
        registry.forEach((provider, id) => {
          if (typeof id !== 'string' || id === '') return;
          if (builtin.some((item) => item.id === id)) return;
          registered.push({ id });
        });
      }
    } catch (error) { /* 注册表拿不到：只给内置那一家，不影响搜索本身 */ }
    return builtin.concat(registered);
  };
  // SDK 动态 import（本项目仍然零运行时依赖）：装了 @tencent-connect/qqbot-connector 才有「扫码」，
  // 没装就由客户端退回手动填 AppID/AppSecret。凭据经设置服务落盘，appSecret 不进 HTTP 响应。
  const qqBind = createQqBind({
    connect: async (callbacks, options) => {
      const startFn = await loadOfficialConnect((line) => console.log(TAG + ' ' + line));
      if (typeof startFn !== 'function') {
        throw new Error('扫码绑定需要 @tencent-connect/qqbot-connector：在 profile 里安装后重启插件，或手动填 AppID/AppSecret');
      }
      return startFn(callbacks, options);
    },
    onCredentials: async (creds) => {
      const written = await writeSettingsPatch({ protocols: { qqOfficial: { appId: creds.appId, appSecret: creds.appSecret } } });
      if (written.ok !== true) throw new Error(written.error);
      setConfig(resolveConfig());
      console.log(TAG + ' 扫码绑定完成：AppID ' + creds.appId + ' 已写入设置');
    },
    log: (line) => console.log(TAG + ' ' + line),
  });
  // 新版本探测：server 端拉 registry，设置页只读状态（见 lib/api/update-check.js）。
  const updateChecker = createUpdateChecker({
    currentVersion: readPackageVersion(packageUrl),
    dshVersion: String((getState().dsh !== undefined && getState().dsh !== null && getState().dsh.version !== undefined) ? getState().dsh.version : ''),
    fetchJson: (url) => fetchJsonDefault(url),
    enabled: () => getConfig().updateCheck === undefined || getConfig().updateCheck === null || getConfig().updateCheck.enabled !== false,
  });
  // 路由挂载走网关层统一入口（gateway/index.js 的 ROUTE_MOUNTS 表）：
  // webServer 不可用时静默跳过，桌面端没有该服务是正常情况。
  // 路由鉴权：插件具名路由在 DSH 鉴权层之前处理，所以自己过一遍 cookie 校验（见 route-auth.js）。
  const routeGuard = createRouteGuard(ctx, (line) => console.log(TAG + ' ' + line));
  mountRoutesWhenReady(ctx, (service) => ({
    webServer: service,
    guard: routeGuard,
    bind: qqBind,
    update: updateChecker,
    // 去空白：只有空格时不该算「已绑定」——/bind 响应的 appId 会被前端与第三方直接当真值用。
    boundAppId: () => String(getConfig().protocols.qqOfficial.appId || '').trim(),
    // 表情包卡片：状态查询 + 后台重建（见 routes-sticker.js）。
    sticker: deps.sticker,
    // 表情包状态里要回一个「图库根目录」给卡片显示，路由不 direct import session/，从这里带下去。
    qqMsgRootSync: deps.qqMsgRootSync,
    // 搜索后端目录：设置页「网络搜索」卡片的排序表要用（id + 展示名，不含配置值）。
    listSearchBackends,
    log: (line) => console.log(TAG + ' ' + line),
  }), (line) => console.log(TAG + ' ' + line));

  return { qqBind, updateChecker, routeGuard };
}
