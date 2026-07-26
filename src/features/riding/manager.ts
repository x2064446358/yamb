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
  private isLocked: () => boolean = () => false
  private baseMinX = 0
  private baseMaxX = 0
  private baseMinZ = 0
  private baseMaxZ = 0

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

  setLockChecker (fn: () => boolean): void {
    this.isLocked = fn
  }

  setBaseArea (minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.baseMinX = minX
    this.baseMaxX = maxX
    this.baseMinZ = minZ
    this.baseMaxZ = maxZ
  }

  private isAtBase (): boolean {
    const bot = this.mcBot.bot
    if (!bot) return false
    if (!this.baseMinX && !this.baseMaxX && !this.baseMinZ && !this.baseMaxZ) return false
    const { x, z } = bot.entity.position
    return x >= this.baseMinX && x <= this.baseMaxX && z >= this.baseMinZ && z <= this.baseMaxZ
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

    console.log(`[Riding] 已脱离 ${targetName}，尝试重新骑乘（最多 4 次）`)
    this.dismountRequested = true

    for (let attempt = 1; attempt <= 4; attempt++) {
      if (this.mode !== 'player' || this.targetPlayer !== targetName) {
        console.log('[Riding] 用户已取消骑乘，停止重试')
        return
      }
      this.notMountedStreak = 0

      // Skip remount if already on target
      let mounted = isMountedOnPlayer(bot, targetName)
      if (!mounted) {
        mounted = await this.playerInteraction.remountPlayer(targetName)
        if (mounted) {
          console.log(`[Riding] 重新骑乘 ${targetName} 成功 (第 ${attempt} 次)`)
        }
      } else {
        console.log(`[Riding] 已在 ${targetName} 上，无需重骑`)
      }

      if (mounted) {
        // 稳定期：保持 dismountRequested 防止秒掉后立即回基地
        await sleep(3000)
        if (isMountedOnPlayer(bot, targetName)) {
          this.dismountRequested = false
          this.mcBot.chat('/afk')
          return
        }
        console.log(`[Riding] 稳定期间脱落，继续重试`)
      } else {
        console.log(`[Riding] 重新骑乘失败 (${attempt}/4)`)
      }

      if (attempt < 4) await sleep(1500)
    }

    console.log(`[Riding] 4 次重骑均失败`)
    try { this.mcBot.chat(`/msg ${targetName} 重新骑乘失败，请重新发送 坐 指令`) } catch { /* */ }
    if (!this.isLocked() && !this.isAtBase()) {
      console.log(`[Riding] 执行 ${this.homeCommand}`)
      this.mcBot.chat(this.homeCommand)
    }
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
    this.dismountRequested = true  // 阻止后台监控触发回基地
    await sleep(2000)

    if (this.mode === 'player' && this.targetPlayer) {
      console.log(`[Riding] 尝试重连骑乘 ${this.targetPlayer}...`)
      for (let attempt = 1; attempt <= 4; attempt++) {
        this.notMountedStreak = 0
        const remounted = await this.playerInteraction.remountPlayer(this.targetPlayer)
        if (remounted) {
          console.log(`[Riding] 重连骑乘 ${this.targetPlayer} 成功 (第 ${attempt} 次)`)
          this.dismountRequested = false
          this.mcBot.chat('/afk')
          return
        }
        console.log(`[Riding] 重连骑乘失败 (${attempt}/4)`)
        if (attempt < 4) await sleep(1500)
      }
      console.log(`[Riding] 4 次重连骑乘均失败，清除状态`)
      try { this.mcBot.chat(`/msg ${this.targetPlayer} 重新骑乘失败，请重新发送 坐 指令`) } catch { /* */ }
      this.clearMode()
    } else if (this.mode === 'minecart') {
      console.log('[Riding] 矿车模式需手动上车恢复')
      this.clearMode()
    }
    this.dismountRequested = false
  }
}
