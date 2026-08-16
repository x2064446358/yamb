import type MinecraftBot from '../../platform/minecraft-bot'
import { debug } from '../../platform/logger'

export default class JumpModule {
  private mcBot: MinecraftBot
  private active = false
  private infinite = false
  private count = 0
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private releaseHandle: ReturnType<typeof setTimeout> | null = null
  private nextJumpAt = 0
  private onDone: (() => void) | null = null

  private static readonly CHECK_INTERVAL_MS = 50
  private static readonly JUMP_PRESS_MS = 150
  private static readonly MIN_JUMP_GAP_MS = 250

  constructor(mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  setOnDone(cb: () => void): void {
    this.onDone = cb
  }

  isActive(): boolean {
    return this.active
  }

  stop(): string {
    if (!this.active) return '当前未在跳跃。'
    this.clear()
    return '已停止跳跃。'
  }

  startSingle(): string {
    this.doJump()
    return '已跳跃。'
  }

  startCount(count: number): string {
    if (this.active) return '正在跳跃中，请等待完成。'
    if (count > 1000) count = 1000
    this.active = true
    this.infinite = false
    this.count = count
    this.startLoop()
    return `开始跳跃 ${count} 次。`
  }

  startInfinite(): string {
    if (this.active) return '正在跳跃中，请等待完成。'
    this.active = true
    this.infinite = true
    this.startLoop()
    return '开始无限跳跃。'
  }

  interrupt(reason: string): void {
    if (this.active) {
      debug(`[Jump] Interrupted: ${reason}`)
      this.clear()
    }
  }

  private startLoop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    this.nextJumpAt = 0
    this.intervalHandle = setInterval(() => {
      const bot = this.mcBot.bot
      if (!bot || !this.mcBot.isReady || !bot.entity.onGround || Date.now() < this.nextJumpAt) return
      if (!this.doJump()) return
      this.nextJumpAt = Date.now() + JumpModule.MIN_JUMP_GAP_MS
      if (!this.infinite) {
        this.count--
        if (this.count <= 0) {
          const cb = this.onDone
          this.clear()
          cb?.()
        }
      }
    }, JumpModule.CHECK_INTERVAL_MS)
  }

  private clear(): void {
    this.active = false
    this.infinite = false
    this.count = 0
    this.nextJumpAt = 0
    this.onDone = null
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.releaseHandle) {
      clearTimeout(this.releaseHandle)
      this.releaseHandle = null
    }
    try { this.mcBot.bot?.setControlState('jump', false) } catch { /* */ }
  }

  private doJump(): boolean {
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) return false
    try {
      // Keep the key pressed for three client ticks so the physics loop reliably
      // observes it, then release it before landing to avoid unnatural hopping.
      this.mcBot.requestHighView()
      bot.setControlState('jump', true)
      if (this.releaseHandle) clearTimeout(this.releaseHandle)
      this.releaseHandle = setTimeout(() => {
        try { bot.setControlState('jump', false) } catch { /* */ }
        this.releaseHandle = null
      }, JumpModule.JUMP_PRESS_MS)
      return true
    } catch {
      return false
    }
  }
}
