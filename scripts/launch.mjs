#!/usr/bin/env node
/**
 * 傻瓜式启动器：
 * - 首次运行自动构建前端（web/dist 缺失时）
 * - 首次运行引导设置登录密码（data/config.json 缺失时）
 * - 启动服务并自动打开浏览器
 * - 服务以隐藏的后台进程运行；按回车关掉这个窗口，服务继续跑
 * - 停止服务用「停止学生状态管理系统.cmd」，不会开机自启
 *
 * 可选环境变量：
 *   PORT=3210        监听端口
 *   HOST=0.0.0.0     监听地址（默认回环 + 局域网）
 *   LAUNCH_NO_OPEN=1 只启动服务，不打开浏览器（调试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const URL = `http://127.0.0.1:${PORT}`;
const NO_OPEN = process.env.LAUNCH_NO_OPEN === '1';

function lanAddresses() {
  const result = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Tailscale 的 100.x 是私网但不算「同一 Wi-Fi」，别混进局域网地址
    if (/tailscale/i.test(name)) continue;
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      const [a, b] = item.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) continue; // CGNAT / Tailscale
      result.push(item.address);
    }
  }
  return [...new Set(result)];
}

function tailscaleUrl() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'logs', 'tailscale-url.txt'), 'utf8').trim();
    return /^https:\/\/\S+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function printAccessUrls() {
  log(`本机访问：${URL}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const list = lanAddresses();
    if (list.length) {
      log('局域网访问（手机和电脑连同一个 Wi-Fi）：');
      for (const ip of list) console.log(`    http://${ip}:${PORT}`);
    } else {
      log('没有检测到局域网 IPv4 地址，请检查 Wi-Fi 连接。');
    }
  }
  const ts = tailscaleUrl();
  if (ts) log(`跨网访问（手机开着 Tailscale 即可）：${ts}`);
}


function saveAccessUrls() {
  const lines = [`本机：${URL}`];
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const ip of lanAddresses()) lines.push(`局域网：http://${ip}:${PORT}`);
  }
  const ts = tailscaleUrl();
  if (ts) lines.push(`跨网：${ts}`);
  try {
    const dir = path.join(ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'access-urls.txt'), `\uFEFF${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* 写不进去不影响启动 */
  }
}

/** 双击 .cmd 时窗口是 TTY：停住等回车，别一闪而过；管道/自动化里不阻塞。 */
function pauseIfInteractive() {
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    process.stdout.write('\n按回车关闭这个窗口…');
    process.stdin.resume();
    const done = () => {
      process.stdin.pause();
      resolve();
    };
    process.stdin.once('data', done);
    process.stdin.once('end', done);
  });
}

function log(message) {
  console.log(`\n[学生状态管理系统] ${message}`);
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    log(`浏览器没能自动打开，请手动访问 ${url}`);
  }
}

async function isServerUp() {
  try {
    const res = await fetch(`${URL}/api/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function isPortBusy() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function runBuild() {
  log('首次启动：正在构建前端页面，大约需要 1 分钟，请稍候…');
  const tmp = path.join(ROOT, '.tmp-build');
  fs.mkdirSync(tmp, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, TEMP: tmp, TMP: tmp },
  });
  if (result.status !== 0) {
    log('前端构建失败，请查看上面的报错。');
    process.exit(1);
  }
}

function runInit() {
  log('首次使用：请设置登录密码（输入时不会显示，按回车确认）。');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'init.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    log('登录密码没有设置成功，启动已取消。');
    process.exit(1);
  }
}

async function waitForHealth(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * 以「脱离控制台」的方式启动服务：窗口关掉后进程继续跑。
 * stdout/stderr 落 logs\server.out.log / server.err.log，PID 落 logs\server.pid。
 */
function startDetachedServer() {
  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, 'server.out.log');
  const errPath = path.join(logDir, 'server.err.log');
  const out = fs.openSync(outPath, 'a');
  const err = fs.openSync(errPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err],
      env: {
        ...process.env,
        HOST,
        PORT: String(PORT),
        COOKIE_SECURE: process.env.COOKIE_SECURE || 'auto',
      },
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  child.unref();
  fs.writeFileSync(path.join(logDir, 'server.pid'), `${child.pid}\n`, 'utf8');
  return child;
}

async function main() {
  process.chdir(ROOT);

  if (await isServerUp()) {
    log(`服务已经在运行：${URL}`);
    printAccessUrls();
    saveAccessUrls();
    openBrowser(URL);
    log('这个窗口可以直接关掉，不会影响已经在跑的服务。');
    await pauseIfInteractive();
    return;
  }

  if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    runBuild();
  }

  if (!fs.existsSync(path.join(ROOT, 'data', 'config.json'))) {
    runInit();
  }

  if (await isPortBusy()) {
    log(`端口 ${PORT} 被其他程序占用了，服务没法启动。`);
    log(`可以关掉占用端口的程序，或者用 set PORT=其他端口 后再双击启动。`);
    process.exitCode = 1;
    return;
  }

  log(`正在启动服务：${URL}`);
  startDetachedServer();

  if (!(await waitForHealth(30000))) {
    log('服务启动失败，请查看日志：');
    console.log(`    ${path.join(ROOT, 'logs', 'server.err.log')}`);
    process.exitCode = 1;
    await pauseIfInteractive();
    return;
  }

  log('启动成功，正在打开浏览器…');
  openBrowser(URL);
  printAccessUrls();
  saveAccessUrls();
  log('服务已在后台运行。按回车关闭这个窗口，服务不会停。');
  log('需要停止时，双击「停止学生状态管理系统.cmd」。');
  await pauseIfInteractive();
}

main().catch((err) => {
  log(`启动失败：${err?.message || err}`);
  process.exit(1);
});
