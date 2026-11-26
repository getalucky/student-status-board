#!/usr/bin/env node
/**
 * 重置单账号登录密码（忘记密码时用）。
 *
 * 做四件事：
 *   1. 备份 data/config.json 到 data/config.json.bak-<时间戳>
 *   2. 写入新的 argon2id 密码哈希
 *   3. 清空 sessions（已登录设备需要重新登录）
 *   4. 清空 app_settings.llm_config（密码变了，旧 Key 的密文解不开）
 *
 * 用法：
 *   node scripts/reset-password.js                 # 交互确认 + 输入新密码
 *   node scripts/reset-password.js --password xxx --yes   # 自动化（测试用）
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolveConfig, readAccountConfig, writeAccountConfig } from '../server/config.js';
import { hashPassword } from '../server/auth.js';

function parseArgs(argv) {
  const args = { password: undefined, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--password' || token === '-p') {
      args.password = argv[i + 1];
      i += 1;
    } else if (token.startsWith('--password=')) {
      args.password = token.slice('--password='.length);
    } else if (token === '--yes' || token === '-y') {
      args.yes = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

async function confirmReset() {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('确认重置？输入 RESET 继续：');
    return answer.trim() === 'RESET';
  } finally {
    rl.close();
  }
}

async function askPassword() {
  const rl = readline.createInterface({ input, output });
  try {
    const first = await rl.question('设置新的登录密码（至少 6 位）：');
    const second = await rl.question('再输一遍确认：');
    if (first !== second) throw new Error('两次输入的密码不一致');
    return first;
  } finally {
    rl.close();
  }
}

function backupConfig(cfg, now = Date.now()) {
  if (!fs.existsSync(cfg.configPath)) return null;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = `${cfg.configPath}.bak-${stamp}`;
  fs.copyFileSync(cfg.configPath, file);
  return file;
}

/** 能清就清；数据库被服务占用时只警告，不影响新密码生效。 */
async function clearAuthState(cfg) {
  if (!fs.existsSync(cfg.dbPath)) return { sessions: 0, llmCleared: false, skipped: true };
  let db;
  try {
    const { default: Database } = await import('better-sqlite3');
    db = new Database(cfg.dbPath);
    db.pragma('busy_timeout = 5000');
    const sessions = db.prepare('DELETE FROM sessions').run().changes;
    const llm = db.prepare("DELETE FROM app_settings WHERE key = 'llm_config'").run().changes;
    return { sessions: Number(sessions), llmCleared: llm > 0, skipped: false };
  } catch (err) {
    return { sessions: 0, llmCleared: false, skipped: true, error: err?.message || String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/reset-password.js [--password <新密码>] [--yes]');
    return;
  }

  const cfg = resolveConfig();
  const existing = readAccountConfig(cfg);
  if (!existing?.passwordHash) {
    console.error(`还没有初始化过密码（${cfg.configPath} 不存在或没有 passwordHash）。`);
    console.error('首次使用请先双击「启动学生状态管理系统.cmd」，按提示设置密码。');
    process.exitCode = 2;
    return;
  }

  console.log('即将重置登录密码。');
  console.log('注意：重置后已保存的大模型 API Key 会失效，需要到设置页重新填写。');

  if (!args.yes) {
    if (!input.isTTY) {
      console.error('非交互环境请加 --yes（并可用 --password 传新密码）。');
      process.exitCode = 2;
      return;
    }
    if (!(await confirmReset())) {
      console.log('已取消，密码没有改动。');
      return;
    }
  }

  let password = args.password;
  if (!password) {
    if (!input.isTTY) {
      console.error('非交互环境请用 --password 传新密码。');
      process.exitCode = 2;
      return;
    }
    password = await askPassword();
  }

  if (typeof password !== 'string' || password.length < 6) {
    console.error('密码至少 6 位。');
    process.exitCode = 2;
    return;
  }
  if (password.length > 256) {
    console.error('密码过长（最多 256 位）。');
    process.exitCode = 2;
    return;
  }

  const backup = backupConfig(cfg);
  const passwordHash = await hashPassword(password);
  writeAccountConfig(cfg, {
    passwordHash,
    algo: 'argon2id',
    createdAt: existing.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
  const cleared = await clearAuthState(cfg);

  console.log('');
  console.log('密码已重置。');
  if (backup) console.log(`旧配置已备份：${backup}`);
  if (cleared.sessions > 0) console.log(`已退出 ${cleared.sessions} 个登录会话。`);
  if (cleared.llmCleared) console.log('服务器保存的大模型配置已清空，请重新填写 Key。');
  if (cleared.skipped) {
    console.log('没有连接到数据库（或数据库正被服务占用），已登录的会话可能仍然有效。');
    if (cleared.error) console.log(`原因：${cleared.error}`);
    console.log('建议先停止服务，再运行一次本脚本。');
  }
  console.log('现在可以双击「启动学生状态管理系统.cmd」用新密码登录。');
}

main().catch((err) => {
  console.error('重置失败：', err);
  process.exitCode = 1;
});
