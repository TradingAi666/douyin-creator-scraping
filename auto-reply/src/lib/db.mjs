import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DB_PATH = path.resolve("data/douyin-creator.db");

let _db = null;

export function getDb() {
  if (_db) {
    return _db;
  }

  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_title    TEXT NOT NULL,
      username      TEXT NOT NULL,
      comment_text  TEXT NOT NULL,
      reply_message TEXT,
      comment_time  TEXT NOT NULL DEFAULT '2026-03-03',
      reply_count   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(work_title, username, comment_text)
    )
  `);

  // 为旧版本数据库添加新列（列已存在时会抛异常，忽略即可）
  for (const migration of [
    "ALTER TABLE comments ADD COLUMN comment_time TEXT NOT NULL DEFAULT '2026-03-03'",
    "ALTER TABLE comments ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0"
  ]) {
    try {
      _db.exec(migration);
    } catch {
      // 列已存在，忽略
    }
  }

  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
