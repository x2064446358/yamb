import type { Bot } from 'mineflayer'
import type { ServiceResult } from '../../types'
import { debug } from '../../platform/logger'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import {
  approachEntity,
  entityDistance,
  entityLookPoint,
  getPlayerEntity,
  isMountedOnPlayer,
  lookAtSmart
} from '../shared/entity-utils'

export default class PlayerInteractionService {
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

  getApproachDistance (): number {
    return this.approachDistance
  }

  isPlayerInRange (targetName: string): boolean {
    const bot = this.mcBot.bot
    if (!bot) return false
    const entity = getPlayerEntity(bot, targetName)
    if (!entity) return false
    return entityDistance(bot, entity) <= this.approachDistance
  }

  isMountedOn (targetName: string): boolean {
    const bot = this.mcBot.bot
    if (!bot) return false
    return isMountedOnPlayer(bot, targetName)
  }

  async mount (targetName: string): Promise<ServiceResult> {
    return this.interactWithPlayer(targetName, 'mount', Math.max(this.approachDistance, 32))
  }

  async attack (targetName: string): Promise<ServiceResult> {
    return this.interactWithPlayer(targetName, 'attack')
  }

  async remountPlayer (targetName: string): Promise<boolean> {
    if (!this.mcBot.isReady || !this.mcBot.bot) return false

    // 意外下坐后玩家常已移动；每轮都重新读取实体和位置，再靠近而非对旧坐标反复右键。
    const seekDistance = Math.max(this.approachDistance, 32)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const bot = this.mcBot.bot
      if (!this.mcBot.isReady || !bot) return false
      const entity = getPlayerEntity(bot, targetName)
      if (!entity) {
        debug(`[Interaction] 重坐时未找到玩家 ${targetName} (${attempt}/3)`)
        if (attempt < 3) await sleep(500)
        continue
      }

      const approach = await approachEntity(
        bot,
        entity,
        this.interactionDistance,
        seekDistance
      )
      if (!approach.success) {
        debug(`[Interaction] 重坐靠近 ${targetName} 失败 (${attempt}/3): ${approach.message || '未知错误'}`)
      } else if (await this.tryMountPlayer(bot, targetName, 2)) {
        return true
      }

      if (attempt < 3) await sleep(350)
    }
    const bot = this.mcBot.bot
    return !!bot && isMountedOnPlayer(bot, targetName)
  }

  private async interactWithPlayer (
    targetName: string,
    action: 'mount' | 'attack',
    seekDistance = this.approachDistance
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const entity = getPlayerEntity(bot, targetName)
    if (!entity) {
      return { success: false, message: `玩家 ${targetName} 不在线或不可见` }
    }

    const approach = await approachEntity(
      bot,
      entity,
      this.interactionDistance,
      seekDistance
    )
    if (!approach.success) return approach

    try {
      if (action === 'mount') {
        const mounted = await this.tryMountPlayer(bot, targetName)
        const distance = entityDistance(bot, getPlayerEntity(bot, targetName) ?? entity).toFixed(1)
        if (mounted) {
          debug(`[Interaction] 骑乘 ${targetName} 成功 (距离 ${distance})`)
          return { success: true, message: `已骑乘 ${targetName}` }
        }
        debug(`[Interaction] 骑乘 ${targetName} 失败 (距离 ${distance})`)
        return { success: false, message: `未能骑乘 ${targetName}，请确认距离与服务器插件支持` }
      }

      const target = getPlayerEntity(bot, targetName) ?? entity
      const lookPoint = entityLookPoint(target)
      await lookAtSmart(bot, lookPoint)
      await sleep(200)
      bot.attack(target)
      debug(`[Interaction] 攻击 ${targetName}`)
      return { success: true, message: `已攻击 ${targetName}` }
    } catch (err) {
      console.error(`[Interaction] ${action} 失败:`, (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }

  private async tryMountPlayer (bot: Bot, targetName: string, maxAttempts = 4): Promise<boolean> {
    await bot.unequip('hand')
    await sleep(100)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entity = getPlayerEntity(bot, targetName)
      if (!entity) return false
      if (entityDistance(bot, entity) > this.interactionDistance + 0.5) {
        debug(`[Interaction] ${targetName} 已离开交互范围，重新寻路`)
        return false
      }

      const lookPoint = entityLookPoint(entity)
      await bot.activateEntityAt(entity, lookPoint)
      await sleep(400)

      if (isMountedOnPlayer(bot, targetName)) {
        debug(`[Interaction] 骑乘确认成功 (第 ${attempt} 次交互)`)
        return true
      }

      if (attempt < maxAttempts) {
        debug(`[Interaction] 未骑乘，重试 activateEntityAt (${attempt}/${maxAttempts})`)
        await sleep(250)
      }
    }

    return isMountedOnPlayer(bot, targetName)
  }
}
