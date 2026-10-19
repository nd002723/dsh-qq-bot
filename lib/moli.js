// dsh-moli 联动模块：探测 Moli 无头浏览器引擎并用它渲染抓取网页（qq_webfetch 的 moli 路径）。
// 未安装 moli 时 meFindMoli 返回 undefined，meMoliFetchText 拒绝并给出可读报错。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';

/** 探测 Moli 引擎可执行文件（标准位置 + PATH；未找到返回 undefined）。 */
function meFindMoli(exePath) {
  const home = process.env.HOME ?? homedir();
  const configured = (typeof exePath === 'string' && exePath.trim() !== '') ? exePath.trim() : '';
  const candidates = [
    configured !== '' ? configured : undefined,
    join(home, '.local', 'bin', 'moli'),
    join(home, '.local', 'share', 'moli', 'bin', 'moli'),
    join(home, '.local', 'share', 'moli', 'moli'),
    join(home, '.moli', 'bin', 'moli'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* 不存在，继续 */ }
  }
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'moli');
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* 继续 */ }
  }
  return undefined;
}

/** 用 Moli 无头浏览器渲染抓取 URL，返回渲染后的页面文本（markdown）。 */
function meMoliFetchText(url, proxy, timeoutMs, exePath) {
  const exe = meFindMoli(exePath);
  if (exe === undefined) return Promise.reject(new Error('Moli 引擎未安装（未找到 moli 可执行文件）'));
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;
  const args = ['fetch', '-d', 'markdown', '-t', String(deadline)];
  if (typeof proxy === 'string' && proxy !== '') args.push('--http-proxy', proxy);
  args.push('--insecure-disable-tls-host-verification', url);
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: deadline + 10000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) { reject(new Error(String(error.message ?? error))); return; }
        resolve(String(stdout ?? ''));
      });
  });
}

export { meFindMoli, meMoliFetchText };
