/**
 * 网络阀门（network valve）—— 一切出网动作的唯一闸口。
 *
 * 职责边界：
 *   policy.js    回答「这个目标能不能出站」（公网判定、内网黑名单、钉地址、DNS rebinding）
 *   guard-proxy  给无头浏览器兜底的本地校验代理（moli 会跟 3xx、拉子资源、跑页面 JS）
 *   本文件        回答「这次出网用什么策略」——代理怎么取、上限多少、抓回来怎么截断
 *
 * 为什么必须收成一处：以前 websearch / imgsearch / moli 三条路径各写一遍代理语义，
 * 漂移出三种行为（有的带超时没体积上限、有的连校验对象和执行对象都不是同一个字符串）。
 * 现在所有出网都从这里拿「策略对象」，判定与执行绑定在同一次调用里。
 *
 * 红线：代理只能作用于**出网**，永远不作用于回环地址；本地校验永远发生在最前面，
 * 链路上游换节点也不影响判定结果。
 */

import { isIP } from 'node:net';
import {
  canonicalHost, isNonPublicIp, resolvePublicAddresses, assertPublicHost,
  bareHost,
} from './policy.js';
import {
  publicFetch, fetchUrlViaProxy, multiEngineRequest, webSearchPost, __setProxyResolver,
} from '../../shared/http.js';
import { createGuardProxy } from './guard-proxy.js';

/** 阀门在组装顺序里的位置（最外层：任何网络动作之前必须先成型）。 */
export const VALVE_STAGE = 10;

/** 默认超时与体积上限：调用方可按需收紧。
 *  注意超时**比 shared/http.js 的 15000 更宽**——这里多一跳本地代理，把上游超时也算在内。 */
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 本机保留名：这些名字一律不进代理（也不能出站）。 */
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private)$/i;

/**
 * 回环 / 本机地址：代理只管出网，本机地址永远绕过代理。
 *
 * 注意判定口径：只有「IP 字面量」与「本机保留名」才算本机。
 * 域名（example.com）同步判不出来，**不能**因为判不出来就当成内网——
 * 那会把所有正常域名都踢出代理。域名交给 assertHost 去解析判定。
 */
function isLoopbackHost(host) {
  const bare = bareHost(host);
  if (bare === '') return false;
  if (LOCAL_SUFFIX.test(bare) === true) return true;
  if (isIP(bare) === 0) return false;
  return isNonPublicIp(bare);
}

/**
 * @param {object} deps
 * @param {() => string} [deps.proxy] 出网代理（'' = 直连）；每次现取以支持热更新
 * @param {(line: string) => void} [deps.log]
 */
export function createNetworkValve(deps = {}) {
  const proxyOf = typeof deps.proxy === 'function' ? deps.proxy : () => '';
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** 当前出网代理（空串 = 直连）。 */
  const proxy = () => {
    const value = proxyOf();
    return (value === undefined || value === null) ? '' : String(value).trim();
  };

  // 阀门成型即接管传输层的代理策略（stage 10，早于任何出网动作）。
  // 从此以后 shared/http.js 不再读配置：工具层拿不到代理串，也就没法绕开阀门。
  __setProxyResolver(proxy);

  /**
   * 同步判定「这个目标能不能出站」。
   *
   * 口径：**能证明是内网的才拒绝**，判不出来（域名）返回 true，由 assertHost 解析后再判。
   * 反过来的口径（判不出来就拒绝）会把所有正常域名都拦掉；而真正要拦的域名，
   * assertHost 会在解析后逐个地址校验，拦得住。
   */
  const isAllowedTarget = (host) => {
    const host_ = canonicalHost(host);
    if (host_ === '') return false;
    const bare = bareHost(host_);
    if (LOCAL_SUFFIX.test(bare) === true) return false;
    if (isIP(bare) === 0) return true;
    return isNonPublicIp(bare) !== true;
  };

  return Object.freeze({
    stage: VALVE_STAGE,

    // ────────────────────────────────────────────────────────────────
    // 接口一：网络流量管控
    // 所有出网动作都从这里走：代理怎么取、超时多少、体积怎么截断，
    // 判定与执行绑定在同一次调用里，调用方只说「意图」，拿不到代理串。
    // ────────────────────────────────────────────────────────────────
    traffic: Object.freeze({
      /**
       * 抓取网页原文：走本阀门的代理语义。
       * @param {string} url
       * @param {{timeoutMs?: number, maxBytes?: number, binary?: boolean, useProxy?: boolean}} [options]
       */
      fetchText: (url, options = {}) => {
        const opts = options === null || options === undefined ? {} : options;
        const timeoutMs = Math.max(1000, Math.floor(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
        const maxBytes = Math.max(1024, Math.floor(Number(opts.maxBytes) || DEFAULT_MAX_BYTES));
        // 回环地址一律拒绝（不是「绕过代理直连」）：本地服务不该被外部节点转一手，
        // 也不该被插件当跳板——wantProxy=false 之后 publicFetch 仍会拒非公网地址。
        const target = (() => { try { return new URL(String(url)); } catch (error) { return null; } })();
        const wantProxy = opts.useProxy === true && target !== null && isLoopbackHost(target.hostname) !== true;
        // 两条分支的返回契约必须一致：调用方（qq_webfetch 等）统一读 `text`。
        // 直连走 publicFetch，它给的是 `body`；不映射的话调用方永远读到 undefined，于是「抓到了但正文为空」——页面看着成功、内容全是空的。
        // maxBytes / binary 也要一起带下来，否则代理分支悄悄丢掉体积上限（无上限读全文）。
        if (wantProxy === true && proxy() !== '') {
          return fetchUrlViaProxy(url, { useProxy: true, timeoutMs });
        }
        return publicFetch(url, { timeoutMs, maxBytes, binary: opts.binary === true })
          .then((res) => ({ status: res.status, text: res.body, finalUrl: res.finalUrl, truncated: res.truncated }));
      },
      /** 带代理语义的通用请求（搜索/反搜引擎共用，直连与隧道同一套上限与超时）。 */
      request: (method, url, headers, body, options = {}) => {
        const opts = options === null || options === undefined ? {} : options;
        return multiEngineRequest(method, url, headers, body, {
          useProxy: opts.useProxy !== false,
          timeoutMs: Math.max(1000, Math.floor(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS)),
          binary: opts.binary === true,
        });
      },
      /** 搜索类 POST（与 request 同一套代理语义）。 */
      post: (endpoint, headers, body, options = {}) => {
        const opts = options === null || options === undefined ? {} : options;
        return webSearchPost(endpoint, headers, body, { useProxy: opts.useProxy !== false });
      },
      /** 本地校验代理：给无头浏览器兜底（逐条请求先过策略层，内网目标 403）。 */
      createGuardProxy: (options) => createGuardProxy(Object.assign({ log }, options)),
    }),

    // ────────────────────────────────────────────────────────────────
    // 接口二：代理状态（只读）
    // 只回答「有没有配 HTTP 代理」，不含任何判定或出网能力。
    // 用途：插件/工具读它来决定自己的行为（例如某些搜索/反搜引擎只在走代理时可用），
    // 而不是自己去嗅探配置或代理串——代理串永远不交给工具层。
    // ────────────────────────────────────────────────────────────────
    proxyStatus: Object.freeze({
      /** 当前是否配了出网 HTTP 代理（true = 走代理，false = 全部直连）。 */
      hasProxy: () => proxy() !== '',
    }),

    // ────────────────────────────────────────────────────────────────
    // 策略判定与测试注入（不属于上面两个接口；阀门内部、策略测试用）
    // ────────────────────────────────────────────────────────────────
    /** 同步判定目标是否可出站（域名判不出来时返回 true，交给 assertHost 解析后再判）。 */
    isAllowedTarget,
    /** 目标是否是本机/内网（决定要不要绕过代理）。 */
    isLoopback: (host) => isLoopbackHost(host),
    /** 解析并校验：非公网直接抛错（判定 + 钉地址的入口）。 */
    assertHost: (host) => assertPublicHost(host),
    /** 解析成「已校验的公网地址列表」，供连接时钉死。 */
    resolve: (host) => resolvePublicAddresses(host),
    /** 归一化主机名（IPv6 保留方括号）。 */
    canonicalHost,
    /** 原始代理串（'' = 直连）。排障日志用；工具层一律走 proxyStatus，别读这个。 */
    proxy,
    /** 卸下代理解析器（卸载插件时调；测试用完也要还原，否则会影响后续套件）。 */
    uninstall: () => __setProxyResolver(null),
  });
}

