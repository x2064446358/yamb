import type MinecraftBot from '../../platform/minecraft-bot'

export default class JumpModule {
  private mcBot: MinecraftBot
  private active = false
  private infinite = false
  private count = 0
  private interval = 6
  private timer = 0
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private onDone: (() => void) | null = null

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
    this.interval = 6
    this.timer = 0
    this.startLoop()
    return `开始跳跃 ${count} 次。`
  }

  startInfinite(): string {
    if (this.active) return '正在跳跃中，请等待完成。'
    this.active = true
    this.infinite = true
    this.interval = 6
    this.timer = 0
    this.startLoop()
    return '开始无限跳跃。'
  }

  interrupt(reason: string): void {
    if (this.active) {
      console.log(`[Jump] Interrupted: ${reason}`)
      this.clear()
    }
  }

  private startLoop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    const ms = Math.round((this.interval / 20) * 1000)
    this.intervalHandle = setInterval(() => {
      this.timer++
      if (this.timer >= this.interval) {
        this.timer = 0
        this.doJump()
        if (!this.infinite) {
          this.count--
          if (this.count <= 0) {
            const cb = this.onDone
            this.clear()
            cb?.()
          }
        }
      }
    }, ms)
  }

  private clear(): void {
    this.active = false
    this.infinite = false
    this.count = 0
    this.timer = 0
    this.onDone = null
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  private doJump(): void {
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) return
    try {
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch { /* */ } }, 50)
    } catch { /* */ }
  }
}
