import type { Bot } from 'mineflayer'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import { debug } from '../../platform/logger'
import {
  approachEntity,
  entityDistance,
  entityLookPoint,
  isMountedOnVehicle,
  isRideableEntity
} from '../shared/entity-utils'

type Entity = NonNullable<Bot['entities'][string]>
type PassengerRef = { id?: number; username?: string }
type EntityWithPassengers = Entity & { passengers?: PassengerRef[] }

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

    const allRideables = Object.values(bot.entities)
      .filter((entity): entity is Entity => Boolean(entity && entity !== bot.entity && entity.position && isRideableEntity(entity)))
    const nearbyRideables = allRideables
      .filter(entity => entityDistance(bot, entity) <= this.approachDistance)
    const candidates = nearbyRideables
      .filter(entity => !this.hasOtherPassengers(bot, entity))
      .sort((a, b) => entityDistance(bot, a) - entityDistance(bot, b))

    if (candidates.length === 0) {
      const occupiedCount = nearbyRideables.filter(entity => this.hasOtherPassengers(bot, entity)).length
      debug(`[Minecart] 未找到空载可骑乘实体，附近可骑乘 ${nearbyRideables.length} 个，其中已载人 ${occupiedCount} 个`)
      return {
        success: false,
        message: occupiedCount > 0
          ? '附近没有空闲的可骑乘载具'
          : `${this.approachDistance} 格内未找到可骑乘的矿车/船/马/猪`
      }
    }

    let lastFailure: ServiceResult = { success: false, message: '未能上车' }
    for (const candidate of candidates) {
      // 接近过程中实体可能被移除、移动，或被其他玩家先占用；始终用最新实体复查。
      const vehicle = bot.entities[candidate.id]
      if (!vehicle || !vehicle.position || !isRideableEntity(vehicle) || this.hasOtherPassengers(bot, vehicle)) {
        continue
      }

      const approach = await approachEntity(
        bot,
        vehicle,
        this.interactionDistance,
        this.approachDistance
      )
      if (!approach.success) {
        lastFailure = approach
        continue
      }

      try {
        const boarded = await this.tryBoard(bot, vehicle)
        if (boarded) {
          const distance = entityDistance(bot, vehicle).toFixed(1)
          debug(`[Minecart] 上车成功 (距离 ${distance})`)
          return { success: true, message: '已上车' }
        }
      } catch (err) {
        lastFailure = { success: false, message: (err as Error).message }
      }
    }

    return lastFailure
  }

  private hasOtherPassengers (bot: Bot, vehicle: Entity): boolean {
    const passengers = (vehicle as EntityWithPassengers).passengers
    if (!Array.isArray(passengers)) return false

    return passengers.some(passenger =>
      passenger.id !== bot.entity.id && passenger.username !== bot.username
    )
  }

  private async tryBoard (bot: Bot, vehicle: Entity): Promise<boolean> {
    const maxAttempts = 4

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entity = bot.entities[vehicle.id]
      if (!entity || !isRideableEntity(entity)) return false
      if (this.hasOtherPassengers(bot, entity)) {
        debug(`[Minecart] 载具在交互前已被其他玩家占用，跳过`)
        return false
      }

      const lookPoint = entityLookPoint(entity)
      await bot.activateEntityAt(entity, lookPoint)
      await sleep(400)

      // 激活请求存在网络延迟，确认挂载前再次检查，避免误操作已被占用的载具。
      if (this.hasOtherPassengers(bot, entity)) return false

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
