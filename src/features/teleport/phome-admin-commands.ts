import type { DatabaseSync } from 'node:sqlite'
import type TeleportService from './service'
import type CommandMessages from '../commands/messages'
import type { CommandSource } from '../commands/parser'

type Reply = (username: string, message: string, source: CommandSource) => Promise<void>

/** Administrative phome whitelist and waypoint commands. */
export default class PhomeAdminCommands {
  constructor (
    private readonly db: DatabaseSync,
    private readonly teleport: TeleportService,
    private readonly messages: CommandMessages,
    private readonly reply: Reply,
    private readonly isAdmin: (username: string) => boolean,
    private readonly isPhomeSa: (username: string) => boolean
  ) {}

  async whitelistAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) return this.reply(username, this.messages.text('phomeSaOnly'), source)
    if (!target) return this.reply(username, this.messages.text('phomeWlAddUsage'), source)
    const existing = this.db.prepare('SELECT level FROM phome_whitelist WHERE game_name = ?').get(target) as { level: string } | undefined
    if (existing) return this.reply(username, this.messages.text('phomeWlAlready', { target }), source)
    this.db.prepare('INSERT OR REPLACE INTO phome_whitelist (game_name, level) VALUES (?, ?)').run(target, 'wl')
    return this.reply(username, this.messages.text('phomeWlAddSuccess', { target }), source)
  }

  async whitelistRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) return this.reply(username, this.messages.text('phomeSaOnly'), source)
    if (!target) return this.reply(username, this.messages.text('phomeWlRemoveUsage'), source)
    const existing = this.db.prepare('SELECT level FROM phome_whitelist WHERE game_name = ?').get(target) as { level: string } | undefined
    if (existing?.level !== 'wl') return this.reply(username, this.messages.text('phomeWlNotFound', { target }), source)
    this.db.prepare("DELETE FROM phome_whitelist WHERE game_name = ? AND level = 'wl'").run(target)
    return this.reply(username, this.messages.text('phomeWlRemoveSuccess', { target }), source)
  }

  async whitelistList (username: string, source: CommandSource): Promise<void> {
    const rows = this.db.prepare('SELECT game_name FROM phome_whitelist WHERE level = ? ORDER BY game_name').all('wl') as Array<{ game_name: string }>
    return this.reply(username, this.messages.text('phomeWlList', { list: rows.map(row => row.game_name).join(', ') }), source)
  }

  async superAdminAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) return this.reply(username, this.messages.text('noPermission'), source)
    if (!target) return this.reply(username, this.messages.text('phomeSaAddUsage'), source)
    if (this.isPhomeSa(target)) return this.reply(username, this.messages.text('phomeSaAlready', { target }), source)
    this.db.prepare("INSERT INTO phome_whitelist (game_name, level) VALUES (?, 'sa') ON CONFLICT(game_name) DO UPDATE SET level = 'sa'").run(target)
    return this.reply(username, this.messages.text('phomeSaAddSuccess', { target }), source)
  }

  async superAdminRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) return this.reply(username, this.messages.text('noPermission'), source)
    if (!target) return this.reply(username, this.messages.text('phomeSaRemoveUsage'), source)
    if (!this.isPhomeSa(target)) return this.reply(username, this.messages.text('phomeSaNotFound', { target }), source)
    this.db.prepare("UPDATE phome_whitelist SET level = 'wl' WHERE game_name = ? AND level = 'sa'").run(target)
    return this.reply(username, this.messages.text('phomeSaRemoveSuccess', { target }), source)
  }

  async superAdminList (username: string, source: CommandSource): Promise<void> {
    const rows = this.db.prepare("SELECT game_name FROM phome_whitelist WHERE level = 'sa' ORDER BY game_name").all() as Array<{ game_name: string }>
    return this.reply(username, this.messages.text('phomeSaList', { list: rows.map(row => row.game_name).join(', ') }), source)
  }

  async pointAdd (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) return this.reply(username, this.messages.text('phomeSaOnly'), source)
    if (parts.length < 2) return this.reply(username, this.messages.text('phomePointAddUsage'), source)
    const noIdCommands = new Set(['/home', '/ts', '/tsl'])
    const toPosition = (value: string | undefined): number | undefined => {
      const number = value ? parseInt(value, 10) : undefined
      return number !== undefined && number > 0 ? number - 1 : undefined
    }
    const alias = parts[0]
    let id: string | undefined
    let command: string
    let position: number | undefined
    if (parts.length >= 4) {
      id = parts[1]; command = parts[2]; position = toPosition(parts[3])
    } else if (parts.length === 3) {
      if (noIdCommands.has(parts[1])) {
        command = parts[1]; position = toPosition(parts[2])
      } else {
        if (parts[1].startsWith('/')) {
          return this.reply(username, this.messages.text('phomePointAddUsage'), source)
        }
        id = parts[1]; command = parts[2]
      }
    } else {
      command = parts[1]
    }
    // /home, /ts and /tsl target a fixed destination and do not need an id.
    // Every other command needs one; reject it before writing an unusable point.
    if (!noIdCommands.has(command) && (!id || id.startsWith('/'))) {
      return this.reply(username, this.messages.text('phomePointAddUsage'), source)
    }
    const result = this.teleport.addPhomePoint(alias, id, command, position)
    return this.reply(username, result.message!, source)
  }

  async pointRemove (username: string, numberText: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) return this.reply(username, this.messages.text('phomeSaOnly'), source)
    if (!numberText) return this.reply(username, this.messages.text('phomePointRemoveUsage'), source)
    const number = parseInt(numberText, 10)
    if (isNaN(number)) return this.reply(username, this.messages.text('invalidNumber'), source)
    const result = this.teleport.removePhomePoint(number - 1)
    return this.reply(username, result.message!, source)
  }
}
