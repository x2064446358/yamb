import { goals } from 'mineflayer-pathfinder'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import { debug } from '../../platform/logger'
import {
  ensurePathfinder,
  entityDistance,
  entityLookPoint,
  getEntityVehicle,
  getPlayerEntity,
  getVehicle,
  lookAtSmart
} from '../../actions/shared/entity-utils'

export type HissStopReason = 'stopped' | 'target_lost' | 'bot_unavailable' | 'replaced' | 'riding' | 'error'
export type HissStopHandler = (targetName: string, reason: HissStopReason) => void

interface HissTask {
  targetName: string
  onStop: HissStopHandler
}

/** Empty-hand player chasing, with navigation handled directly by mineflayer-pathfinder. */
export default class HissModule {
  private static readonly ATTACK_INTERVAL_MS = 1800
  private static readonly ATTACK_BURST_LIMIT = 3
  private static readonly ATTACK_BURST_PAUSE_MS = 5000
  // Leave margin below vanilla reach to avoid invalid-reach checks while the target moves.
  private static readonly ATTACK_DISTANCE = 2.4
  private hissTask: HissTask | null = null

  constructor (private readonly mcBot: MinecraftBot) {}

  isActive (): boolean {
    return this.hissTask !== null
  }

  async start (targetName: string, onStop: HissStopHandler): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '\u673a\u5668\u4eba\u672a\u5c31\u7eea' }
    }
    if (getVehicle(bot) || getEntityVehicle(bot)) {
      return { success: false, code: 'riding', message: '\u5f53\u524d\u6b63\u5728\u9a91\u4e58\uff0c\u8bf7\u5148\u4e0b\u8f66\u518d\u54c8\u6c14\u3002' }
    }
    if (!getPlayerEntity(bot, targetName)) {
      return { success: false, message: `\u73a9\u5bb6 ${targetName} \u4e0d\u5728\u7ebf\u6216\u4e0d\u53ef\u89c1` }
    }

    this.stop('replaced')
    try {
      await bot.unequip('hand')
    } catch (err) {
      return { success: false, message: `\u65e0\u6cd5\u5207\u6362\u4e3a\u7a7a\u624b: ${(err as Error).message}` }
    }

    try { bot.pathfinder.stop() } catch { /* ignore */ }
    bot.clearControlStates()
    const task: HissTask = { targetName, onStop }
    this.hissTask = task
    void this.run(task)
    return { success: true, message: `\u5f00\u59cb\u8ffd\u51fb ${targetName}` }
  }

  stop (reason: HissStopReason = 'stopped'): string | null {
    const task = this.hissTask
    if (!task) return null
    this.hissTask = null
    this.stopMovement()
    task.onStop(task.targetName, reason)
    return task.targetName
  }

  private async run (task: HissTask): Promise<void> {
    let targetMissingSince = 0
    let attackBurst = 0
    const attackDistance = HissModule.ATTACK_DISTANCE
    const goalRadius = Math.max(1, attackDistance - 1)

    try {
      while (this.hissTask === task) {
        const bot = this.mcBot.bot
        if (!this.mcBot.isReady || !bot || (typeof bot.health === 'number' && bot.health <= 0)) {
          this.finish(task, 'bot_unavailable')
          return
        }
        if (getVehicle(bot) || getEntityVehicle(bot)) {
          this.finish(task, 'riding')
          return
        }

        const target = getPlayerEntity(bot, task.targetName)
        if (!target) {
          if (targetMissingSince === 0) targetMissingSince = Date.now()
          if (Date.now() - targetMissingSince >= 15_000) {
            this.finish(task, 'target_lost')
            return
          }
          await sleep(500)
          continue
        }
        targetMissingSince = 0

        if (bot.heldItem) await bot.unequip('hand')

        if (entityDistance(bot, target) <= attackDistance) {
          try { bot.pathfinder.stop() } catch { /* ignore */ }
          bot.clearControlStates()
          await lookAtSmart(bot, entityLookPoint(target))
          if (this.hissTask !== task || !this.mcBot.isReady) return

          const currentTarget = getPlayerEntity(bot, task.targetName)
          if (!currentTarget || !currentTarget.isValid || entityDistance(bot, currentTarget) > attackDistance) {
            await sleep(250)
            continue
          }

          bot.attack(currentTarget)
          attackBurst++
          if (attackBurst >= HissModule.ATTACK_BURST_LIMIT) {
            attackBurst = 0
            await sleep(HissModule.ATTACK_BURST_PAUSE_MS)
          } else {
            await sleep(HissModule.ATTACK_INTERVAL_MS)
          }
          continue
        }

        const pathfinder = ensurePathfinder(bot)
        try {
          await pathfinder.pathfinder.goto(new goals.GoalNear(
            target.position.x,
            target.position.y,
            target.position.z,
            goalRadius
          ))
        } catch {
          // Stopping the task causes PathStopped. Moving/unreachable targets
          // are retried with the latest position on the next iteration.
          if (this.hissTask !== task) return
          await sleep(500)
        }
        await sleep(100)
      }
    } catch (err) {
      debug(`[Hiss] chase ${task.targetName} failed: ${(err as Error).message}`)
      this.finish(task, 'error')
    }
  }

  private finish (task: HissTask, reason: HissStopReason): void {
    if (this.hissTask !== task) return
    this.hissTask = null
    this.stopMovement()
    task.onStop(task.targetName, reason)
  }

  private stopMovement (): void {
    const bot = this.mcBot.bot
    try { bot?.pathfinder.stop() } catch { /* ignore */ }
    bot?.clearControlStates()
  }
}
