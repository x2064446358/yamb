import type { BotBehaviorConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
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
  private baseMinX = 0
  private baseMaxX = 0
  private baseMinZ = 0
  private baseMaxZ = 0

  constructor (mcBot: MinecraftBot, config: BotBehaviorConfig) {
    this.mcBot = mcBot
    this.idleTimeoutMs = config.idleTimeoutMs
    this.homeCommand = config.homeCommand
    this.afkCommand = config.afkCommand
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
    if (this.checkTimer) return
    this.touch()
    this.checkTimer = setInterval(() => {
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
  }

  touch (): void {
    this.lastActivity = Date.now()
  }

  scheduleAfk (): void {
    if (this.afkTimer) clearTimeout(this.afkTimer)
    this.afkTimer = setTimeout(() => {
      if (this.ridingManager?.isActive()) return
      if (this.isBusy()) return
      this.mcBot.chat(this.afkCommand)
    }, this.afkDelayMs)
  }

  private async checkIdle (): Promise<void> {
    if (!this.mcBot.isReady || this.goingHome) return
    if (this.ridingManager?.isActive()) return
    if (this.isLocked()) return
    if (this.isBusy()) return
    if (Date.now() - this.lastActivity < this.idleTimeoutMs) return
    await this.goHomeStandby()
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
