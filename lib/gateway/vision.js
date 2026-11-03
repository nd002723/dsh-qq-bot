// 识图：下载消息里的图片、调视觉模型描述、拼进上下文。
// 从 gateway/plugin.js 搬出（P3 2.4 第三阶段，只搬不改）。
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { publicFetch } from '../shared/http.js';
import { imageCacheDir } from '../session/workspace.js';

export function createVision(deps) {
  const { TAG, getConfig, ctx, describeError } = deps;
  async function describeImages(frame, entry) {
    const vision = getConfig().vision || {};
    if (vision.enabled !== true) return { error: '', text: '' };
    const urls = [
      ...(Array.isArray(frame.image_urls) ? frame.image_urls : []),
      ...(Array.isArray(frame.replyImageUrls) ? frame.replyImageUrls : []),
    ];
    if (urls.length === 0) return { error: '', text: '' };
    const attachments = ctx.attachments;
    if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
      return { error: '（图片视觉已开启，但附件服务不可用，请检查 DSH 的 attachments 插件是否启用）', text: '' };
    }
    // 解析视觉模型：显式配置优先（用户从 DSH 自定义 providers 里选），否则用会话当前模型
    const provider = (typeof vision.provider === 'string' && vision.provider !== '') ? vision.provider
      : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.provider === 'string'
        ? entry.agent.options.provider : '');
    const model = (typeof vision.model === 'string' && vision.model !== '') ? vision.model
      : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.model === 'string'
        ? entry.agent.options.model : '');
    if (provider === '' || model === '') {
      return { error: '（图片视觉：未能确定视觉模型。请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 能力 → 识图与绘图」里填写 provider 与 model，例如你的自定义 provider / deepseek-v4-flash-vision-exp）', text: '' };
    }
    // 模型不支持图片时给可读报错（仅当能力明确可知；未知则放行交给请求本身判断）
    if (typeof ctx.llm === 'object' && ctx.llm !== null && typeof ctx.llm.resolveModelInfo === 'function') {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        const modalities = (info && Array.isArray(info.inputModalities)) ? info.inputModalities : null;
        if (modalities !== null && !modalities.includes('image')) {
          return { error: '（当前视觉模型 ' + provider + '/' + model + ' 不支持图片识别。'
            + '请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 能力 → 识图与绘图」切换支持图片的模型，例如 deepseek-v4-flash-vision-exp 或 deepseek-v4.1-flash-request）', text: '' };
        }
      } catch (error) {
        console.log(TAG + ' 视觉能力探测失败（放行，交给请求本身）：' + describeError(error));
      }
    }
    const max = Math.max(1, Math.min(vision.maxImages ?? 3, urls.length));
    const timeoutMs = vision.downloadTimeoutMs ?? 10000;
    const descriptions = [];
    const savedPaths = [];
    // 缓存图片导出：把原图写入 <QQ_msg>/qq-images/<会话id>/（留档用，识图由视觉模型完成）；
    // 会话结算（本轮回复完成后）会整体删除该缓存目录，见 runTurn 收尾。
    const imgRoot = imageCacheDir(entry ? entry.sessionId : 'default');
    for (let i = 0; i < max; i += 1) {
      const url = urls[i];
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      try {
        const downloaded = await downloadImage(url, timeoutMs);
        if (downloaded === null) continue;
        const ref = await attachments.saveImage({ data: downloaded.data, mediaType: downloaded.mediaType });
        const text = await askVision(provider, model, ref, i + 1);
        if (text !== '') descriptions.push(text);
        // 导出原图到工作目录（会话 id 区分），随消息附上路径
        try {
          const ext = downloaded.mediaType === 'image/png' ? 'png'
            : downloaded.mediaType === 'image/webp' ? 'webp'
              : downloaded.mediaType === 'image/gif' ? 'gif' : 'jpg';
          const abs = join(imgRoot, 'qq-' + Date.now() + '-' + i + '.' + ext);
          await fsPromises.mkdir(imgRoot, { recursive: true });
          await fsPromises.writeFile(abs, downloaded.data);
          savedPaths.push(abs);
        } catch (saveErr) {
          console.log(TAG + ' 图片导出失败（不影响识别）：' + describeError(saveErr));
        }
      } catch (error) {
        console.log(TAG + ' 图片识别失败（跳过）：' + describeError(error));
      }
    }
    if (descriptions.length === 0) {
      // paths 必须一起返回：调用方据此清理已落盘的原图。以前这里丢掉 savedPaths，
      // 于是「识别全失败」这一支写进用户文档目录的图再没人知道，永远删不掉。
      return { error: '（图片视觉：图片下载或识别失败，请稍后重试）', text: '', paths: savedPaths };
    }
    return { error: '', text: descriptions.join('\n'), paths: savedPaths };
  }

  /** 下载一张 http(s) 图片，返回 { data: Uint8Array, mediaType } 或 null。 */
  async function downloadImage(url, timeoutMs) {
    // 走 publicFetch：公网校验 + 地址钉死 + 逐跳校验 + 8MB 上限。
    // 图片 URL 来自消息里的 CQ 码（[CQ:image,url=...]）或协议端帧，属外部输入，
    // 以前这里直接 fetch 且 arrayBuffer 整包读入——一条消息就能打内网或撑爆内存。
    try {
      const res = await publicFetch(url, { binary: true, timeoutMs, maxBytes: 8 * 1024 * 1024 });
      if (res.status < 200 || res.status >= 300) return null;
      const ct = String(res.contentType === undefined || res.contentType === null ? '' : res.contentType).split(';')[0].trim().toLowerCase();
      let mediaType = null;
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ct)) mediaType = ct;
      else if (ct === '') {
        mediaType = /\.png$/i.test(url) ? 'image/png'
          : /\.webp$/i.test(url) ? 'image/webp'
            : /\.gif$/i.test(url) ? 'image/gif' : 'image/jpeg';
      } else {
        return null;
      }
      const bytes = new Uint8Array(/** @type {any} */ (res.body));
      if (bytes.length === 0) return null;
      return { data: bytes, mediaType };
    } catch {
      return null;
    }
  }

  /** 用 DSH 的 llm 服务（走已注册的 provider 适配器）对一张图片做识别，返回识别文本。 */
  async function askVision(provider, model, ref, index) {
    const llm = ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') return '';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '这是用户发来的第 ' + index + ' 张图片。请用简体中文描述这张图片的内容，要具体、可读，不要猜测没有出现的信息。' },
        { type: 'image', attachment: ref },
      ],
    }];
    let out = '';
    try {
      for await (const chunk of llm.stream({ provider, model, messages, maxTokens: 512 })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      }
    } catch (error) {
      console.log(TAG + ' 视觉请求失败（' + provider + '/' + model + ' 第' + index + '张）：' + describeError(error));
      return '';
    }
    if (out.trim() === '') {
      console.log(TAG + ' 视觉请求空返回（' + provider + '/' + model + ' 第' + index + '张图，流式结束无文本）');
    }
    return out.trim();
  }


  return { describeImages, downloadImage, askVision };
}
