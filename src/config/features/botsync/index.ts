import type { DatabaseSync } from 'node:sqlite'
import type MinecraftBot from '../../platform/minecraft-bot'

export interface BotSyncConfig {
  botName: string
  syncTargets: string[]
  enabled: boolean
}

export default class BotSync {
  private mcBot: MinecraftBot
  private config: BotSyncConfig
  private db: DatabaseSync
  private listenersAttached = false
  private onCascadeCancel: (() => void) | null = null
  private onCascadeBusy: ((player: string) => void) | null = null

  constructor(mcBot: MinecraftBot, config: BotSyncConfig, db: DatabaseSync) {
    this.mcBot = mcBot
    this.config = config
    this.db = db
  }

  setCascadeHandlers(onCancel: (player: string) => void, onBusy: (player: string) => void): void {
    this.onCascadeCancelFor = onCancel
    this.onCascadeBusy = onBusy
  }

  private onCascadeCancelFor: ((player: string) => void) | null = null

  start(): void {
    if (this.listenersAttached) return
    if (!this.config.enabled || this.config.syncTargets.length === 0) {
      console.log('[BotSync] No sync targets, disabled')
      return
    }

    this.mcBot.onSpawn((mcBot) => {
      const bot = mcBot.bot
      if (!bot) return

      bot.on('whisper', (username, message) => {
        this.handleSyncWhisper(username, message)
      })

      // Also handle system_chat for 1.19+
      try {
        const client = (bot as unknown as Record<string, unknown>)._client as Record<string, unknown> | undefined
        if (client?.on) {
          (client.on as Function)('system_chat', (packet: Record<string, unknown>) => {
            try {
              const content = (packet.content as Record<string, unknown>)
              const text = typeof content === 'string' ? content : this.extractText(content)
              if (text) this.handleSyncWhisper('', String(text))
            } catch { /* ignore */ }
          })
        }
      } catch { /* ignore */ }
    })

    this.listenersAttached = true
    console.log(`[BotSync] Syncing to: ${this.config.syncTargets.join(', ')}`)
  }

  private extractText(component: unknown): string {
    if (typeof component === 'string') return component
    if (!component || typeof component !== 'object') return ''
    const c = component as Record<string, unknown>
    if (c.text) return String(c.text)
    if (c.extra && Array.isArray(c.extra)) {
      return c.extra.map((e: unknown) => this.extractText(e)).join('')
    }
    return ''
  }

  private handleSyncWhisper(_username: string, message: string): void {
    const text = message.replace(/&#[0-9a-fA-F]{6}/g, '').replace(/§[a-z0-9]/g, '').trim()

    // !wladd <name>
    const wlAdd = text.match(/^!wladd\s+(.+)$/)
    if (wlAdd) {
      const name = wlAdd[1].trim()
      this.db.prepare('INSERT OR IGNORE INTO whitelist (game_name, added_by) VALUES (?, ?)').run(name, 'sync')
      console.log(`[BotSync] Synced whitelist add: ${name}`)
      return
    }

    // !wlremove <name>
    const wlRemove = text.match(/^!wlremove\s+(.+)$/)
    if (wlRemove) {
      const name = wlRemove[1].trim()
      this.db.prepare('DELETE FROM whitelist WHERE game_name = ?').run(name)
      console.log(`[BotSync] Synced whitelist remove: ${name}`)
      return
    }

    // !pwladd <name>
    const pwlAdd = text.match(/^!pwladd\s+(.+)$/)
    if (pwlAdd) {
      const name = pwlAdd[1].trim()
      this.db.prepare('INSERT OR IGNORE INTO phome_whitelist (game_name, level) VALUES (?, ?)').run(name, 'wl')
      console.log(`[BotSync] Synced phome whitelist add: ${name}`)
      return
    }

    // !pwlremove <name>
    const pwlRemove = text.match(/^!pwlremove\s+(.+)$/)
    if (pwlRemove) {
      const name = pwlRemove[1].trim()
      this.db.prepare('DELETE FROM phome_whitelist WHERE game_name = ?').run(name)
      console.log(`[BotSync] Synced phome whitelist remove: ${name}`)
      return
    }

    // %1 <player> — other bot handled TPA, cancel cascade
    const tpaNotify = text.match(/^%1\s+(.+)$/)
    if (tpaNotify) {
      const player = tpaNotify[1].trim()
      console.log(`[BotSync] Other bot locked by: ${player}, cancelling cascade`)
      if (this.onCascadeCancelFor) this.onCascadeCancelFor(player)
      return
    }

    // %busy <player> — other bot is busy, DON'T cancel cascade
    const busyMsg = text.match(/^%busy\s+(.+)$/)
    if (busyMsg) {
      const player = busyMsg[1].trim()
      console.log(`[BotSync] Other bot busy for ${player}, NOT cancelling cascade`)
      if (this.onCascadeBusy) this.onCascadeBusy(player)
      return
    }

    // !bladd <name>
    const blAdd = text.match(/^!bladd\s+(.+)$/)
    if (blAdd) {
      const name = blAdd[1].trim()
      this.db.prepare('INSERT OR IGNORE INTO blacklist (game_name, added_by) VALUES (?, ?)').run(name, 'sync')
      console.log(`[BotSync] Synced blacklist add: ${name}`)
      return
    }

    // !blremove <name>
    const blRemove = text.match(/^!blremove\s+(.+)$/)
    if (blRemove) {
      const name = blRemove[1].trim()
      this.db.prepare('DELETE FROM blacklist WHERE game_name = ?').run(name)
      console.log(`[BotSync] Synced blacklist remove: ${name}`)
      return
    }
  }

  // Send sync to all target bots
  syncWhitelistAdd(name: string): void {
    this.broadcast(`!wladd ${name}`)
  }

  syncWhitelistRemove(name: string): void {
    this.broadcast(`!wlremove ${name}`)
  }

  syncPhomeWlAdd(name: string): void {
    this.broadcast(`!pwladd ${name}`)
  }

  syncPhomeWlRemove(name: string): void {
    this.broadcast(`!pwlremove ${name}`)
  }

  syncTpaHandled(playerName: string): void {
    this.broadcast(`%1 ${playerName}`)
  }

  syncBusy(playerName: string): void {
    this.broadcast(`%busy ${playerName}`)
  }

  broadcast(message: string): void {
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      console.log(`[BotSync] broadcast skipped (ready=${this.mcBot.isReady}, bot=${!!this.mcBot.bot})`)
      return
    }
    for (const target of this.config.syncTargets) {
      try {
        this.mcBot.chat(`/msg ${target} ${message}`)
        console.log(`[BotSync] → ${target}: ${message}`)
      } catch (err) {
        console.warn(`[BotSync] Failed to send to ${target}: ${(err as Error).message}`)
      }
    }
  }
}
