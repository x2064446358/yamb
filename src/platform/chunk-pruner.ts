import type { Bot } from 'mineflayer'
import type MinecraftBot from './minecraft-bot'
import { debug } from './logger'
import { gcNowIfAvailable } from './memory-watchdog'

/**
 * 区块裁剪："观察中"（当前视距内）的区块保留，超出视距的主动卸载。
 *
 * mineflayer 只在收到服务器的 unload_chunk 包时删除区块（prismarine-world 的
 * world.columns），插件服常不下发卸载包，于是 bot 大量传送后旧区块永久驻留内存。
 * 本模块定期把"超出当前视距 + 安全余量"的区块手动 unloadColumn 掉。
 *
 * 为什么不会造成永久盲区：服务器只对"进入玩家视距"的区块负责下发，不记录客户端
 * 是否已丢弃某块；所以卸载"超出视距"的区块后，bot 移动回附近时服务器会重新下发。
 * 唯一不能动的是"仍处于视距内"的区块 —— 那才是服务器以为你有、不会补发的情况。
 *
 * 环境变量：
 *   MC_CHUNK_PRUNER=0            关闭（默认开启）
 *   MC_CHUNK_PRUNER_INTERVAL_MS  扫描间隔（默认 20000）
 *   MC_CHUNK_PRUNER_MARGIN       超出视距多少格才卸载，防误删（默认 1）
 */

interface PrunableWorld {
  columns?: Record<string, unknown>
  unloadColumn?: (chunkX: number, chunkZ: number) => void
}

let timer: ReturnType<typeof setInterval> | null = null

/** 卸载超出 keepRadius（切比雪夫距离）的区块，返回卸载数量 */
export function pruneDistantChunks (bot: Bot, keepRadius: number, margin = 3): number {
  const world = (bot as unknown as { world?: PrunableWorld }).world
  if (!world?.columns || typeof world.unloadColumn !== 'function') return 0

  const pos = bot.entity.position
  const cx = Math.floor(pos.x / 16)
  const cz = Math.floor(pos.z / 16)
  const limit = keepRadius + margin
  let removed = 0

  for (const key of Object.keys(world.columns)) {
    const parts = key.split(',')
    const x = parseInt(parts[0], 10)
    const z = parseInt(parts[1], 10)
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue
    // 切比雪夫距离（区块坐标），匹配 minecraft 方形视距
    const dist = Math.max(Math.abs(x - cx), Math.abs(z - cz))
    if (dist > limit) {
      try {
        world.unloadColumn(x, z)
        removed++
      } catch { /* 忽略单块失败 */ }
    }
  }

  if (removed > 0) {
    debug(`[Pruner] 卸载 ${removed} 个超出视距的区块 (keep=${keepRadius}, limit=${limit})`)
    // 区块对象较大，卸载后主动 GC，让堆尽快归还（带节流，无 --expose-gc 时空操作）
    gcNowIfAvailable()
  }
  return removed
}

export function startChunkPruner (mcBot: MinecraftBot): void {
  if (timer) return
  if (process.env.MC_CHUNK_PRUNER === '0' || process.env.MC_CHUNK_PRUNER === 'false') {
    debug('[Pruner] 已通过 MC_CHUNK_PRUNER=0 关闭')
    return
  }

  const intervalMs = Number(process.env.MC_CHUNK_PRUNER_INTERVAL_MS) || 20000
  const margin = Number(process.env.MC_CHUNK_PRUNER_MARGIN) || 1

  timer = setInterval(() => {
    const bot = mcBot.bot
    if (!bot || !mcBot.isReady) return
    const view = mcBot.getViewDistance()
    if (view <= 0) return
    pruneDistantChunks(bot, view, margin)
  }, intervalMs)

  timer.unref?.()
  debug(`[Pruner] 启动，每 ${intervalMs / 1000}s 扫描一次 (margin=${margin})`)
}

export function stopChunkPruner (): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
