#!/usr/bin/env node
/**
 * 主动发言依赖接线自测：`node test/test-proactive-wiring.mjs`
 *
 * 守的是一类「工厂解构的键名」和「调用方传的键名」不一致的接线错误：
 *   历史事故：proactive-surface 解构 `getSessionApi`，plugin 却传 `sessionApi`，
 *   于是每次主动发言都报「getSessionApi is not a function」并降级，且只在 15 分钟后的
 *   第一次 tick 才暴露（测试全绿、启动日志也不说）。
 * 这里既做静态对账（源码里的键名），也做一次真实构造（守卫会打印可读的缺依赖提示）。
 */
import { readFileSync } from 'node:fs';
import { createProactiveSurface } from '../lib/gateway/proactive-surface.js';
import { createHostPersonaReader, pickPersonaText, HOST_PERSONA_SECTION } from '../lib/gateway/host-persona.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const surfaceSrc = readFileSync(new URL('../lib/gateway/proactive-surface.js', import.meta.url), 'utf8');
const pluginSrc = readFileSync(new URL('../lib/gateway/plugin.js', import.meta.url), 'utf8');
const toolsSrc = readFileSync(new URL('../lib/tools/index.js', import.meta.url), 'utf8');

console.log('1. 工厂要的键名');
const destructure = /const \{([^}]*)\}\s*=\s*deps/.exec(surfaceSrc);
const wanted = destructure === null ? [] : destructure[1].split(',').map((item) => item.trim());
check('proactive-surface 解构 getSessionApi', wanted.includes('getSessionApi'), JSON.stringify(wanted));

console.log('\n2. plugin 传的键名与工厂一致');
const callStart = pluginSrc.indexOf('createProactiveSurface({');
check('找得到 createProactiveSurface 调用', callStart >= 0);
const callBlock = callStart < 0 ? '' : pluginSrc.slice(callStart, pluginSrc.indexOf('});', callStart));
check('plugin 传了 getSessionApi', /getSessionApi\s*:/.test(callBlock), callBlock.slice(0, 240));
check('plugin 不再传错的 sessionApi 键', !/(^|\s)sessionApi\s*:/.test(callBlock), callBlock.slice(0, 240));

console.log('\n3. 缺依赖时要给出可读提示（不静默）');
{
  const errors = [];
  const originalError = console.error;
  console.error = (line) => { errors.push(String(line)); };
  try {
    const surface = createProactiveSurface({
      TAG: '[test]',
      getConfig: () => ({ proactive: {}, auth: {}, session: {}, perChatSession: true }),
      getState: () => ({ proactive: { timer: null } }),
      ctx: {},
      describeError: (e) => String(e),
      callAdapterAction: async () => ({ ok: true }),
      // 故意不传 getSessionApi：模拟接线写错
      writeToAdapter: () => true,
    });
    check('仍是可构造的（降级而不是崩）', typeof surface.scheduleProactive === 'function' && typeof surface.stopProactive === 'function');
    if (typeof surface.stopProactive === 'function') surface.stopProactive();
  } finally {
    console.error = originalError;
  }
  check('缺 getSessionApi 时启动就报出来', errors.some((line) => line.includes('getSessionApi')), JSON.stringify(errors));
}

console.log('\n4. 依赖齐了就不再报缺');
{
  const errors = [];
  const originalError = console.error;
  console.error = (line) => { errors.push(String(line)); };
  try {
    const surface = createProactiveSurface({
      TAG: '[test]',
      getConfig: () => ({ proactive: {}, auth: {}, session: {}, perChatSession: true }),
      getState: () => ({ proactive: { timer: null } }),
      ctx: {},
      describeError: (e) => String(e),
      callAdapterAction: async () => ({ ok: true }),
      getSessionApi: () => ({ getEntry: async () => null }),
      writeToAdapter: () => true,
    });
    if (typeof surface.stopProactive === 'function') surface.stopProactive();
  } finally {
    console.error = originalError;
  }
  check('依赖齐时没有缺依赖告警', errors.length === 0, JSON.stringify(errors));
}

console.log('\n5. 宿主人格段：只认 soul:persona');
{
  const assembly = {
    sections: [
      { name: 'deployment:system', text: '你是助手' },
      { name: 'deployment:persona', text: '宿主人设（不取）' },
      { name: 'deployment:persona-prefix', text: '前缀人设（不取）' },
      { name: 'soul:memory', text: '大量记忆内容（不取）' },
      { name: 'soul:persona', text: '鲸鱼娘女仆' },
      { name: 'tools:list', text: '工具清单（不取）' },
    ],
  };
  const text = pickPersonaText(assembly);
  check('取到 soul:persona', text === '鲸鱼娘女仆', text);
  check('不掺别的段（人设 / 记忆 / 工具）', !text.includes('宿主人设') && !text.includes('前缀人设') && !text.includes('大量记忆内容') && !text.includes('工具清单'), text);
  check('段顺序无关（排在后面也能取到）', pickPersonaText({ sections: [{ name: 'soul:persona', text: '甲' }, { name: 'x', text: '乙' }] }) === '甲');
  check('没有该段时返回空串', pickPersonaText({ sections: [{ name: 'deployment:persona', text: '宿主人设' }] }) === '');
  check('异常入参不炸', pickPersonaText(null) === '' && pickPersonaText({}) === '');
  check('段名常量是 soul:persona', HOST_PERSONA_SECTION === 'soul:persona');
}

console.log('\n6. 读取器：缺服务 / 求值抛错 都降级成空串');
{
  const noService = createHostPersonaReader({ getSystemPrompt: () => undefined });
  check('没有 systemPrompt 服务时返回空串', (await noService(null)) === '');

  const throwing = createHostPersonaReader({
    getSystemPrompt: () => ({ assemble: async () => { throw new Error('boom'); } }),
    log: () => {},
  });
  check('assemble 抛错时返回空串（不把主动发言搞挂）', (await throwing(null)) === '');

  let seenAgent = 'unset';
  const ok = createHostPersonaReader({
    getSystemPrompt: () => ({ assemble: async (context) => { seenAgent = context && context.agent; return { sections: [{ name: 'soul:persona', text: '鲸鱼娘' }] }; } }),
  });
  const agent = { id: 'agent-1' };
  const text = await ok(agent);
  check('把 agent 交给宿主求值', seenAgent === agent && text === '鲸鱼娘', String(text));
}

console.log('\n7. 主动发言发表情包：接线 + 隐式引导');
{
  const callStart = pluginSrc.indexOf('createProactiveSurface({');
  const callBlock = callStart < 0 ? '' : pluginSrc.slice(callStart, pluginSrc.indexOf('});', callStart));
  check('plugin 传了 sendStickerWithText', /sendStickerWithText\s*:/.test(callBlock), callBlock.slice(0, 260));
  check('plugin 传了 stickerAvailable', /stickerAvailable\s*:/.test(callBlock), callBlock.slice(0, 260));

  check('表面层只在图库可用时向模型要关键词', /sticker:\s*wantsSticker/.test(surfaceSrc), '');
  check('表面层把文字交给 sendStickerWithText', /sendStickerWithText\(\{ groupId, query: stickerQuery, text: verdict\.text \}\)/.test(surfaceSrc), '');
  check('挑不到图时退回纯文字', /没挑到合适表情包，只发文字/.test(surfaceSrc), '');
  check('演练模式不发表情包', /本想配表情包关键词/.test(surfaceSrc), '');

  // 隐式引导只落在工具描述里，不进会话提示词
  check('qq_sticker 描述里写明可以主动用', /就主动挑一张发出去，不用等用户开口要/.test(toolsSrc), '');
  check('描述里限制一次一张', /一次最多一张，别刷屏/.test(toolsSrc), '');
  check('主动发言提示词没有硬塞表情包引导（走决策字段）', /表情包关键词或空字符串/.test(readFileSync(new URL('../lib/session/proactive.js', import.meta.url), 'utf8')), '');
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
