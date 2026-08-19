import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type MinecraftBot from '../../platform/minecraft-bot'
import type PlaceModule from '../place'
import { getPlayerEntity, eyeHeightOf, lookAnglesSmart, lookAtSmart } from '../../actions/shared/entity-utils'

/** 独立管理 bot 朝向，并把最近一次看向的方块交给放置功能。 */
export default class LookModule {
  constructor (
    private readonly mcBot: MinecraftBot,
    private readonly placeModule: PlaceModule
  ) {}

  look (yawDeg: number, pitchDeg: number): string {
    const bot = this.mcBot.bot
    if (bot) this.sendLook(bot, yawDeg, pitchDeg)
    return `已看向 横${yawDeg}° 纵${pitchDeg}°`
  }

  lookPlayer (playerName: string): string | null {
    const bot = this.mcBot.bot
    if (!bot) return null
    const player = getPlayerEntity(bot, playerName)
    if (!player) return null

    const yawDeg = ((Math.PI - player.yaw) * 180 / Math.PI + 180 + 360) % 360 - 180
    const pitchDeg = -player.pitch * 180 / Math.PI
    this.sendLook(bot, yawDeg, pitchDeg)
    return `玩家 ${playerName} 正在看向 横${yawDeg.toFixed(1)}° 纵${pitchDeg.toFixed(1)}°`
  }

  async lookAtCoord (x: number, y: number, z: number): Promise<string> {
    const bot = this.mcBot.bot
    if (!bot) return '机器人未就绪'
    this.placeModule.setReferenceTarget(new Vec3(x, y, z))
    try {
      await lookAtSmart(bot, new Vec3(x + 0.5, y + 0.5, z + 0.5), false)
    } catch (err) {
      return `看向失败: ${(err as Error).message}`
    }
    return `已看向 ${x}, ${y}, ${z}`
  }

  private sendLook (bot: Bot, yawDeg: number, pitchDeg: number): void {
    try {
      const target = lookAnglesSmart(bot, yawDeg, pitchDeg, 10)
      void lookAtSmart(bot, target, false).catch(() => { /* best effort */ })
      this.placeModule.setReferenceTarget(this.currentLookBlock(bot)?.position ?? target)
    } catch { /* ignore malformed angles */ }
  }

  private currentLookBlock (bot: Bot): { position: Vec3 } | null {
    const cosPitch = Math.cos(bot.entity.pitch)
    const eye = bot.entity.position.offset(0, eyeHeightOf(bot), 0)
    const direction = new Vec3(
      -Math.sin(bot.entity.yaw) * cosPitch,
      Math.sin(bot.entity.pitch),
      -Math.cos(bot.entity.yaw) * cosPitch
    )
    return bot.world.raycast(eye, direction, 10) as { position: Vec3 } | null
  }
}
