import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type MinecraftBot from '../../platform/minecraft-bot'

export default class UseItemModule {
  private mcBot: MinecraftBot
  private active = false
  private infinite = false
  private count = 0
  private interval = 4
  private timer = 0
  private isPlace = false
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private lookTarget: Vec3 | null = null

  constructor(mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  isActive(): boolean { return this.active }

  look(x: number, y: number, z: number): string {
    this.lookTarget = new Vec3(x, y, z)
    const bot = this.mcBot.bot
    if (bot) {
      try { bot.lookAt(this.lookTarget, true) } catch { /* */ }
    }
    return `已看向 ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`
  }

  stop(): string {
    if (!this.active) return '当前未在使用。'
    this.clear()
    return '已停止使用。'
  }

  startUse(countStr: string): string {
    this.isPlace = false
    return this.start(countStr)
  }

  startPlace(countStr: string): string {
    if (!this.lookTarget) return '请先用 look 看向目标坐标。'
    const bot = this.mcBot.bot
    if (bot && !bot.heldItem) return '请先用 hold 手持方块。'
    this.isPlace = true
    return this.start(countStr)
  }

  private start(countStr: string): string {
    const parsed = this.parseCountAndInterval(countStr)
    if (!parsed) return '格式: <次数/无限次/停止> [间隔Xs]'

    if (parsed.countStr === '停止' || parsed.countStr === 'stop') return this.stop()
    if (this.active) return '正在使用中，请等待完成。'

    this.interval = parsed.interval
    this.timer = 0

    if (parsed.countStr === '无限次' || parsed.countStr === '无限' || parsed.countStr === 'infinite') {
      this.active = true
      this.infinite = true
      this.startLoop()
      return `开始无限${this.isPlace ? '放置' : '使用'} 间隔${(this.interval / 20).toFixed(1)}s`
    }

    const count = parseInt(parsed.countStr, 10)
    if (isNaN(count) || count <= 0) return '格式: <次数/无限次/停止> [间隔Xs]'

    this.active = true
    this.infinite = false
    this.count = Math.min(count, 1000)
    this.startLoop()
    return `开始${this.isPlace ? '放置' : '使用'} ${this.count} 次 间隔${(this.interval / 20).toFixed(1)}s`
  }

  interrupt(reason: string): void {
    if (this.active) {
      console.log(`[UseItem] Interrupted: ${reason}`)
      this.clear()
    }
  }

  private parseCountAndInterval(input: string): { countStr: string; interval: number } | null {
    let str = input.trim()
    let interval = 4

    const intervalMatch = str.match(/间隔\s*([\d.]+)s/i)
    if (intervalMatch) {
      const sec = parseFloat(intervalMatch[1])
      interval = Math.round(sec * 20)
      str = str.replace(intervalMatch[0], '').trim()
    }

    if (!str) return null
    return { countStr: str, interval }
  }

  private startLoop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    const ms = Math.round((this.interval / 20) * 1000)
    this.intervalHandle = setInterval(() => {
      this.timer++
      if (this.timer >= this.interval) {
        this.timer = 0
        this.doAction()
        if (!this.infinite) {
          this.count--
          if (this.count <= 0) this.clear()
        }
      }
    }, ms)
  }

  private clear(): void {
    this.active = false
    this.infinite = false
    this.isPlace = false
    this.count = 0
    this.timer = 0
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null }
  }

  private async doAction(): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) return
    try {
      if (this.isPlace && this.lookTarget) {
        const t = this.lookTarget.floored()
        // Try all 6 faces to find a reference block
        const faces: Array<[Vec3, Vec3]> = [
          [new Vec3(0, -1, 0), new Vec3(0, 1, 0)],   // below → place on top
          [new Vec3(0, 1, 0), new Vec3(0, -1, 0)],    // above → place on bottom
          [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)],    // east → place west
          [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)],    // west → place east
          [new Vec3(0, 0, 1), new Vec3(0, 0, -1)],    // south → place north
          [new Vec3(0, 0, -1), new Vec3(0, 0, 1)]     // north → place south
        ]
        for (const [refOff, placeFace] of faces) {
          const ref = bot.blockAt(t.plus(refOff))
          if (!ref || ref.name === 'air' || ref.name === 'void_air' || ref.name === 'cave_air') continue
          const refPos = new Vec3(ref.position.x, ref.position.y, ref.position.z)
          const dist = bot.entity.position.distanceTo(refPos)
          if (dist > 5) continue
          try {
            await bot.lookAt(refPos.offset(0.5, 0.5, 0.5), true)
            await bot.placeBlock(ref, placeFace)
            console.log(`[UseItem] Placed at ${t.x} ${t.y} ${t.z} (face ${placeFace})`)
            return
          } catch { continue }
        }
        console.warn(`[UseItem] No valid reference block near ${t.x} ${t.y} ${t.z}`)
      } else {
        bot.activateItem()
      }
    } catch { /* */ }
  }
}
