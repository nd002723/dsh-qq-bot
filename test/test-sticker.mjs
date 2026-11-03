/**
 * 单元测试：lib/tools/sticker.js —— 表情包图库（索引 / 哈希增量 / AI 自动打标 / 挑图）
 *
 * 用临时目录 + 假 ctx（attachments.saveImage / llm.stream）跑完整流程，
 * 不碰网络、不碰真实模型，断言的是「哪些文件被重新打标」这种可观察行为。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INDEX_FILE,
  createStickerLibrary,
  hasStickerTags,
  isImageExt,
  listImageFiles,
  loadIndexAt,
  parseTagReply,
  resolveStickerTarget,
  seriesOfRel,
  seriesSummary,
  gifFirstFrameToPng,
  sniffImage,
  visionPayload,
} from '../lib/tools/sticker.js';

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 假图片：内容随便，只要字节不同就能测哈希差异。 */
function writeImage(dir, rel, body) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(String(body))]));
  return abs;
}

function makeLibrary(root, options = {}) {
  const calls = [];
  const sticker = Object.assign({
    enabled: true,
    dir: root,
    autoTag: true,
    provider: 'test-provider',
    model: 'test-model',
    maxPerRun: 40,
    timeoutMs: 8000,
  }, options.sticker || {});
  const config = { sticker, vision: options.vision || { provider: '', model: '' } };
  const ctx = {
    attachments: {
      async saveImage({ data, mediaType }) { return { kind: 'image', mediaType, bytes: data.length }; },
    },
    llm: {
      stream(request) {
        calls.push(request);
        const index = calls.length;
        const text = (options.reply || ((n) => '【标签】测试' + n + ',猫,无语\n【描述】第 ' + n + ' 张测试图'))(index);
        return (async function* emit() { yield { type: 'text-delta', text }; })();
      },
    },
  };
  const library = createStickerLibrary({
    getConfig: () => config,
    getRoot: () => root,
    ctx,
    describeError: (error) => (error && error.message ? error.message : String(error)),
    log: () => {},
  });
  return { library, calls, config, ctx };
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-sticker-'));
let exitCode = 0;

try {
  console.log('1. 纯函数');
  check('图片扩展名识别', isImageExt('a.JPG') && isImageExt('b.webp') && !isImageExt('c.txt') && !isImageExt('index.json'));
  check('系列名 = 最外层目录', seriesOfRel('猫猫/无语.jpg') === '猫猫' && seriesOfRel('a/b/c.png') === 'a' && seriesOfRel('root.jpg') === '');
  check('系列汇总按名字排序', (() => {
    const summary = seriesSummary([{ file: 'b/1.jpg' }, { file: 'a/2.png' }, { file: '3.gif' }, { file: 'a/4.webp' }]);
    return summary.length === 3 && summary[0].name === '' && summary[1].name === 'a' && summary[1].count === 2 && summary[2].name === 'b';
  })());

  console.log('\n2. parseTagReply 解析两行输出');
  const p1 = parseTagReply('【标签】猫，无语、翻白眼\n【描述】一只橘猫翻白眼，表示无语，适合群里被问烦了时用');
  check('标准两行解析出标签与描述', p1.tags.length === 3 && p1.tags[0] === '猫' && p1.tags[2] === '翻白眼' && p1.desc.includes('橘猫'), JSON.stringify(p1));
  const p2 = parseTagReply('标签: 1. 开心 2. 鼓掌\n描述: 鼓掌表示赞同');
  check('容忍 ASCII 冒号与序号', p2.tags.join(',') === '开心,鼓掌' && p2.desc === '鼓掌表示赞同', JSON.stringify(p2));
  const p3 = parseTagReply('猫,无语,翻白眼\n一张猫的图');
  check('无【标签】行时从第一行拆词兜底', p3.tags.length === 3 && p3.desc === '一张猫的图', JSON.stringify(p3));
  const p4 = parseTagReply('【标签】人物,画面,表情\n【描述】一张图');
  check('过泛的词被丢掉', p4.tags.length === 0 && p4.desc === '一张图', JSON.stringify(p4));

  console.log('\n3. listImageFiles 只认图、跳过索引与隐藏项');
  const scanDir = join(tmpRoot, 'scan');
  writeImage(scanDir, '猫猫/a.jpg', 'a');
  writeImage(scanDir, '猫猫/深层/b.png', 'b');
  writeImage(scanDir, 'c.webp', 'c');
  writeFileSync(join(scanDir, 'note.txt'), 'x');
  writeFileSync(join(scanDir, INDEX_FILE), '{}');
  mkdirSync(join(scanDir, '.hidden'), { recursive: true });
  writeFileSync(join(scanDir, '.hidden', 'h.jpg'), 'h');
  const files = listImageFiles(scanDir);
  check('只列出图片（含子目录，跳过 index.json / 非图 / 隐藏目录）',
    files.join(',') === 'c.webp,猫猫/a.jpg,猫猫/深层/b.png', JSON.stringify(files));

  console.log('\n4. 首次扫描：建索引 + 自动打标');
  const libDir = join(tmpRoot, 'lib');
  writeImage(libDir, '猫猫/无语.jpg', 'cat-1');
  writeImage(libDir, '猫猫/鼓掌.jpg', 'cat-2');
  writeImage(libDir, '日常/疑问.png', 'daily-1');
  const { library, calls } = makeLibrary(libDir);
  const first = await library.sync({ tag: true });
  check('索引写在目录根部的 index.json', existsSync(join(libDir, INDEX_FILE)));
  check('三张图都进了索引', first.files === 3 && first.added === 3, JSON.stringify(first));
  check('三张都打了标（模型被调用三次）', first.tagged === 3 && calls.length === 3, 'calls=' + calls.length);
  check('索引里带 sha1 / 标签 / 描述', (() => {
    const loaded = loadIndexAt(libDir);
    const item = loaded.index.items.find((entry) => entry.file === '猫猫/无语.jpg');
    return loaded.index.items.length === 3 && item !== undefined && /^[0-9a-f]{40}$/.test(item.sha1)
      && item.tags.length >= 2 && item.desc !== '' && item.series === '猫猫';
  })());
  check('索引带系列汇总', (() => {
    const loaded = loadIndexAt(libDir);
    return loaded.index.series.length === 2 && loaded.index.series.some((s2) => s2.name === '猫猫' && s2.count === 2);
  })());
  check('剩余待打标为 0', first.pending === 0, String(first.pending));

  console.log('\n5. 第二次扫描：内容没变 → 一个 token 都不花');
  const before = calls.length;
  const second = await library.sync({ tag: true });
  check('没有新增/变动', second.added === 0 && second.updated === 0 && second.unchanged === 3, JSON.stringify(second));
  check('没有再调模型', calls.length === before, String(calls.length - before));
  check('原有标签保留', (() => {
    const item = loadIndexAt(libDir).index.items.find((entry) => entry.file === '猫猫/无语.jpg');
    return item.tags.length >= 2 && item.desc !== '';
  })());

  console.log('\n6. touch 只改 mtime（内容没变）→ 哈希相同，不重打标');
  const touchAbs = join(libDir, '猫猫', '鼓掌.jpg');
  const future = new Date(Date.now() + 5000);
  utimesSync(touchAbs, future, future);
  const third = await library.sync({ tag: true });
  check('mtime 变了但哈希相同 → 计入「未变」', third.unchanged === 3 && third.updated === 0, JSON.stringify(third));
  check('仍未调模型', calls.length === before, String(calls.length - before));

  console.log('\n7. 真正改动一张图 → 只重打这一张');
  writeImage(libDir, '猫猫/无语.jpg', 'cat-1-changed');
  const fourth = await library.sync({ tag: true });
  check('只算一张「变动」', fourth.updated === 1 && fourth.added === 0, JSON.stringify(fourth));
  check('只重打这一张（模型多调一次）', calls.length === before + 1, String(calls.length - before));
  check('这张的标签已刷新', (() => {
    const item = loadIndexAt(libDir).index.items.find((entry) => entry.file === '猫猫/无语.jpg');
    return item.tags.includes('测试' + (before + 1)) || item.tags.some((tag) => tag.includes(String(before + 1)));
  })(), JSON.stringify(loadIndexAt(libDir).index.items.map((i) => [i.file, i.tags])));

  console.log('\n8. 新增系列 / 删除文件');
  writeImage(libDir, '新系列/开心.gif', 'new-1');
  const fifth = await library.sync({ tag: true });
  check('新增文件被收录并打标', fifth.added === 1 && fifth.tagged >= 1 && fifth.series.some((s2) => s2.name === '新系列'), JSON.stringify(fifth));
  rmSync(join(libDir, '日常', '疑问.png'));
  const sixth = await library.sync({ tag: false });
  check('删掉的文件从索引里移除', sixth.removed === 1 && !loadIndexAt(libDir).index.items.some((item) => item.file === '日常/疑问.png'), JSON.stringify(sixth));

  console.log('\n8.1 改名 / 换系列 / 复制：按 sha1 认领旧标签，不重打标');
  const beforeMove = calls.length;
  const itemOf = (rel) => loadIndexAt(libDir).index.items.find((entry) => entry.file === rel);
  const originalTags = itemOf('猫猫/鼓掌.jpg').tags.slice();
  // 同目录改名
  renameSync(join(libDir, '猫猫', '鼓掌.jpg'), join(libDir, '猫猫', '鼓掌-改名.jpg'));
  const moved = await library.sync({ tag: true });
  check('同目录改名记成「认领」，不算新增', moved.moved === 1 && moved.added === 0, JSON.stringify(moved));
  check('改名后没有调模型', calls.length === beforeMove, String(calls.length - beforeMove));
  check('改名后标签原样保留',
    JSON.stringify(itemOf('猫猫/鼓掌-改名.jpg').tags) === JSON.stringify(originalTags),
    JSON.stringify(itemOf('猫猫/鼓掌-改名.jpg').tags));
  // 换系列：挪进另一个子目录
  mkdirSync(join(libDir, '换过来的'), { recursive: true });
  renameSync(join(libDir, '猫猫', '鼓掌-改名.jpg'), join(libDir, '换过来的', '鼓掌-改名.jpg'));
  const moved2 = await library.sync({ tag: true });
  check('换系列记成「认领」且不调模型', moved2.moved === 1 && calls.length === beforeMove, JSON.stringify(moved2));
  check('系列名跟着新路径更新、标签不丢',
    itemOf('换过来的/鼓掌-改名.jpg').series === '换过来的'
    && JSON.stringify(itemOf('换过来的/鼓掌-改名.jpg').tags) === JSON.stringify(originalTags),
    JSON.stringify([itemOf('换过来的/鼓掌-改名.jpg').series, itemOf('换过来的/鼓掌-改名.jpg').tags]));
  // 复制一份：同内容两个路径，副本直接继承标签
  writeFileSync(join(libDir, '换过来的', '鼓掌-副本.jpg'), readFileSync(join(libDir, '换过来的', '鼓掌-改名.jpg')));
  const copied = await library.sync({ tag: true });
  check('复制出来的一份直接继承标签、不调模型', copied.moved === 1 && calls.length === beforeMove, JSON.stringify(copied));
  check('副本与原图标签一致',
    JSON.stringify(itemOf('换过来的/鼓掌-副本.jpg').tags) === JSON.stringify(originalTags));
  // 改名同时改内容：内容真的变了，仍要重新打标
  writeImage(libDir, '换过来的/鼓掌-改名.jpg', 'cat-2-replaced');
  const renamedChanged = await library.sync({ tag: true });
  check('改名同时改内容 → 算变动并重新打标',
    renamedChanged.updated === 1 && calls.length === beforeMove + 1, JSON.stringify(renamedChanged));

  console.log('\n9. autoTag 关闭：只建索引不打标');
  const noTagDir = join(tmpRoot, 'no-tag');
  writeImage(noTagDir, 'x/1.jpg', 'nt-1');
  writeImage(noTagDir, 'x/2.jpg', 'nt-2');
  const noTag = makeLibrary(noTagDir, { sticker: { autoTag: false } });
  const ntReport = await noTag.library.sync({ tag: true });
  check('索引建好了但没有调模型', ntReport.files === 2 && noTag.calls.length === 0, 'calls=' + noTag.calls.length);
  check('待打标 = 2', ntReport.pending === 2, String(ntReport.pending));
  check('条目没有标签', loadIndexAt(noTagDir).index.items.every((item) => hasStickerTags(item) !== true));

  console.log('\n10. 模型留空 → 跟随视觉配置；都没配 → 跳过并给出原因');
  const visionLib = makeLibrary(join(tmpRoot, 'vision-fallback'), { sticker: { provider: '', model: '' }, vision: { provider: 'vp', model: 'vm' } });
  check('provider/model 留空时跟随 vision', (() => {
    const model = visionLib.library.resolveModel();
    return model !== null && model.provider === 'vp' && model.model === 'vm';
  })());
  const noModelLib = makeLibrary(join(tmpRoot, 'no-model'), { sticker: { provider: '', model: '' }, vision: { provider: '', model: '' } });
  writeImage(join(tmpRoot, 'no-model'), 'a/1.jpg', 'nm-1');
  const nmReport = await noModelLib.library.sync({ tag: true });
  check('没有模型时报告可读原因、不算崩溃', nmReport.ok === true && nmReport.failed === 1 && nmReport.errors[0].includes('未配置打标模型'), JSON.stringify(nmReport.errors));
  check('没有模型时不调模型', noModelLib.calls.length === 0);

  console.log('\n11. 坏索引自愈');
  const brokenDir = join(tmpRoot, 'broken');
  writeImage(brokenDir, 'a/1.jpg', 'broken-1');
  writeFileSync(join(brokenDir, INDEX_FILE), '{ not json');
  const broken = makeLibrary(brokenDir);
  const brokenStatus = await broken.library.status();
  check('坏索引在状态里被标成 corrupt', brokenStatus.corrupt === true && brokenStatus.indexExists === true, JSON.stringify(brokenStatus).slice(0, 120));
  const healed = await broken.library.sync({ tag: false });
  check('重新扫描后索引可读', healed.ok === true && loadIndexAt(brokenDir).corrupt === false && loadIndexAt(brokenDir).index.items.length === 1);

  console.log('\n12. ensureFresh：首次建索引，之后判定为 fresh');
  const freshDir = join(tmpRoot, 'fresh');
  writeImage(freshDir, 'a/1.jpg', 'fresh-1');
  const fresh = makeLibrary(freshDir);
  const firstFresh = await fresh.library.ensureFresh();
  check('首次使用会扫描建索引', firstFresh.ok === true && firstFresh.synced === true && existsSync(join(freshDir, INDEX_FILE)));
  const secondFresh = await fresh.library.ensureFresh();
  check('没变动时不再扫描（synced=false）', secondFresh.ok === true && secondFresh.synced === false && secondFresh.fresh === true);

  console.log('\n13. 后台重建（设置页按钮走这条）');
  const jobDir = join(tmpRoot, 'job');
  writeImage(jobDir, 'a/1.jpg', 'job-1');
  const jobLib = makeLibrary(jobDir);
  const started = jobLib.library.startRebuild({ tag: true });
  check('重建立即返回并标记为运行中', started.started === true && started.job !== null && started.job.running === true);
  const again = jobLib.library.startRebuild({ tag: true });
  check('同一时刻只跑一个任务', again.started === false);
  let waited = 0;
  while (waited < 5000) {
    const st = await jobLib.library.status();
    if (st.job !== null && st.job.running !== true) break;
    await sleep(50);
    waited += 50;
  }
  const finished = await jobLib.library.status();
  check('任务跑完：打标 1 张、进度收尾', finished.job !== null && finished.job.running === false && finished.total === 1 && finished.tagged === 1,
    JSON.stringify(finished.job));

  console.log('\n14. 挑图：search / pick');
  const pickDir = join(tmpRoot, 'pick');
  writeImage(pickDir, '猫猫/无语.jpg', 'p1');
  writeImage(pickDir, '猫猫/开心.jpg', 'p2');
  writeImage(pickDir, '日常/疑问.png', 'p3');
  // 打标顺序 = listImageFiles 的路径排序（中文按 code point：日常 < 猫猫，开心 < 无语），
  // 所以第 1 张 日常/疑问.png、第 2 张 猫猫/开心.jpg、第 3 张 猫猫/无语.jpg。
  const pickLib = makeLibrary(pickDir, {
    reply: (n) => (n === 1 ? '【标签】疑问\n【描述】头上冒问号'
      : n === 2 ? '【标签】猫,开心\n【描述】橘猫笑'
        : '【标签】猫,无语\n【描述】橘猫翻白眼'),
  });
  await pickLib.library.sync({ tag: true });
  const hit = pickLib.library.search({ q: '无语' });
  check('按标签搜到目标图', hit.length === 1 && hit[0].id === '猫猫/无语.jpg' && hit[0].series === '猫猫', JSON.stringify(hit));
  check('按系列过滤', pickLib.library.search({ series: '日常' }).length === 1);
  check('limit 生效', pickLib.library.search({ limit: 2 }).length === 2);
  check('pick 按 id 拿到绝对路径', (() => {
    const picked = pickLib.library.pick({ id: '猫猫/开心.jpg' });
    return picked !== null && picked.path === join(pickDir, '猫猫', '开心.jpg');
  })());
  check('pick 按关键词挑第一张', (() => {
    const picked = pickLib.library.pick({ q: '橘猫 笑' });
    return picked !== null && picked.item.file === '猫猫/开心.jpg';
  })());
  check('不存在的 id 返回 null', pickLib.library.pick({ id: '不存在.jpg' }) === null);

  console.log('\n15. 发送目标判定（resolveStickerTarget）');
  check('群会话 → group + 群号', (() => {
    const target = resolveStickerTarget({ key: 'group-12345', groupId: '12345', speaker: { userId: '9', groupId: '12345' } });
    return target !== null && target.messageType === 'group' && target.targetId === '12345';
  })());
  check('私聊会话 → private + QQ 号', (() => {
    const target = resolveStickerTarget({ key: 'private-88888', speaker: { userId: '88888', groupId: null } });
    return target !== null && target.messageType === 'private' && target.targetId === '88888';
  })());
  check('共享会话（key=shared）退回发言人的群号', (() => {
    const target = resolveStickerTarget({ key: 'shared', groupId: null, turnSpeaker: { userId: '7', groupId: '555' } });
    return target !== null && target.messageType === 'group' && target.targetId === '555';
  })());
  check('拿不到目标时返回 null（绝不猜）', resolveStickerTarget(null) === null && resolveStickerTarget({ key: 'shared' }) === null);

  console.log('\n16. 目录解析：相对路径按 QQ_msg 解析，留空 = sticker 子目录');
  const relLib = makeLibrary('/tmp/qqroot', { sticker: { dir: 'mystickers' } });
  check('相对目录拼到 QQ_msg 下', relLib.library.resolveDir() === join('/tmp/qqroot', 'mystickers'), relLib.library.resolveDir());
  const defaultLib = makeLibrary('/tmp/qqroot', { sticker: { dir: '' } });
  check('留空 = <QQ_msg>/sticker', defaultLib.library.resolveDir() === join('/tmp/qqroot', 'sticker'), defaultLib.library.resolveDir());

  console.log('\n17. 配置契约（默认值与设置字段）');
  const config = await import('../lib/config.js');
  check('schema 里有 sticker 组且默认开启', config.DEFAULTS.sticker.enabled === true && config.DEFAULTS.sticker.autoTag === true);
  const stickerFields = config.SETTINGS_FIELDS.filter((field) => field.group === 'sticker');
  check('设置页有 8 个表情包字段', stickerFields.length === 8, String(stickerFields.length));
  check('卡片字段挂在 能力 → 表情包', stickerFields.every((field) => field.tab === 'capability' && field.subtab === 'sticker'));
  check('开关是 kind=sticker 的卡片，其余是卡片内字段',
    stickerFields.find((field) => field.path.join('.') === 'sticker.enabled').kind === 'sticker'
    && stickerFields.filter((field) => field.in === 'sticker-card').length === 7,
    JSON.stringify(stickerFields.map((field) => [field.path.join('.'), field.kind, field.in || ''])));
  console.log('\n18. 设置页路由：状态 / 重建 / 参数校验');
  const { registerStickerRoutes } = await import('../lib/gateway/routes-sticker.js');
  const routeLib = makeLibrary(join(tmpRoot, 'route'), { sticker: { maxPerRun: 5 } });
  writeImage(join(tmpRoot, 'route'), '系列/1.jpg', 'route-1');
  const handlers = {};
  const fakeRes = () => ({
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body) { this.body = String(body); },
  });
  const routeHandle = registerStickerRoutes({
    webServer: { register({ path, handler }) { handlers[path] = handler; return () => { delete handlers[path]; }; } },
    sticker: routeLib.library,
    guard: () => true,
    log: () => {},
  });
  check('注册了状态与重建两条路由', routeHandle.ok === true
    && typeof handlers['/dsh-qq-bot/sticker'] === 'function'
    && typeof handlers['/dsh-qq-bot/sticker/rebuild'] === 'function');
  const stateRes = fakeRes();
  await handlers['/dsh-qq-bot/sticker']({ method: 'GET' }, stateRes);
  const stateJson = JSON.parse(stateRes.body);
  check('GET 状态：ok + 目录 + 系列（未扫描时 total=0）', stateRes.status === 200 && stateJson.ok === true
    && stateJson.dir === join(tmpRoot, 'route') && stateJson.total === 0 && Array.isArray(stateJson.series),
    stateRes.body.slice(0, 160));
  const bodyOf = (obj) => ({
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)); },
  });
  const rebuildRes = fakeRes();
  await handlers['/dsh-qq-bot/sticker/rebuild'](bodyOf({ mode: 'index' }), rebuildRes);
  const rebuildJson = JSON.parse(rebuildRes.body);
  check('POST 重建：立刻返回并标记任务', rebuildRes.status === 200 && rebuildJson.ok === true
    && rebuildJson.started === true && rebuildJson.job !== null && rebuildJson.job.mode === 'index', rebuildRes.body.slice(0, 200));
  let waitJob = 0;
  while (waitJob < 5000) {
    const st = await routeLib.library.status();
    if (st.job !== null && st.job.running !== true) break;
    await sleep(50);
    waitJob += 50;
  }
  const badModeRes = fakeRes();
  await handlers['/dsh-qq-bot/sticker/rebuild'](bodyOf({ mode: 'whatever' }), badModeRes);
  check('未知 mode 被 400 拒绝', badModeRes.status === 400);
  const methodRes = fakeRes();
  await handlers['/dsh-qq-bot/sticker']({ method: 'POST' }, methodRes);
  check('状态路由只认 GET', methodRes.status === 405);

} catch (error) {
  failures += 1;
  console.error('[FAIL] 测试抛错：' + (error && error.stack ? error.stack : error));
  exitCode = 1;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GIF：表情包大量是动图，而视觉模型只吃静态图 —— 打标前必须能把首帧转成 PNG。
// ---------------------------------------------------------------------------
console.log('\nGIF 首帧转码');
{
  // 手搓一张 2x2 的 GIF：全局色表 2 色（黑/白）+ 索引 0,1,1,0 → 黑白黑白的 2x2。
  const mkGif = () => {
    const bytes = [];
    bytes.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    bytes.push(2, 0, 2, 0);            // 宽 2 高 2
    bytes.push(0x80);                  // 有全局色表，1 位色深 → 2 色
    bytes.push(0, 0);                  // 背景索引 / 像素宽高比
    bytes.push(0, 0, 0, 0xff, 0xff, 0xff); // 调色板：黑、白
    bytes.push(0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0); // 图像描述符 2x2
    bytes.push(2);                     // 最小码长 2
    // LZW：clear(4) + 0 + 1 + 1 + 0 + EOI(5)，码长 3 位
    const codes = [4, 0, 1, 1, 0, 5];
    let buf = 0, bits = 0;
    const out = [];
    for (const code of codes) {
      buf |= code << bits; bits += 3;
      while (bits >= 8) { out.push(buf & 0xff); buf >>= 8; bits -= 8; }
    }
    if (bits > 0) out.push(buf & 0xff);
    bytes.push(out.length, ...out, 0); // 子块 + 结束块
    bytes.push(0x3b);
    return Buffer.from(bytes);
  };
  const gif = mkGif();
  check('认得出手搓 GIF', sniffImage(gif) === 'gif', String(sniffImage(gif)));
  const png = gifFirstFrameToPng(gif);
  check('GIF 能解出 PNG', png !== null && png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG',
    png === null ? 'null' : png.subarray(0, 8).toString('hex'));
  // 默认（兼容模式关闭）：GIF 原样发，不重编码
  const raw = visionPayload(gif, 'a.gif');
  check('默认原样发送 GIF（不转码）', raw.mediaType === 'image/gif' && raw.converted === false && raw.data === gif,
    JSON.stringify({ mediaType: raw.mediaType, converted: raw.converted }));
  // 兼容模式打开：首帧转 PNG
  const compat = visionPayload(gif, 'a.gif', { gifCompat: true });
  check('兼容模式下 GIF 转成首帧 PNG', compat.mediaType === 'image/png' && compat.converted === true && compat.data[0] === 0x89,
    JSON.stringify({ mediaType: compat.mediaType, converted: compat.converted }));
  // 扩展名撒谎：内容是 JPEG 的 .gif 要按真实内容发（两种模式都一样）
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  const liar = visionPayload(jpeg, 'b.gif');
  check('扩展名是 .gif 但内容是 JPEG：按 JPEG 发', liar.mediaType === 'image/jpeg' && liar.converted === false,
    JSON.stringify({ mediaType: liar.mediaType, converted: liar.converted }));
  const liarCompat = visionPayload(jpeg, 'b.gif', { gifCompat: true });
  check('兼容模式下假 GIF 仍按真实内容发', liarCompat.mediaType === 'image/jpeg' && liarCompat.converted === false,
    JSON.stringify({ mediaType: liarCompat.mediaType, converted: liarCompat.converted }));
  const truth = visionPayload(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0)]), 'c.png');
  check('PNG 原样发（不重编码）', truth.mediaType === 'image/png' && truth.converted === false);
  check('坏数据不抛错', gifFirstFrameToPng(Buffer.from('not a gif at all')) === null);
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('表情包自测失败'); process.exit(1); }
console.log('表情包自测通过');
process.exit(exitCode);
