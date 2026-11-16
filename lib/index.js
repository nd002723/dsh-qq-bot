/**
 * dsh-qq-bot —— 包入口（薄壳）。
 *
 * 这里**只做转发**，不放任何逻辑：DSH / Cordis 按 package.json 的 main 加载本文件，
 * 真正的插件主体在 gateway/plugin.js（网关装配），各层职责见 docs/ARCHITECTURE.md：
 *
 *   transport/  协议适配（OneBot 11/12、Satori、Milky、官方 Bot）
 *   gateway/    网关路由与分发（入站 → 会话 → 出站、路由挂载、/auth 与 /flow 指令）
 *   message/    消息组装（分条、流式、中间发言、段构造、去重）
 *   valve/      阀门（network 网络 / security 安全 / tool 工具）
 *   tools/      工具实现（qqbot、qqgroup、qq_history、qq_draw、qq_imgsearch、qq_websearch、qq_webfetch、qqconfig、qqauth）
 *   session/    会话、模型路由、工作区、主动发言
 *   api/        群管理与官方 Bot 绑定
 *   shared/     公共基础设施（HTTP 传输、兼容自检）
 *   config.js   配置 schema
 *   assemble.js 组装根（按优先级把阀门与网关装成一台可运行的插件）
 *
 * 保持薄壳的原因：包入口路径（lib/index.js）是对外契约，测试与已装 profile 都按它加载；
 * 重构内部目录时它不该跟着变。
 */
export { Config, name, inject, apply, cleanupStaleConfig, pluginDiagnostics } from './gateway/plugin.js';
