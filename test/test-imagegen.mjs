/**
 * 生图引擎自测（不联网）：URL 拼接 / 响应解析 / 失败重试 / 任务轮询。
 * 用法：node test/test-imagegen.mjs
 */
import { generationsUrl, trimBaseUrl, parseImagePayload, generateImage, referenceToDataUrl } from '../lib/tools/imagegen.js';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qqMsgRootSync, imageCacheDir } from '../lib/session/workspace.js';
import { meIsAllowedImageFile } from '../lib/tools/imgsearch.js';
import { resolveSendImagePath } from '../lib/tools/index.js';
import { createVision } from '../lib/gateway/vision.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail === undefined ? '' : '：' + detail)); }
}

// 1) URL 拼接
check('trimBaseUrl 去掉尾斜杠', trimBaseUrl('https://api.x.top/v1///') === 'https://api.x.top/v1');
check('generationsUrl 拼接端点', generationsUrl('https://api.x.top/v1/') === 'https://api.x.top/v1/images/generations');
check('空地址返回空串', generationsUrl('') === '');

// 2) 响应解析
const pUrl = parseImagePayload({ data: [{ url: 'https://cdn/x.png' }] });
check('解析 data[0].url', pUrl.kind === 'image' && pUrl.url === 'https://cdn/x.png');
const pB64 = parseImagePayload({ data: [{ b64_json: 'AAAA' }] });
check('解析 data[0].b64_json', pB64.kind === 'image' && pB64.b64 === 'AAAA');
const pErr = parseImagePayload({ error: { message: 'quota exceeded' } });
check('解析 error 对象', pErr.kind === 'error' && pErr.error.indexOf('quota') >= 0);
const pTask = parseImagePayload({ task_id: 'abc', status: 'pending' });
check('解析 task_id', pTask.kind === 'task' && pTask.taskId === 'abc' && pTask.status === 'pending');
const pFailed = parseImagePayload({ task_id: 'abc', status: 'failed' });
check('任务失败识别', pFailed.kind === 'task' && pFailed.status === 'failed');
const pEmpty = parseImagePayload({ data: [] });
check('空响应报错', pEmpty.kind === 'error');

function fakeFetch(plan) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    const step = plan.shift();
    if (step === undefined) throw new Error('没有更多预设响应');
    if (step.throwIt === true) throw new Error('network boom');
    return { ok: step.status < 400, status: step.status, text: async () => JSON.stringify(step.body) };
  };
  impl.calls = calls;
  return impl;
}

// 3) 失败重试后成功
const f1 = fakeFetch([
  { status: 500, body: { error: 'boom' } },
  { status: 429, body: { error: 'slow down' } },
  { status: 200, body: { data: [{ url: 'https://cdn/ok.png' }] } },
]);
const r1 = await generateImage({ baseUrl: 'https://api.x.top/v1', apiKey: 'k', model: 'm', prompt: 'p', maxAttempts: 3, retryIntervalMs: 0, fetchImpl: f1 });
check('500/429 重试后成功', r1.ok === true && r1.url === 'https://cdn/ok.png' && r1.attempts === 3, JSON.stringify(r1));
check('重试次数正确（3 次请求）', f1.calls.length === 3, String(f1.calls.length));

// 4) 400 不重试
const f2 = fakeFetch([{ status: 400, body: { error: 'bad prompt' } }]);
const r2 = await generateImage({ baseUrl: 'https://api.x.top/v1', prompt: 'p', maxAttempts: 4, retryIntervalMs: 0, fetchImpl: f2 });
check('4xx 直接失败不重试', r2.ok === false && f2.calls.length === 1, JSON.stringify(r2));

// 5) 网络异常重试
const f3 = fakeFetch([{ throwIt: true }, { status: 200, body: { data: [{ b64_json: 'ZZZ' }] } }]);
const r3 = await generateImage({ baseUrl: 'https://api.x.top/v1', prompt: 'p', maxAttempts: 2, retryIntervalMs: 0, fetchImpl: f3 });
check('网络异常后重试成功', r3.ok === true && r3.b64 === 'ZZZ', JSON.stringify(r3));

// 6) task_id 轮询
// 第 1 轮：三个候选地址都还在跑；第 2 轮：第一个候选就出图
const f4 = fakeFetch([
  { status: 200, body: { task_id: 't1', status: 'pending' } },
  { status: 200, body: { status: 'running' } },
  { status: 200, body: { status: 'running' } },
  { status: 200, body: { status: 'running' } },
  { status: 200, body: { data: [{ url: 'https://cdn/done.png' }] } },
]);
const r4 = await generateImage({ baseUrl: 'https://api.x.top/v1', prompt: 'p', maxAttempts: 1, retryIntervalMs: 0, poll: true, pollIntervalMs: 0, maxPolls: 3, fetchImpl: f4 });
check('task_id 轮询到出图', r4.ok === true && r4.url === 'https://cdn/done.png' && r4.polls === 2, JSON.stringify(r4));
check('轮询请求打到 generations/<id>', f4.calls.some((c) => c.url.indexOf('/images/generations/t1') >= 0));

// 7) 关闭轮询时直接报错
const f5 = fakeFetch([{ status: 200, body: { task_id: 't2', status: 'pending' } }]);
const r5 = await generateImage({ baseUrl: 'https://api.x.top/v1', prompt: 'p', maxAttempts: 1, retryIntervalMs: 0, poll: false, fetchImpl: f5 });
check('关闭轮询时提示 task id', r5.ok === false && String(r5.error).indexOf('t2') >= 0, JSON.stringify(r5));

console.log('\n7. 本地图片白名单必须解符号链接（2026-10-28 审计）');
{
  // 纯字符串前缀判断挡不住软链：qq-images/<会话>/steal.png -> /etc/passwd 的**路径字符串**
  // 完全在白名单目录下，readFile 却会读到目标，再被上传到图床。
  const sessionId = 'imgsearch-symlink-test';
  const ownDir = imageCacheDir(sessionId);
  const outside = join(qqMsgRootSync(), 'outside-secret.txt');
  const link = join(ownDir, 'steal.png');
  // finally 里要清理的文件路径（try 块里赋值）
  let sendRoot = '';
  let sendOk = '';
  let cleaned = false;
  try {
    mkdirSync(ownDir, { recursive: true });
    writeFileSync(outside, 'SECRET', 'utf8');
    const realFile = join(ownDir, 'ok.png');
    writeFileSync(realFile, 'IMG', 'utf8');
    // 只断言「返回非空字符串」是不够的：那只能区分 boolean 与 string，区分不了「返回的是不是 real 路径」。
    // 这条要断言**返回值就是那个文件的 realpath**（调用方读盘必须用它，判定与读取才是同一个串）。
    const allowedReal = meIsAllowedImageFile(realFile, sessionId);
    check('会话目录下的普通图片 → 放行，且返回该文件的 real 路径',
      allowedReal === realpathSync(realFile), allowedReal);

    try { rmSync(link, { force: true }); } catch { /* 不存在 */ }
    symlinkSync(outside, link);
    check('指向白名单外的软链 → 拒绝（返回空串）', meIsAllowedImageFile(link, sessionId) === '', link);

    // qqbot send 走的是另一条判定（lib/tools/index.js 的 resolveSendImagePath）：
    // 2026-10-29 注释审查发现它当时只做字符串前缀比较，同一个洞还开着。
    // 提到外层：finally 里要清它，块级 const 在 finally 里取不到（会静默 ReferenceError 被 catch 吞掉）。
    sendRoot = join(qqMsgRootSync(), 'qq-images');
    sendOk = join(sendRoot, 'ok-send.png');
    writeFileSync(sendOk, 'IMG', 'utf8');
    check('qqbot send：白名单内的普通图片 → 放行',
      resolveSendImagePath(sendOk, sendRoot) === realpathSync(sendOk));

    // 调用点也必须用返回值去读盘 —— 这层**没有行为测试网**（要搭完整工具上下文，成本远大于收益）。
    // 所以退回**源码契约**：断言 `index.js` 里那两处不再把原始 filePath 传给读盘/上传。
    // 它抓不住「逻辑改错」，但抓得住「有人把 allowed2 改回 filePath」这个具体回归 ——
    // 而后者正是终审实测「全套 49/49 全绿」的那三处零覆盖之一。
    const indexSrc = readFileSync(new URL('../lib/tools/index.js', import.meta.url), 'utf8');
    check('imgsearch 调用点用白名单返回的路径去上传（不是原始入参）',
      indexSrc.indexOf('uploadToHost(allowed2)') >= 0 && indexSrc.indexOf('uploadToHost(filePath)') < 0,
      indexSrc.indexOf('uploadToHost(filePath)') >= 0 ? '仍在传原始 filePath' : '');
    check('imgsearch 调用点用白名单返回的路径去直传（不是原始入参）',
      indexSrc.indexOf('imgSearchSoutubotFile(allowed1') >= 0 && indexSrc.indexOf('imgSearchSoutubotFile(filePath') < 0,
      indexSrc.indexOf('imgSearchSoutubotFile(filePath') >= 0 ? '仍在传原始 filePath' : '');
    check('qqbot send：指向白名单外的软链 → 拒绝',
      resolveSendImagePath(link, sendRoot) === '', link);
    check('qqbot send：不存在的文件 → 拒绝', resolveSendImagePath(join(sendRoot, 'nope.png'), sendRoot) === '');

    const escape = join(ownDir, 'escape.png');
    try { rmSync(escape, { force: true }); } catch { /* 不存在 */ }
    symlinkSync('/etc/passwd', escape);
    check('指向系统文件的软链 → 拒绝（返回空串）', meIsAllowedImageFile(escape, sessionId) === '', escape);

    check('不存在的路径 → 拒绝（realpath 失败不认，返回空串）', meIsAllowedImageFile(join(ownDir, 'nope.png'), sessionId) === '');
    check('别的会话目录 → 拒绝（返回空串）', meIsAllowedImageFile(realFile, 'another-session') === '');

    // 第三条路径：qq_draw 的 reference 也走本地图片白名单（lib/tools/imagegen.js）。
    // 它以前只做 pathResolve + 前缀比，同一个软链洞还开着，读到的内容会被 base64
    // 塞进外部生图请求体（外带通道）。现在必须 realpath 解完再比一次。
    let refOutside = '';
    {
      const refRoot = join(qqMsgRootSync(), 'qq-images');
      const refLink = join(ownDir, 'ref-steal.png');
      try { rmSync(refLink, { force: true }); } catch { /* ignore */ }
      try {
        symlinkSync(outside, refLink);
        const dataUrl = await referenceToDataUrl(refLink, refRoot);
        refOutside = String(dataUrl).includes('SECRET') ? 'leaked' : 'no-secret';
        check('qq_draw reference：指向白名单外的软链 → 拒绝（不读内容、不外带）', refOutside !== 'leaked', refOutside);
      } catch (error) {
        check('qq_draw reference：指向白名单外的软链 → 拒绝（抛错即拒绝）', true, error.message.slice(0, 60));
      } finally { try { rmSync(refLink, { force: true }); } catch { /* ignore */ } }
    }
  } finally {
    try { rmSync(join(ownDir, 'steal.png'), { force: true }); } catch { /* ignore */ }
    try { rmSync(join(ownDir, 'escape.png'), { force: true }); } catch { /* ignore */ }
    try { rmSync(join(ownDir, 'ok.png'), { force: true }); } catch { /* ignore */ }
    // ok-send.png 直接写在 qq-images 根下（不在 ownDir 内），下面那个 rmSync(ownDir, recursive) 清不到它。
    try { rmSync(sendOk, { force: true }); } catch { /* ignore */ }
    try { rmSync(outside, { force: true }); } catch { /* ignore */ }
    try { rmSync(ownDir, { recursive: true, force: true }); cleaned = true; } catch { /* ignore */ }
  }
  check('测试临时文件已清理', cleaned === true);
}


// ─────── askVision 的能力检查（以前不检查：模型不支持时仍会白跑一次请求）───────
// 现象：qq_history 拉历史图片走 askVision，它直接把 image 块塞给 llm.stream。
// 遇到纯文本模型时上游把图降级成占位、模型回空串，调用方只能显示「图片识别无返回」，
// 看不出真正原因（2026-11-16 那次排查就为此绕了一大圈）。
// 现在能力明确为 'no' 时短路、不发请求；'unknown' 照常放行。
{
  let streamCalls = 0;
  const ctxNo = {
    llm: {
      resolveModelInfo: async () => ({ provider: 'p', model: 'm', inputModalities: ['text'] }),
      stream: async function* () { streamCalls += 1; yield { type: 'text-delta', text: 'x' }; },
    },
  };
  const vNo = createVision({ TAG: '[test]', getConfig: () => ({ vision: {} }), ctx: ctxNo, describeError: (e) => String(e) });
  const tNo = await vNo.askVision('p', 'm', 'ref-1', { index: 1, isOwn: false, where: '聊天记录里' });
  check('模型明确不支持图片 → askVision 不发请求（避免白跑一次）', tNo === '' && streamCalls === 0,
    'streamCalls=' + streamCalls);

  let streamCalls2 = 0;
  const ctxUnknown = {
    llm: {
      resolveModelInfo: async () => { throw new Error('宿主没报能力'); },
      stream: async function* () { streamCalls2 += 1; yield { type: 'text-delta', text: '看得到' }; },
    },
  };
  const vUnknown = createVision({ TAG: '[test]', getConfig: () => ({ vision: {} }), ctx: ctxUnknown, describeError: (e) => String(e) });
  await vUnknown.askVision('p', 'm', 'ref-2', { index: 1, isOwn: false, where: '聊天记录里' });
  check('能力未知 → askVision 照常请求（不误伤）', streamCalls2 === 1, 'streamCalls=' + streamCalls2);
}
console.log('\n' + pass + '/' + (pass + fail) + ' 项通过');
if (fail > 0) { console.log('生图自测失败'); process.exit(1); }
console.log('生图自测通过');
