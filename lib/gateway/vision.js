// 识图：两条路径。
//   1. 显式配了识图模型（vision.provider/model 至少填一个）：下载后调那个模型做描述，
//      把描述文字并入用户消息（老行为，只搬不改）。
//   2. 两项都留空（复用会话模型）：不再额外调识别模型，而是把图片**作为附件直接提交进会话**，
//      由会话模型自己看图；会话模型不支持图片就直接报错，**不回退**成描述注入
//      （同一个模型做描述同样过不去，回退纯属白搭）。
import { promises as fsPromises } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { publicFetch } from '../shared/http.js';
import { collectStreamText } from '../shared/stream-text.js';
import { imageCacheDir } from '../session/workspace.js';

export function createVision(deps) {
  const { TAG, getConfig, ctx, describeError } = deps;
  const visionCfg = () => {
    const raw = getConfig().vision;
    return (raw === undefined || raw === null) ? {} : raw;
  };
  /** 本回合要处理的图片地址：本条消息的 + 被回复消息的（与老路径同一套收集）。 */
  function inboundImageUrls(frame) {
    return [
      ...(Array.isArray(frame.image_urls) ? frame.image_urls : []),
      ...(Array.isArray(frame.replyImageUrls) ? frame.replyImageUrls : []),
    ];
  }
  /** 媒体类型 → 扩展名（附件显示名与导出的原图文件共用同一套）。 */
  function extensionOf(mediaType) {
    return mediaType === 'image/png' ? 'png'
      : mediaType === 'image/webp' ? 'webp'
        : mediaType === 'image/gif' ? 'gif' : 'jpg';
  }
  /** 附件显示名 / 导出文件名：内容 sha1 前 16 位 + 扩展名。同一张图永远同一个名字。 */
  function sha1NameOf(mediaType, data) {
    return createHash('sha1').update(data).digest('hex').slice(0, 16) + '.' + extensionOf(mediaType);
  }
  /**
   * 会话当前模型：优先模型选择投影（/model 切换过、宿主记住的选择都算），
   * 退回 agent 创建时的 options。老路径里的 options 只反映创建时的路由，会漏掉切换。
   */
  function sessionRouteOf(entry) {
    const agent = (entry !== null && entry !== undefined) ? entry.agent : null;
    const projected = (agent !== null && agent !== undefined && agent.model !== null && agent.model !== undefined
      && typeof agent.model.current === 'function') ? agent.model.current() : null;
    if (projected !== null && projected !== undefined
      && typeof projected.provider === 'string' && projected.provider !== ''
      && typeof projected.model === 'string' && projected.model !== '') {
      return { provider: projected.provider, model: projected.model };
    }
    const options = (agent !== null && agent !== undefined && agent.options !== null && agent.options !== undefined)
      ? agent.options : null;
    return {
      provider: (options !== null && typeof options.provider === 'string') ? options.provider : '',
      model: (options !== null && typeof options.model === 'string') ? options.model : '',
    };
  }
  /** 探测一个路由能不能吃图片：'yes'（能吃）/ 'no'（明确不支持）/ 'unknown'（宿主没报能力）。 */
  async function imageCapability(provider, model) {
    if (typeof ctx.llm !== 'object' || ctx.llm === null || typeof ctx.llm.resolveModelInfo !== 'function') return 'unknown';
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model);
      const modalities = (info !== null && info !== undefined && Array.isArray(info.inputModalities)) ? info.inputModalities : null;
      if (modalities === null) return 'unknown';
      return modalities.includes('image') ? 'yes' : 'no';
    } catch (error) {
      console.log(TAG + ' 会话模型的图片能力探测失败（按未知处理，交给请求本身判断）：' + describeError(error));
      return 'unknown';
    }
  }

  /**
   * 共用的一步：把本回合的图片逐张下载 → 附件引用（名字 = 内容 sha1）→ 原图落盘。
   * 两条路径（附件直传 / 先识别再注入）都从这里拿同一份「图片清单」，
   * 文件名、落盘位置、顺序、own/reply 归属完全一致，后续只在「怎么交给模型」上分岔。
   *
   * @param ownCount 前几张属于「本条消息」；其后的属于「被回复的消息」。
   * @returns {Promise<{ entries: any[], ownNames: string[], replyNames: string[], paths: string[] }>}
   *   entries 每项 { index, isOwn, name, path, ref, mediaType }，下载失败的位置 name = ''；
   *   ownNames 与「本条消息的第 N 张图」一一对应（失败留空串，供占位符替换保序）。
   */
  async function collectImages(entry, urls, ownCount, vision, attachments) {
    const max = Math.max(1, Math.min(vision.maxImages ?? 3, urls.length));
    const timeoutMs = vision.downloadTimeoutMs ?? 10000;
    // 缓存图片导出：把原图写入 <QQ_msg>/qq-images/<会话id>/（留档用），
    // 会话结算（本轮回复完成后）会整体删除该缓存目录，见 runTurn 收尾。
    const imgRoot = imageCacheDir(entry ? entry.sessionId : 'default');
    const entries = [];
    const paths = [];
    for (let i = 0; i < urls.length; i += 1) {
      const item = { index: i, isOwn: i < ownCount, name: '', path: '', ref: null, mediaType: '' };
      entries.push(item);
      if (i >= max) continue;
      const url = urls[i];
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      try {
        const downloaded = await downloadImage(url, timeoutMs);
        if (downloaded === null) continue;
        // 文件名 = 内容 sha1 前 16 位（与表情包图库同一套命名），扩展名按真实媒体类型。
        const name = sha1NameOf(downloaded.mediaType, downloaded.data);
        const ref = await attachments.saveImage({
          data: downloaded.data,
          mediaType: downloaded.mediaType,
          name,
        });
        item.name = name;
        item.ref = ref;
        item.mediaType = downloaded.mediaType;
        try {
          const abs = join(imgRoot, name);
          await fsPromises.mkdir(imgRoot, { recursive: true });
          await fsPromises.writeFile(abs, downloaded.data);
          item.path = abs;
          paths.push(abs);
        } catch (saveErr) {
          console.log(TAG + ' 图片导出失败（不影响本轮）：' + describeError(saveErr));
        }
      } catch (error) {
        console.log(TAG + ' 图片下载/附件提交失败（跳过）：' + describeError(error));
      }
    }
    const ownNames = entries.filter((item) => item.isOwn).map((item) => item.name);
    const replyNames = entries.filter((item) => item.isOwn !== true && item.name !== '').map((item) => item.name);
    return { entries, ownNames, replyNames, paths };
  }

  async function describeImages(frame, entry) {
    const vision = visionCfg();
    if (vision.enabled !== true) return { error: '', text: '' };
    const urls = inboundImageUrls(frame);
    if (urls.length === 0) return { error: '', text: '' };
    const attachments = ctx.attachments;
    if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
      return { error: '（图片视觉已开启，但附件服务不可用，请检查 DSH 的 attachments 插件是否启用）', text: '' };
    }
    // 本条消息自己的图片和被回复消息的图片要分开：前者能把正文里的 [图片] 占位符
    // 逐个换成带文件名的 [图片<xxx.gif>]，模型才分得清「这条消息里第几张图」；
    // 后者属于别的消息（可能是别人发的），单列一段。
    const ownUrls = Array.isArray(frame.image_urls) ? frame.image_urls : [];
    const ownCount = ownUrls.length;

    // 两条路径的分岔：
    //   * provider / model 至少填了一个 = 用户显式指定了识图模型 → 先识别成文字再并入。
    //   * 两项都空 = 复用会话模型 → 图片当附件直接进会话，由会话模型自己看。
    const explicitProvider = (typeof vision.provider === 'string' && vision.provider !== '') ? vision.provider : '';
    const explicitModel = (typeof vision.model === 'string' && vision.model !== '') ? vision.model : '';
    let provider = '';
    let model = '';
    if (explicitProvider === '' && explicitModel === '') {
      const route = sessionRouteOf(entry);
      if (route.provider === '' || route.model === '') {
        return { error: '（图片视觉：未能确定会话模型。请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 能力 → 识图与绘图」里填写 provider 与 model）', text: '' };
      }
      const capability = await imageCapability(route.provider, route.model);
      if (capability === 'no') {
        // 不回退成「先描述再注入」：同一个模型做描述同样过不了图片输入，回退是白搭。
        return { error: '（当前会话模型 ' + route.provider + '/' + route.model + ' 不支持图片输入。'
          + '请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 能力 → 识图与绘图」填一个支持图片的识图模型（留空的 provider/model 会跟随会话模型），'
          + '或用 /model 把会话切到支持图片的路由）', imageBlocks: [], paths: [], ownNames: [], replyNames: [], text: '' };
      }
      const collected = await collectImages(entry, urls, ownCount, vision, attachments);
      const imageBlocks = collected.entries.filter((item) => item.ref !== null).map((item) => ({ type: 'image', attachment: item.ref }));
      if (imageBlocks.length === 0) {
        return { error: '（图片视觉：图片下载失败，请稍后重试）', text: '', imageBlocks: [], paths: collected.paths, ownNames: collected.ownNames, replyNames: collected.replyNames };
      }
      return { error: '', text: '', imageBlocks, paths: collected.paths, ownNames: collected.ownNames, replyNames: collected.replyNames };
    }

    // 显式识图模型：只填了一项时，另一项退回会话模型。
    provider = explicitProvider !== '' ? explicitProvider : sessionRouteOf(entry).provider;
    model = explicitModel !== '' ? explicitModel : sessionRouteOf(entry).model;
    if (provider === '' || model === '') {
      return { error: '（图片视觉：未能确定视觉模型。请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 能力 → 识图与绘图」里填写 provider 与 model，例如你的自定义 provider / deepseek-v4-flash-vision-exp）', text: '' };
    }
    // 模型不支持图片时给可读报错（仅当能力明确可知；未知则放行交给请求本身判断）
    const capability = await imageCapability(provider, model);
    if (capability === 'no') {
      return { error: '（当前视觉模型 ' + provider + '/' + model + ' 不支持图片识别。'
        + '请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 能力 → 识图与绘图」切换支持图片的模型，例如 deepseek-v4-flash-vision-exp 或 deepseek-v4.1-flash-request）', text: '' };
    }
    // 同一份图片清单：文件名同样是 sha1，顺序与归属和附件路径完全一致。
    const collected = await collectImages(entry, urls, ownCount, vision, attachments);
    // 描述按图片逐条收集（带文件名与归属），由调用方统一排到消息底部：
    // 正文里只留 [图片<文件名>] 标记，描述集中在 [图片描述] 段，用文件名对号入座。
    const descriptions = [];
    for (const item of collected.entries) {
      if (item.ref === null) continue;
      const text = await askVision(provider, model, item.ref, {
        index: item.index + 1,
        name: item.name,
        isOwn: item.isOwn,
      });
      if (text !== '') descriptions.push({ name: item.name, isOwn: item.isOwn, text });
    }
    if (descriptions.length === 0) {
      // paths 必须一起返回：调用方据此清理已落盘的原图。以前这里丢掉 savedPaths，
      // 于是「识别全失败」这一支写进用户文档目录的图再没人知道，永远删不掉。
      return { error: '（图片视觉：图片下载或识别失败，请稍后重试）', text: '', paths: collected.paths, imageBlocks: [], ownNames: collected.ownNames, replyNames: collected.replyNames };
    }
    return {
      error: '',
      // text 保留一份扁平文本（老调用方/日志用），排版以 descriptions 为准。
      text: descriptions.map((item) => '[' + item.name + '] ' + item.text).join('\n'),
      descriptions,
      paths: collected.paths,
      imageBlocks: [],
      ownNames: collected.ownNames,
      replyNames: collected.replyNames,
    };
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

  /**
   * 用 DSH 的 llm 服务（走已注册的 provider 适配器）对一张图片做识别，返回识别文本。
   *
   * @param meta 可选 { index, name, isOwn }：带上文件名与归属，识别时就把「这是谁发的哪张」
   *   说清楚，返回值里调用方也会用它标注。老调用方（表情包打标等）传一个序号也照旧能跑。
   */
  async function askVision(provider, model, ref, meta) {
    const llm = ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') return '';
    const index = (meta !== null && meta !== undefined && typeof meta.index === 'number') ? meta.index
      : (typeof meta === 'number' ? meta : 1);
    const name = (meta !== null && meta !== undefined && typeof meta.name === 'string') ? meta.name : '';
    const isOwn = (meta !== null && meta !== undefined && meta.isOwn !== undefined) ? meta.isOwn === true : true;
    const where = (meta !== null && meta !== undefined && typeof meta.where === 'string' && meta.where !== '') ? meta.where
      : (isOwn ? '本条消息里' : '被回复消息里');
    const who = where;
    const label = name !== '' ? '（文件 ' + name + '）' : '';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '这是' + who + '的第 ' + index + ' 张图片' + label + '。请用简体中文描述这张图片的内容，要具体、可读，不要猜测没有出现的信息。' },
        { type: 'image', attachment: ref },
      ],
    }];
    // 取文本的三级兜底（delta → block-end → reasoning，互斥）收在 shared/stream-text.js：
    // 推理型模型会把内容写进 reasoning-delta，预算小了就会被思考吃光、正文一个字不剩。
    let collected = null;
    try {
      collected = await collectStreamText(llm.stream({ provider, model, messages, maxTokens: 2000 }));
    } catch (error) {
      console.log(TAG + ' 视觉请求失败（' + provider + '/' + model + ' 第' + index + '张）：' + describeError(error));
      return '';
    }
    if (collected.source === 'reasoning') {
      console.log(TAG + ' 视觉请求只有思考没有正文，从 reasoning 兜底取内容（' + provider + '/' + model + ' 第' + index + '张）');
    }
    if (collected.text === '') {
      console.log(TAG + ' 视觉请求空返回（' + provider + '/' + model + ' 第' + index + '张图，流式结束无文本）');
    }
    return collected.text;
  }


  return { describeImages, downloadImage, askVision };
}
