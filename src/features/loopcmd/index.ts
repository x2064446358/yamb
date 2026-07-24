import type MinecraftBot from '../../platform/minecraft-bot'

export interface LoopCmdConfig {
  enabled: boolean
  text: string
  intervalSec: number
}

export default class LoopCmd {
  private mcBot: MinecraftBot
  private config: LoopCmdConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private active = false

  constructor(mcBot: MinecraftBot, config: LoopCmdConfig) {
    this.mcBot = mcBot
    this.config = config
  }

  start(): void {
    if (!this.config.enabled || !this.config.text) return
    if (this.timer) return
    const ms = this.config.intervalSec * 1000
    this.timer = setInterval(() => {
      if (this.mcBot.isReady && this.mcBot.bot) {
        this.mcBot.chat(this.config.text)
      }
    }, ms)
    this.active = true
    console.log(`[LoopCmd] "${this.config.text}" every ${this.config.intervalSec}s`)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.active = false
    console.log('[LoopCmd] Stopped')
  }

  update(text: string, intervalSec: number): void {
    this.config.text = text
    this.config.intervalSec = intervalSec
    this.config.enabled = text.length > 0
    this.stop()
    if (this.config.enabled) this.start()
  }

  isActive(): boolean { return this.active }
  getConfig(): LoopCmdConfig { return { ...this.config } }
}
