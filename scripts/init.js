#!/usr/bin/env node
/**
 * 初始化单账号密码（技术方案 §4 / §9.3）。
 *
 * 用法：
 *   node scripts/init.js                  # 交互输入密码（推荐）
 *   node scripts/init.js --password 12345678
 *   node scripts/init.js --password xxx --force   # 覆盖已有密码
 *
 * 产物：data/config.json（argon2id 哈希，0600），可用 DATA_DIR / CONFIG_PATH 改位置。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolveConfig, readAccountConfig, writeAccountConfig } from '../server/config.js';
import { hashPassword } from '../server/auth.js';

function parseArgs(argv) {
  const args = { password: undefined, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--password' || token === '-p') {
      args.password = argv[i + 1];
      i += 1;
    } else if (token.startsWith('--password=')) {
      args.password = token.slice('--password='.length);
    } else if (token === '--force' || token === '-f') {
      args.force = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

async function askPassword() {
  const rl = readline.createInterface({ input, output });
  try {
    const first = await rl.question('设置登录密码（至少 6 位）：');
    const second = await rl.question('再输一遍确认：');
    if (first !== second) {
      throw new Error('两次输入的密码不一致');
    }
    return first;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/init.js [--password <密码>] [--force]');
    return;
  }

  const cfg = resolveConfig();
  const existing = readAccountConfig(cfg);

  if (existing?.passwordHash && !args.force) {
    console.error(`已经初始化过（${cfg.configPath}）。要重设密码请加 --force。`);
    process.exitCode = 2;
    return;
  }

  let password = args.password ?? process.env.INIT_PASSWORD;
  if (!password) {
    if (!input.isTTY) {
      console.error('非交互环境请用 --password 或 INIT_PASSWORD 传密码。');
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

  const passwordHash = await hashPassword(password);
  writeAccountConfig(cfg, {
    passwordHash,
    algo: 'argon2id',
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });

  console.log(`已写入 ${cfg.configPath}`);
  console.log('密码只保存 argon2id 哈希，忘记密码可重新运行本脚本 --force 重置。');
}

main().catch((err) => {
  console.error('初始化失败：', err);
  process.exitCode = 1;
});
