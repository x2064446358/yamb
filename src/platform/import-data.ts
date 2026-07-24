import fs from 'fs'
import path from 'path'
import type { DatabaseSync } from 'node:sqlite'

export function importWllbotData(db: DatabaseSync, dataFilePath: string): void {
  if (!fs.existsSync(dataFilePath)) {
    console.log('[Import] wllbot_data.txt not found, skipping')
    return
  }

  console.log('[Import] Reading wllbot_data.txt...')
  const lines = fs.readFileSync(dataFilePath, 'utf-8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)

  // Ensure tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      game_name TEXT PRIMARY KEY,
      added_by TEXT DEFAULT 'import',
      added_at TEXT DEFAULT (datetime('now'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blacklist (
      game_name TEXT PRIMARY KEY,
      added_by TEXT DEFAULT 'import',
      added_at TEXT DEFAULT (datetime('now'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS phome_whitelist (
      game_name TEXT PRIMARY KEY,
      added_by TEXT DEFAULT 'import',
      level TEXT DEFAULT 'wl',
      added_at TEXT DEFAULT (datetime('now'))
    )
  `)

  const insertWl = db.prepare('INSERT OR IGNORE INTO whitelist (game_name, added_by) VALUES (?, ?)')
  const insertBl = db.prepare('INSERT OR IGNORE INTO blacklist (game_name, added_by) VALUES (?, ?)')
  const insertPwl = db.prepare('INSERT OR IGNORE INTO phome_whitelist (game_name, level) VALUES (?, ?)')

  let wlCount = 0, blCount = 0, pwlCount = 0

  for (const line of lines) {
    if (line.startsWith('WL:')) {
      insertWl.run(line.substring(3).trim(), 'import')
      wlCount++
    } else if (line.startsWith('ADMIN:')) {
      insertWl.run(line.substring(6).trim(), 'import') // admins are also in whitelist
    } else if (line.startsWith('SA:')) {
      insertWl.run(line.substring(3).trim(), 'import')
    } else if (line.startsWith('PWL:')) {
      insertPwl.run(line.substring(4).trim(), 'wl')
      pwlCount++
    } else if (line.startsWith('PSA:')) {
      insertPwl.run(line.substring(4).trim(), 'sa')
      pwlCount++
    } else if (line.startsWith('BL:')) {
      insertBl.run(line.substring(3).trim(), 'import')
      blCount++
    }
  }

  console.log(`[Import] Whitelist: ${wlCount}, Blacklist: ${blCount}, PhomeWL: ${pwlCount}`)
}
