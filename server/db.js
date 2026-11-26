/**
 * SQLite 连接与建表（技术方案 §4）。
 *
 * 注意：better-sqlite3 是同步 API，事务必须用 db.transaction() 包住；
 * 外键级联依赖每个连接上都执行 PRAGMA foreign_keys = ON（默认关）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  school     TEXT,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  sort       REAL NOT NULL DEFAULT 0,
  tags_json  TEXT NOT NULL DEFAULT '[]',
  tags_at    INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedbacks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  happened_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  weeks      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 单行设置：目前只存 llm_config（AES-256-GCM 密文，key 由 config.json 的 passwordHash 派生）
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_students_weekday ON students(weekday, sort);
CREATE INDEX IF NOT EXISTS idx_feedbacks_student_time ON feedbacks(student_id, happened_at);
CREATE INDEX IF NOT EXISTS idx_generations_student_time ON generations(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

/**
 * 打开数据库并建表。
 * @param {string} dbPath 绝对路径，或 ':memory:'
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]
 */
export function openDatabase(dbPath, opts = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, opts.verbose ? { verbose: console.log } : undefined);

  // WAL 只在文件库上才有意义；内存库设了也不报错但无意义
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // 并发写等待，避免瞬时 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA_SQL);

  // 每次连接都确认外键真的开着（pragma 是连接级的，不可跨连接继承）
  const fk = db.pragma('foreign_keys', { simple: true });
  if (Number(fk) !== 1) {
    throw new Error('SQLite foreign_keys 未能开启，级联删除会失效');
  }

  return db;
}

/** 供 /healthz 之类探活用 */
export function pingDatabase(db) {
  try {
    return db.prepare('SELECT 1 AS ok').get().ok === 1;
  } catch {
    return false;
  }
}
