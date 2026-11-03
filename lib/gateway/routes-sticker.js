/**
 * 表情包图库的 HTTP 路由（挂在 DSH webServer 上，和设置页同源）。
 *
 * 两条：
 *   GET  /dsh-qq-bot/sticker          读状态：目录、张数、系列、已打标/待打标、后台任务进度
 *   POST /dsh-qq-bot/sticker/rebuild  重建索引：body {"mode":"tag"|"index"}
 *                                     tag = 扫描 + 自动打标（默认），index = 只扫哈希不打标
 *
 * 为什么重建要单开一条写路由：设置页只是「改配置」，而重建会**真的读目录、调视觉模型**
 * （花 token）。所以做成两次动作：卡片上的按钮 POST 一次，任务转后台，客户端轮询 GET 看进度。
 * 路由不接触任何密钥，响应里也没有配置值。
 */

export const STICKER_STATE_PATH = '/dsh-qq-bot/sticker';
export const STICKER_REBUILD_PATH = '/dsh-qq-bot/sticker/rebuild';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 读 POST body（上限 8KB，别让人往这里灌大包）。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed;
}

export function registerStickerRoutes(deps) {
  const webServer = deps === undefined || deps === null ? undefined : deps.webServer;
  const sticker = deps === undefined || deps === null ? undefined : deps.sticker;
  const log = (deps !== undefined && deps !== null && typeof deps.log === 'function') ? deps.log : () => {};
  const guard = (deps !== undefined && deps !== null && typeof deps.guard === 'function') ? deps.guard : () => true;
  // 工作区根由接线层注入（routes-glue.js 从 plugin.js 带下来）：
  // 网关路由不直接 import session/ —— 与 routes-bind/defaults/settings 一样只吃 deps。
  const qqMsgRoot = (deps !== undefined && deps !== null && typeof deps.qqMsgRootSync === 'function')
    ? deps.qqMsgRootSync : () => '';
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    return { ok: false, error: 'webServer 服务不可用（表情包卡片会退化成只看配置）', unregister: () => {} };
  }

  const handleState = async (req, res) => {
    if (guard(req, res) !== true) return;
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      const status = await sticker.status();
      json(res, 200, Object.assign({ ok: true, root: qqMsgRoot() }, status));
    } catch (error) {
      json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  };

  const handleRebuild = async (req, res) => {
    if (guard(req, res) !== true) return;
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    try {
      const body = await readJsonBody(req);
      const mode = String(body.mode === undefined || body.mode === null ? 'tag' : body.mode).trim();
      if (mode !== 'tag' && mode !== 'index') {
        json(res, 400, { ok: false, error: 'mode 只能是 tag 或 index' });
        return;
      }
      // 后台任务：立刻返回，进度用下面的 GET 轮询（打标可能要几分钟）。
      const started = sticker.startRebuild({ tag: mode === 'tag' });
      log('表情包重建已启动（mode=' + mode + '，started=' + String(started.started) + '）');
      const status = await sticker.status();
      json(res, 200, Object.assign({ ok: true }, started, status));
    } catch (error) {
      json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  };

  const unregisters = [];
  try {
    unregisters.push(webServer.register({ kind: 'exact', path: STICKER_STATE_PATH, handler: handleState }));
    unregisters.push(webServer.register({ kind: 'exact', path: STICKER_REBUILD_PATH, handler: handleRebuild }));
  } catch (error) {
    log('注册表情包路由失败：' + String(error && error.message ? error.message : error));
    for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } }
    return { ok: false, error: '注册路由失败：' + String(error && error.message ? error.message : error), unregister: () => {} };
  }
  return {
    ok: true,
    unregister: () => { for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } } },
  };
}
