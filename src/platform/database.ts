import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'

let db: DatabaseSync | null = null

function hasColumn (database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some(row => row.name === column)
}

/** 给已存在的旧表补列（CREATE TABLE IF NOT EXISTS 不会改动已有表） */
function ensureColumn (database: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    console.log(`[DB] Migrated: ${table}.${column} added`)
  }
}

export function initDatabase (dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  db = new DatabaseSync(dbPath)
  // 多 bot 共享同一个 db 文件：WAL + busy_timeout 保证并发读写不互相阻塞
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  } catch { /* 旧版/只读场景忽略 */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      game_name TEXT PRIMARY KEY,
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      game_name TEXT PRIMARY KEY,
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phome_whitelist (
      game_name TEXT PRIMARY KEY,
      added_by  TEXT NOT NULL DEFAULT 'system',
      level     TEXT NOT NULL DEFAULT 'wl',
      added_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brew_whitelist (
      game_name TEXT PRIMARY KEY,
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS containers (
      alias       TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      x           INTEGER NOT NULL,
      y           INTEGER NOT NULL,
      z           INTEGER NOT NULL,
      dimension   TEXT NOT NULL DEFAULT 'overworld',
      added_by    TEXT NOT NULL,
      added_at    TEXT NOT NULL,
      block_type  TEXT,
      is_dedicated INTEGER,
      item_id     TEXT,
      node_group  TEXT
    );

    CREATE TABLE IF NOT EXISTS brew_tasks (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      recipe_id   TEXT NOT NULL,
      owner       TEXT NOT NULL,
      barrel_alias TEXT,
      barrel_x    INTEGER,
      barrel_y    INTEGER,
      barrel_z    INTEGER,
      barrel_dim  TEXT,
      finish_at   INTEGER NOT NULL,
      phase       TEXT,
      reminded_10 INTEGER NOT NULL DEFAULT 0,
      reminded_5  INTEGER NOT NULL DEFAULT 0,
      pending_away INTEGER NOT NULL DEFAULT 0,
      -- 任务归属 bot（BOT_INDEX）：共享库多 bot 时只有归属 bot 恢复/提醒/收取；
      -- 旧数据为 NULL，恢复时由首个 bot 原子认领
      bot_index   INTEGER
    );

    /*
    -- 待开始的酿酒队列。发酵已真正开始后转交给 brew_tasks 持久化恢复。
    */
    CREATE TABLE IF NOT EXISTS brew_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id   TEXT NOT NULL,
      owner       TEXT NOT NULL,
      bot_index   INTEGER NOT NULL,
      queued_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_brew_queue_bot_order
      ON brew_queue (bot_index, id);

    -- 公屏 %挂机 多 bot 原子认领：player+kind 主键，INSERT OR IGNORE 只有一方成功
    -- kind='claim' 表示某 bot 认领并正在执行 /tpa；kind='busy' 表示全部繁忙提示（去重）
    -- resolved=1 表示认领已结束（成功/被拒）但在宽限期内，用于让繁忙 bot 的仲裁看到"已有人处理过"
    CREATE TABLE IF NOT EXISTS tpa_claims (
      player     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      bot_index  INTEGER NOT NULL,
      note       TEXT,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player, kind)
    );

    CREATE TABLE IF NOT EXISTS lock_state (
      bot_name TEXT PRIMARY KEY,
      locked_by TEXT,
      locked_note TEXT,
      locked_ticks INTEGER,
      hover_locked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS riding_state (
      bot_name TEXT PRIMARY KEY,
      mode TEXT,
      target_player TEXT
    );

    -- 同小镇 bot 代执行 /phome：player+index 主键原子认领，只有一方能成功
    -- resolved=1 表示该认领已结束（成功/被拒/超时）但在宽限期内，供 owner 兜底仲裁看到"已有人处理过"
    -- 注意："index" 是 SQLite 关键字，必须加引号，否则整段 exec 在启动时抛错导致 app 无法启动
    CREATE TABLE IF NOT EXISTS phome_claims (
      player     TEXT NOT NULL,
      "index"    INTEGER NOT NULL,
      bot_index  INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player, "index")
    );

    -- 心跳：每个 bot 已连接时周期写入，同镇 bot 据此判断 owner 是否离线（崩了/掉线）并代执行
    CREATE TABLE IF NOT EXISTS bot_heartbeat (
      bot_name  TEXT PRIMARY KEY,
      last_seen INTEGER NOT NULL
    );
  `)

  ensureColumn(db, 'containers', 'block_type', 'block_type TEXT')
  ensureColumn(db, 'containers', 'is_dedicated', 'is_dedicated INTEGER')
  ensureColumn(db, 'containers', 'item_id', 'item_id TEXT')
  ensureColumn(db, 'containers', 'node_group', 'node_group TEXT')
  ensureColumn(db, 'tpa_claims', 'resolved', 'resolved INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'brew_tasks', 'bot_index', 'bot_index INTEGER')

  console.log(`[DB] SQLite ready: ${dbPath}`)
  return db
}

export function getDatabase (): DatabaseSync {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDatabase (): void {
  if (db) {
    db.close()
    db = null
  }
}

/** 从旧版 whitelist.json 迁移数据（仅当表为空时） */
export function migrateFromJson (jsonPath: string): void {
  const database = getDatabase()
  const count = database.prepare('SELECT COUNT(*) AS c FROM whitelist').get() as { c: number }
  if (count.c > 0) return

  if (!fs.existsSync(jsonPath)) return

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, { addedBy?: string; addedAt?: string }>
    const insert = database.prepare(
      'INSERT OR IGNORE INTO whitelist (game_name, added_by, added_at) VALUES (?, ?, ?)'
    )

    database.exec('BEGIN')
    try {
      let migrated = 0
      for (const [name, info] of Object.entries(data)) {
        insert.run(name, info.addedBy || 'migration', info.addedAt || new Date().toISOString())
        migrated++
      }
      database.exec('COMMIT')
      if (migrated > 0) {
        console.log(`[DB] Migrated ${migrated} entries from ${jsonPath}`)
      }
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    console.warn('[DB] JSON migration skipped:', (err as Error).message)
  }
}

export type { DatabaseSync }
