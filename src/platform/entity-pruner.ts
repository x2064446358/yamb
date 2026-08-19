import type { Bot } from 'mineflayer'
import type MinecraftBot from './minecraft-bot'
import { debug } from './logger'
import { gcNowIfAvailable } from './memory-watchdog'

/**
 * 实体裁剪：清理"远离 bot 且非必要"的实体，防止 bot.entities 无限累积。
 *
 * 背景：mineflayer 的 fetchEntity(id) 会在任何实体更新包到达时，为不存在的 id
 * 凭空创建实体（lib/plugins/entities.js）。服务器生物多、spawn/despawn 频繁时，
 * 幽灵实体或未收到 destroy 包的实体会一直留在 bot.entities 里，内存只增不减。
 *
 * 安全规则（保守）：
 *   - 跳过 bot 自身、所有玩家实体（数量有限，且可能是骑乘对象）
 *   - 跳过 bot 当前载具/骑乘对象（含插件云座 area_effect_cloud，滞空锁定依赖它）
 *   - 只清理半径之外的非玩家实体。若服务器仍发更新包，fetchEntity 会自动重建，代价很低
 *
 * 环境变量：
 *   MC_ENTITY_PRUNER=0            关闭（默认开启）
 *   MC_ENTITY_PRUNER_INTERVAL_MS  扫描间隔（默认 30000）
 *   MC_ENTITY_PRUNER_RADIUS       清理半径（默认 64）
 */

let timer: ReturnType<typeof setInterval> | null = null

/** 清理距 bot 超过 radius 的非玩家、非载具实体，返回清理数量 */
export function pruneFarEntities (bot: Bot, radius: number): number {
  const entities = bot.entities as unknown as Record<string, { type?: string; name?: string }>
  const self = bot.entity
  const vehicle = (bot as unknown as { vehicle?: unknown }).vehicle
  const entityVehicle = (self as unknown as { vehicle?: unknown }).vehicle
  const botPos = self.position

  let removed = 0
  for (const id of Object.keys(entities)) {
    const e = entities[id]
    if (!e || e === self) continue
    if (e.type === 'player') continue
    // Automatic brewing searches known cows and pathfinds to them. Keep cow
    // entities available even when they are outside the generic cleanup radius.
    if (e.type === 'mob' && e.name === 'cow') continue
    // 载具/骑乘对象（含插件云座）不能清，否则破坏骑乘/滞空逻辑
    if (e === vehicle || e === entityVehicle) continue

    const other = e as unknown as { position?: { x: number; y: number; z: number } }
    const p = other.position
    if (!p) continue
    const d = Math.hypot(p.x - botPos.x, p.y - botPos.y, p.z - botPos.z)
    if (d > radius) {
      delete entities[id]
      removed++
    }
  }

  if (removed > 0) {
    gcNowIfAvailable()
  }
  return removed
}

export function startEntityPruner (mcBot: MinecraftBot): void {
  if (timer) return
  if (process.env.MC_ENTITY_PRUNER === '0' || process.env.MC_ENTITY_PRUNER === 'false') {
    debug('[EntPruner] 已通过 MC_ENTITY_PRUNER=0 关闭')
    return
  }

  const intervalMs = Number(process.env.MC_ENTITY_PRUNER_INTERVAL_MS) || 30000
  const radius = Number(process.env.MC_ENTITY_PRUNER_RADIUS) || 64

  timer = setInterval(() => {
    const bot = mcBot.bot
    if (!bot || !mcBot.isReady) return
    pruneFarEntities(bot, radius)
  }, intervalMs)

  timer.unref?.()
  debug(`[EntPruner] 启动，每 ${intervalMs / 1000}s 清理半径 ${radius} 外的实体`)
}

export function stopEntityPruner (): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
