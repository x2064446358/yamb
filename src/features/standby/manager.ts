import type { BotBehaviorConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type { Bot } from 'mineflayer'
import { eatGoldenCarrotsUntilFull } from './food'
import { sleep } from '../../platform/sleep'
import { error } from '../../platform/logger'

import type RidingManager from '../riding/manager'

export default class StandbyManager {
  private mcBot: MinecraftBot
  private ridingManager: RidingManager | null = null
  private isLocked: () => boolean = () => false
  private isBusy: () => boolean = () => false
  private idleTimeoutMs: number
  private homeCommand: string
  private afkCommand: string
  private afkDelayMs: number
  private homeWaitMs: number
  private checkIntervalMs: number
  private lastActivity = Date.now()
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private afkTimer: ReturnType<typeof setTimeout> | null = null
  private goingHome = false
  private emergencyEating = false
  private foodListenerBot: Bot | null = null
  private baseMinX = 0
  private baseMaxX = 0
  private baseMinZ = 0
  private baseMaxZ = 0

  constructor (mcBot: MinecraftBot, config: BotBehaviorConfig) {
    this.mcBot = mcBot
    this.idleTimeoutMs = config.idleTimeoutMs
    this.homeCommand = config.homeCommand
    this.afkCommand = config.afkCommand
    this.mcBot.setAfkCommand(this.afkCommand)
    this.afkDelayMs = config.afkDelayMs
    this.homeWaitMs = config.homeWaitMs
    this.checkIntervalMs = config.idleCheckIntervalMs
  }

  setRidingManager (ridingManager: RidingManager): void {
    this.ridingManager = ridingManager
  }

  setLockChecker (fn: () => boolean): void {
    this.isLocked = fn
  }

  /** 酿酒等长任务进行中时跳过回家待命与 AFK */
  setBusyChecker (fn: () => boolean): void {
    this.isBusy = fn
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

  start (): void {
    this.attachEmergencyFoodListener()
    if (this.checkTimer) return
    this.touch()
    this.checkTimer = setInterval(() => {
      void this.checkEmergencyFood()
      void this.checkIdle()
    }, this.checkIntervalMs)
  }

  stop (): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    if (this.afkTimer) {
      clearTimeout(this.afkTimer)
      this.afkTimer = null
    }
    this.foodListenerBot = null
  }

  touch (): void {
    this.lastActivity = Date.now()
    if (this.afkTimer) {
      clearTimeout(this.afkTimer)
      this.afkTimer = null
    }
  }

  scheduleAfk (): void {
    if (this.mcBot.isServerAfk()) return
    if (this.afkTimer) clearTimeout(this.afkTimer)
    this.afkTimer = setTimeout(() => {
      this.afkTimer = null
      if (this.ridingManager?.isActive()) return
      if (this.isBusy()) return
      if (this.mcBot.isServerAfk()) return
      this.mcBot.sendAfk()
    }, this.afkDelayMs)
  }

  private async checkIdle (): Promise<void> {
    if (!this.mcBot.isReady || this.goingHome || this.emergencyEating) return
    if (this.ridingManager?.isActive()) return
    if (this.isLocked()) return
    if (this.isBusy()) return
    if (Date.now() - this.lastActivity < this.idleTimeoutMs) return
    await this.goHomeStandby()
  }

  /**
   * Starvation takes priority over every normal activity. This intentionally
   * does not consult lock, riding, or task state: surviving at zero food is
   * more important than preserving the currently held item.
   */
  private async checkEmergencyFood (): Promise<void> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot || this.emergencyEating) return
    if (this.mcBot.isServerAfk()) return
    if (typeof bot.food !== 'number' || bot.food >= 1) return

    this.emergencyEating = true
    try {
      await eatGoldenCarrotsUntilFull(bot)
    } catch (err) {
      error('[Food] Emergency eating failed:', (err as Error).message)
    } finally {
      this.emergencyEating = false
    }
  }

  private attachEmergencyFoodListener (): void {
    const bot = this.mcBot.bot
    if (!bot || this.foodListenerBot === bot) return
    this.foodListenerBot = bot
    bot.on('health', () => { void this.checkEmergencyFood() })
  }

  async goHomeStandby (): Promise<void> {
    if (!this.mcBot.isReady || !this.mcBot.bot || this.goingHome) return
    if (this.ridingManager?.isActive()) return
    if (this.isBusy()) return

    this.goingHome = true

    try {
      if (this.isAtBase()) {
        // at base, skip home
      } else {
        this.mcBot.chat(this.homeCommand)
        await sleep(this.homeWaitMs)
      }

      if (this.mcBot.bot) {
        await eatGoldenCarrotsUntilFull(this.mcBot.bot)
      }

      this.scheduleAfk()
      this.touch()
    } catch (err) {
      error('[Standby] 回家待命失败:', (err as Error).message)
    } finally {
      this.goingHome = false
    }
  }
}
