import type { Bot } from 'mineflayer'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import { debug } from '../../platform/logger'
import {
  approachEntity,
  entityDistance,
  entityLookPoint,
  findNearestEntity,
  isMountedOnVehicle,
  isRideableEntity
} from '../shared/entity-utils'

type Entity = NonNullable<Bot['entities'][string]>

export default class MinecartInteractionService {
  private mcBot: MinecraftBot
  private interactionDistance: number
  private approachDistance: number

  constructor (
    mcBot: MinecraftBot,
    interactionDistance: number,
    approachDistance: number
  ) {
    this.mcBot = mcBot
    this.interactionDistance = interactionDistance
    this.approachDistance = approachDistance
  }

  async boardNearest (): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    if (isMountedOnVehicle(bot)) {
      return { success: false, message: '已在车上' }
    }

    const vehicle = findNearestEntity(bot, isRideableEntity, this.approachDistance)
    if (!vehicle) {
      const rideables = Object.values(bot.entities)
        .filter(e => e && e.position && isRideableEntity(e))
        .map(e => `${e.name}@${e.position.floored()}`)
      debug(`[Minecart] 未找到可骑乘实体，附近可骑乘: [${rideables.join(', ') || '无'}]`)
      return {
        success: false,
        message: `${this.approachDistance} 格内未找到可骑乘的矿车/船/马/猪`
      }
    }

    const approach = await approachEntity(
      bot,
      vehicle,
      this.interactionDistance,
      this.approachDistance
    )
    if (!approach.success) return approach

    try {
      const boarded = await this.tryBoard(bot, vehicle)
      const distance = entityDistance(bot, vehicle).toFixed(1)
      if (boarded) {
        debug(`[Minecart] 上车成功 (距离 ${distance})`)
        return { success: true, message: '已上车' }
      }
      return { success: false, message: '未能上车' }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  }

  private async tryBoard (bot: Bot, vehicle: Entity): Promise<boolean> {
    const maxAttempts = 4
    await bot.unequip('hand')
    await sleep(100)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entity = bot.entities[vehicle.id]
      if (!entity || !isRideableEntity(entity)) return false

      const lookPoint = entityLookPoint(entity)
      await bot.activateEntityAt(entity, lookPoint)
      await sleep(400)

      if (isMountedOnVehicle(bot)) {
        debug(`[Minecart] 上车确认成功 (第 ${attempt} 次交互)`)
        return true
      }

      bot.mount(entity)
      await sleep(400)
      if (isMountedOnVehicle(bot)) {
        debug(`[Minecart] 上车确认成功 (mount, 第 ${attempt} 次)`)
        return true
      }

      if (attempt < maxAttempts) {
        await sleep(250)
      }
    }

    return isMountedOnVehicle(bot)
  }
}
