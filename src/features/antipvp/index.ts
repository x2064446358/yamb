import type MinecraftBot from '../../platform/minecraft-bot'
import type { Bot } from 'mineflayer'

export default class AntiPVP {
  private mcBot: MinecraftBot
  private lastHealth = 20
  private damageCooldown = 0
  private running = false
  private spawnHookRegistered = false
  private listenerBot: Bot | null = null
  private cooldownTimer: ReturnType<typeof setInterval> | null = null
  private isSuppressed: () => boolean = () => false

  constructor(mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  setSuppressedChecker (checker: () => boolean): void {
    this.isSuppressed = checker
  }

  start(): void {
    if (this.running) return
    this.running = true
    if (!this.spawnHookRegistered) {
      this.spawnHookRegistered = true
      this.mcBot.onSpawn((mcBot) => this.attachToBot(mcBot.bot))
    }
    this.attachToBot(this.mcBot.bot)
    if (!this.cooldownTimer) {
      this.cooldownTimer = setInterval(() => {
        if (this.damageCooldown > 0) this.damageCooldown--
      }, 50)
    }
    console.log('[AntiPVP] Started')
  }

  private attachToBot (bot: Bot | null): void {
    if (!this.running || !bot || this.listenerBot === bot) return
    this.listenerBot = bot
    bot.on('health', () => {
      this.checkDamage()
    })
    bot.on('entityHurt', (entity) => {
      if (this.isSuppressed()) return
      if (entity === bot.entity && this.damageCooldown <= 0) {
        console.log('[AntiPVP] Bot was attacked, sending /afk')
        this.mcBot.sendAfk()
        this.damageCooldown = 600 // 30 seconds cooldown
      }
    })
  }

  private checkDamage(): void {
    const bot = this.mcBot.bot
    if (!bot) return
    if (this.isSuppressed()) {
      this.lastHealth = bot.health
      return
    }
    if (bot.health < this.lastHealth && this.damageCooldown <= 0) {
      console.log(`[AntiPVP] Damage detected (${this.lastHealth} -> ${bot.health}), sending /afk`)
      this.mcBot.sendAfk()
      this.damageCooldown = 600
    }
    this.lastHealth = bot.health
  }

  stop(): void {
    this.running = false
    this.listenerBot = null
    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer)
      this.cooldownTimer = null
    }
    console.log('[AntiPVP] Stopped')
  }
}
