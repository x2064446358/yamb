import type { Bot } from 'mineflayer'
import type { DatabaseSync } from 'node:sqlite'
import type { BotBehaviorConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type PlayerInteractionService from '../../actions/player'
import {
  clearVehicleState,
  isMountedOnMinecart,
  isMountedOnPlayer,
  performDismount
} from '../../actions/shared/entity-utils'
import { sleep } from '../../platform/sleep'

export type RidingMode = 'idle' | 'player' | 'minecart'

type Entity = NonNullable<Bot['entities'][string]>

export default class RidingManager {
  private mcBot: MinecraftBot
  private playerInteraction: PlayerInteractionService
  private homeCommand: string
  private checkIntervalMs: number
  private mode: RidingMode = 'idle'
  private targetPlayer: string | null = null
  private dismountRequested = false
  private handlingDismount = false
  private notMountedStreak = 0
  private monitorTimer: ReturnType<typeof setInterval> | null = null
  private listenersAttached = false
  private db: DatabaseSync | null = null
  private botName = ''

  constructor (
    mcBot: MinecraftBot,
    playerInteraction: PlayerInteractionService,
    botConfig: BotBehaviorConfig
  ) {
    this.mcBot = mcBot
    this.playerInteraction = playerInteraction
    this.homeCommand = botConfig.homeCommand
    this.checkIntervalMs = botConfig.ridingCheckIntervalMs ?? 1500
  }

  setDb (db: DatabaseSync, botName: string): void {
    this.db = db
    this.botName = botName
    this.restoreRidingState()
  }

  getMode (): RidingMode {
    return this.mode
  }

  isActive (): boolean {
    return this.mode !== 'idle'
  }

  getTargetPlayer (): string | null {
    return this.targetPlayer
  }

  enterPlayerMode (playerName: string): void {
    this.mode = 'player'
    this.targetPlayer = playerName
    this.dismountRequested = false
    this.notMountedStreak = 0
    this.saveRidingState()
    console.log(`[Riding] 进入骑乘模式 -> ${playerName}`)
  }

  enterMinecartMode (): void {
    this.mode = 'minecart'
    this.targetPlayer = null
    this.dismountRequested = false
    this.notMountedStreak = 0
    this.saveRidingState()
    console.log('[Riding] 进入矿车模式')
  }

  clearMode (): void {
    if (this.mode === 'idle') return
    console.log(`[Riding] 退出 ${this.mode} 模式`)
    this.mode = 'idle'
    this.targetPlayer = null
    this.dismountRequested = false
    this.handlingDismount = false
    this.notMountedStreak = 0
    this.saveRidingState()
    const bot = this.mcBot.bot
    if (bot) clearVehicleState(bot)
  }

  async dismount (): Promise<{ success: boolean; message: string }> {
    const bot = this.mcBot.bot
    if (!bot || this.mode === 'idle') {
      return { success: false, message: '当前未处于骑乘状态' }
    }

    this.dismountRequested = true
    const ok = await performDismount(bot)
    this.clearMode()

    if (ok || !this.isPhysicallyMounted(bot)) {
      return { success: true, message: '已下马' }
    }
    return { success: false, message: '下马失败，请重试' }
  }

  start (): void {
    const bot = this.mcBot.bot
    if (!bot || this.listenersAttached) return
    this.listenersAttached = true

    bot.on('dismount', () => {
      void this.onDismountEvent()
    })

    bot.on('mount', () => {
      this.dismountRequested = false
      this.notMountedStreak = 0
    })

    bot.on('entityAttach', (entity: Entity, vehicle: Entity) => {
      if (entity !== bot.entity) return
      this.dismountRequested = false
      this.notMountedStreak = 0
      console.log(`[Riding] entityAttach -> ${vehicle.name || vehicle.username || vehicle.id}`)
    })

    bot.on('entityDetach', (entity: Entity) => {
      if (entity !== bot.entity || this.dismountRequested || this.mode === 'idle') return
      void this.handleInvoluntaryDismount()
    })

    this.monitorTimer = setInterval(() => {
      void this.checkMountedState()
    }, this.checkIntervalMs)
  }

  stop (): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    this.listenersAttached = false
    this.clearMode()
  }

  private isPhysicallyMounted (bot: Bot): boolean {
    if (this.mode === 'player' && this.targetPlayer) {
      return isMountedOnPlayer(bot, this.targetPlayer)
    }
    if (this.mode === 'minecart') {
      return isMountedOnMinecart(bot)
    }
    return false
  }

  private async onDismountEvent (): Promise<void> {
    if (this.dismountRequested || this.mode === 'idle') {
      this.dismountRequested = false
      return
    }
    await sleep(200)
    await this.handleInvoluntaryDismount()
  }

  private async checkMountedState (): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot || this.mode === 'idle' || this.handlingDismount) return
    if (this.dismountRequested) return

    if (this.isPhysicallyMounted(bot)) {
      this.notMountedStreak = 0
      return
    }

    this.notMountedStreak++
    if (this.notMountedStreak < 2) return

    this.notMountedStreak = 0
    clearVehicleState(bot)
    await this.handleInvoluntaryDismount()
  }

  private async handleInvoluntaryDismount (): Promise<void> {
    if (this.handlingDismount || this.mode === 'idle') return
    this.handlingDismount = true

    try {
      if (this.mode === 'player' && this.targetPlayer) {
        await this.handlePlayerRemount(this.targetPlayer)
        return
      }

      if (this.mode === 'minecart') {
        this.clearMode()
      }
    } finally {
      this.handlingDismount = false
    }
  }

  private async handlePlayerRemount (targetName: string): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) {
      this.clearMode()
      return
    }

    if (isMountedOnPlayer(bot, targetName)) {
      this.notMountedStreak = 0
      return
    }

    console.log(`[Riding] 已脱离 ${targetName}，尝试重新骑乘`)

    if (!this.playerInteraction.isPlayerInRange(targetName)) {
      console.log(`[Riding] ${targetName} 超出寻路范围，执行 ${this.homeCommand}`)
      this.mcBot.chat(this.homeCommand)
      this.clearMode()
      return
    }

    const remounted = await this.playerInteraction.remountPlayer(targetName)
    if (remounted) {
      console.log(`[Riding] 重新骑乘 ${targetName} 成功`)
      this.notMountedStreak = 0
      return
    }

    console.log(`[Riding] 重新骑乘失败，执行 ${this.homeCommand}`)
    this.mcBot.chat(this.homeCommand)
    this.clearMode()
  }

  private saveRidingState (): void {
    if (!this.db) return
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS riding_state (bot_name TEXT PRIMARY KEY, mode TEXT, target_player TEXT)")
      if (this.mode !== 'idle') {
        this.db.prepare('INSERT OR REPLACE INTO riding_state (bot_name, mode, target_player) VALUES (?, ?, ?)').run(this.botName, this.mode, this.targetPlayer || null)
      } else {
        this.db.prepare('DELETE FROM riding_state WHERE bot_name = ?').run(this.botName)
      }
    } catch { /* */ }
  }

  private restoreRidingState (): void {
    if (!this.db) return
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS riding_state (bot_name TEXT PRIMARY KEY, mode TEXT, target_player TEXT)")
      const row = this.db.prepare('SELECT mode, target_player FROM riding_state WHERE bot_name = ?').get(this.botName) as { mode: string; target_player: string | null } | undefined
      if (!row) return

      if (row.mode === 'player' && row.target_player) {
        this.mode = 'player'
        this.targetPlayer = row.target_player
        this.dismountRequested = false
        this.notMountedStreak = 0
        console.log(`[Riding] 恢复骑乘状态 -> ${row.target_player}`)
      } else if (row.mode === 'minecart') {
        this.mode = 'minecart'
        this.targetPlayer = null
        this.dismountRequested = false
        this.notMountedStreak = 0
        console.log('[Riding] 恢复矿车模式')
      }
    } catch { /* */ }
  }

  async tryRestoreMount (): Promise<void> {
    if (this.mode === 'idle') return
    await sleep(2000)

    if (this.mode === 'player' && this.targetPlayer) {
      console.log(`[Riding] 尝试重连骑乘 ${this.targetPlayer}...`)
      const remounted = await this.playerInteraction.remountPlayer(this.targetPlayer)
      if (remounted) {
        console.log(`[Riding] 重连骑乘 ${this.targetPlayer} 成功`)
        return
      }
      console.log(`[Riding] 重连骑乘失败，清除状态`)
      this.clearMode()
    } else if (this.mode === 'minecart') {
      // Minecart restore is handled by re-entering via cart command
      console.log('[Riding] 矿车模式需手动上车恢复')
      this.clearMode()
    }
  }
}
