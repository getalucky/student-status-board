#!/usr/bin/env node
/**
 * SQLite 在线备份（技术方案 §9.6）。
 *
 * CLI 契约（部署脚本/任务计划按此调用）：
 *   node scripts/backup.js --keep 7 [--out <dir>]
 *   --keep  保留份数，默认 7
 *   --out   输出目录，默认 <DATA_DIR>\backups
 *
 * 用 better-sqlite3 的在线备份 API（等价 sqlite3 .backup），WAL 下也能拿到一致快照；
 * 备份完做 integrity_check，坏文件不会留下。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveConfig } from '../server/config.js';

function parseArgs(argv) {
  const args = { keep: 7, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--keep' || token === '-k') {
      args.keep = Number(argv[i + 1]);
      i += 1;
    } else if (token.startsWith('--keep=')) {
      args.keep = Number(token.slice('--keep='.length));
    } else if (token === '--out' || token === '-o') {
      args.out = argv[i + 1];
      i += 1;
    } else if (token.startsWith('--out=')) {
      args.out = token.slice('--out='.length);
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/backup.js --keep 7 [--out <目录>]');
    return;
  }
  if (!Number.isInteger(args.keep) || args.keep < 1) {
    console.error('--keep 必须是 >= 1 的整数');
    process.exitCode = 2;
    return;
  }

  const cfg = resolveConfig();
  if (!fs.existsSync(cfg.dbPath)) {
    console.error(`数据库不存在：${cfg.dbPath}（先启动一次服务或跑 scripts/init.js）`);
    process.exitCode = 2;
    return;
  }

  const outDir = path.resolve(args.out ?? path.join(cfg.dataDir, 'backups'));
  fs.mkdirSync(outDir, { recursive: true });

  // 同一秒内连跑（测试/手动）不能互相覆盖：重名就加 -1、-2
  const baseStamp = stamp();
  let dest = path.join(outDir, `app-${baseStamp}.db`);
  for (let n = 1; fs.existsSync(dest); n += 1) {
    dest = path.join(outDir, `app-${baseStamp}-${n}.db`);
  }
  const source = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dest);
  } finally {
    source.close();
  }

  // 校验备份可用。
  // 注意：backup 会沿用源库的 journal_mode=WAL，只读打开再关闭会残留 -wal/-shm；
  // 这里用读写连接把备份库切回 DELETE 并清理 sidecar，备份目录只留干净的 .db。
  const verify = new Database(dest, { fileMustExist: true });
  let integrity = 'unknown';
  try {
    verify.pragma('journal_mode = DELETE');
    integrity = verify.pragma('integrity_check', { simple: true });
  } finally {
    verify.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${dest}${suffix}`, { force: true });
  }
  if (integrity !== 'ok') {
    fs.rmSync(dest, { force: true });
    console.error(`备份完整性校验失败（${integrity}），已丢弃：${dest}`);
    process.exitCode = 1;
    return;
  }

  // 只保留最近 keep 份（按修改时间倒序，文件名兜底；同秒备份也排得对）
  const backups = fs
    .readdirSync(outDir)
    .filter((name) => /^app-\d{8}-\d{6}(?:-\d+)?\.db$/.test(name))
    .map((name) => {
      const full = path.join(outDir, name);
      return { name, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
    .map((entry) => entry.name);
  const removed = [];
  for (const name of backups.slice(args.keep)) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(outDir, `${name}${suffix}`), { force: true });
    }
    removed.push(name);
  }

  // 清理历史遗留的孤儿 sidecar（旧版本只删 .db 不删 -wal/-shm）
  for (const name of fs.readdirSync(outDir)) {
    const match = /^(app-\d{8}-\d{6}(?:-\d+)?\.db)-(?:wal|shm)$/.exec(name);
    if (match && !fs.existsSync(path.join(outDir, match[1]))) {
      fs.rmSync(path.join(outDir, name), { force: true });
    }
  }

  console.log(`备份完成：${dest}`);
  console.log(`完整性校验：${integrity}`);
  console.log(`当前保留 ${Math.min(backups.length, args.keep)} 份（上限 ${args.keep}）${removed.length ? `，已清理 ${removed.length} 份旧备份` : ''}`);
}

main().catch((err) => {
  console.error('备份失败：', err);
  process.exitCode = 1;
});
