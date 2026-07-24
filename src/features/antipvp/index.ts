import type MinecraftBot from '../../platform/minecraft-bot'

export default class AntiPVP {
  private mcBot: MinecraftBot
  private lastHealth = 20
  private damageCooldown = 0
  private listenersAttached = false

  constructor(mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  start(): void {
    if (this.listenersAttached) return
    this.mcBot.onSpawn((mcBot) => {
      const bot = mcBot.bot
      if (!bot) return

      bot.on('health', () => {
        this.checkDamage()
      })

      bot.on('entityHurt', (entity) => {
        if (entity === bot.entity && this.damageCooldown <= 0) {
          console.log('[AntiPVP] Bot was attacked, sending /afk')
          bot.chat('/afk')
          this.damageCooldown = 600 // 30 seconds cooldown
        }
      })
    })

    // Tick timer for cooldown
    setInterval(() => {
      if (this.damageCooldown > 0) this.damageCooldown--
    }, 50)

    this.listenersAttached = true
    console.log('[AntiPVP] Started')
  }

  private checkDamage(): void {
    const bot = this.mcBot.bot
    if (!bot) return
    if (bot.health < this.lastHealth && this.damageCooldown <= 0) {
      console.log(`[AntiPVP] Damage detected (${this.lastHealth} -> ${bot.health}), sending /afk`)
      bot.chat('/afk')
      this.damageCooldown = 600
    }
    this.lastHealth = bot.health
  }

  stop(): void {
    this.listenersAttached = false
    console.log('[AntiPVP] Stopped')
  }
}
