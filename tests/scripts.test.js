import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT = path.join(ROOT, 'scripts', 'init.js');
const BACKUP = path.join(ROOT, 'scripts', 'backup.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('scripts/init.js：写 config.json，重复执行须 --force', () => {
  const dir = tempDir('ssb-init-');
  try {
    const env = { ...process.env, DATA_DIR: dir };
    const first = spawnSync(process.execPath, [INIT, '--password', 'testpass123'], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);

    const configPath = path.join(dir, 'config.json');
    assert.ok(fs.existsSync(configPath));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(typeof config.passwordHash, 'string');
    assert.ok(config.passwordHash.length > 20);

    const second = spawnSync(process.execPath, [INIT, '--password', 'testpass123'], { env, encoding: 'utf8' });
    assert.equal(second.status, 2, '已有密码时应拒绝覆盖');

    const forced = spawnSync(process.execPath, [INIT, '--password', 'newpass456', '--force'], { env, encoding: 'utf8' });
    assert.equal(forced.status, 0, forced.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/backup.js：--keep 2 连跑 3 次只留 2 个 .db，且无 -wal/-shm 残留', () => {
  const dir = tempDir('ssb-bak-');
  try {
    const db = openDatabase(path.join(dir, 'app.db'));
    const now = Date.now();
    db.prepare(
      `INSERT INTO students (name, school, weekday, sort, tags_json, tags_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', NULL, ?, ?)`,
    ).run('备份样本', '测试学校', 1, 1, now, now);
    db.close();

    const env = { ...process.env, DATA_DIR: dir };
    for (let i = 0; i < 3; i += 1) {
      const out = execFileSync(process.execPath, [BACKUP, '--keep', '2'], { env, encoding: 'utf8' });
      assert.match(out, /备份完成/);
      assert.match(out, /完整性校验：ok/);
    }

    const backupDir = path.join(dir, 'backups');
    const files = fs.readdirSync(backupDir);
    const dbFiles = files.filter((f) => /^app-\d{8}-\d{6}(?:-\d+)?\.db$/.test(f));
    const sidecars = files.filter((f) => /-(wal|shm)$/.test(f));
    assert.equal(dbFiles.length, 2, `应只保留 2 份，实际：${files.join(', ')}`);
    assert.equal(sidecars.length, 0, `不应有 sidecar：${sidecars.join(', ')}`);

    // 备份文件可打开且内容完整
    const check = openDatabase(path.join(backupDir, dbFiles[0]));
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM students').get().n, 1);
    } finally {
      check.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/backup.js：清理没有对应 .db 的孤儿 -wal/-shm', () => {
  const dir = tempDir('ssb-bak-orphan-');
  try {
    const db = openDatabase(path.join(dir, 'app.db'));
    db.prepare(
      `INSERT INTO students (name, school, weekday, sort, tags_json, tags_at, created_at, updated_at)
       VALUES ('样本', NULL, 1, 1, '[]', NULL, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.close();

    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'app-20200101-000000.db-wal'), 'junk');
    fs.writeFileSync(path.join(backupDir, 'app-20200101-000000.db-shm'), 'junk');

    execFileSync(process.execPath, [BACKUP, '--keep', '7'], {
      env: { ...process.env, DATA_DIR: dir },
      encoding: 'utf8',
    });

    assert.equal(fs.existsSync(path.join(backupDir, 'app-20200101-000000.db-wal')), false);
    assert.equal(fs.existsSync(path.join(backupDir, 'app-20200101-000000.db-shm')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/backup.js：--keep 非整数时退出码 2', () => {
  const dir = tempDir('ssb-bak-bad-');
  try {
    const env = { ...process.env, DATA_DIR: dir };
    const out = spawnSync(process.execPath, [BACKUP, '--keep', 'abc'], { env, encoding: 'utf8' });
    assert.equal(out.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
