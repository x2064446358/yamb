import v8 from 'v8'
import { debug, warn, error } from './logger'
import type MinecraftBot from './minecraft-bot'

/**
 * 内存看门狗：定期上报堆占用，并在接近 --max-old-space-size 上限时报警/保存堆快照。
 *
 * mineflayer 长挂机时 bot.world（区块）+ bot.entities 会随在线时间增长，
 * 若服务器不下发 chunk 卸载包，内存只增不减。本模块让增长过程在日志里可见，
 * 并在崩溃前留下 heap snapshot 用于定位真正的泄漏来源。
 *
 * 环境变量：
 *   MC_MEMORY_WATCH_INTERVAL_MS   检查间隔（默认 30000）
 *   MC_MEMORY_WARN_RATIO          警告阈值（默认 0.85，即堆用满 85%）
 *   MC_MEMORY_SNAPSHOT_RATIO      堆快照阈值（默认 0.92）
 *   MC_MEMORY_RESTART=1           到达快照阈值时直接退出进程（配合外部守护循环自动重启）
 *   MC_MEMORY_GC=0               关闭主动强制 GC（默认开启；需 --expose-gc 启动才生效）
 */

/** 是否已带 --expose-gc 启动（无则主动 GC 为空操作，安全降级） */
function gcAvailable (): boolean {
  return typeof (globalThis as unknown as { gc?: unknown }).gc === 'function'
}

let lastGcAt = 0

/**
 * 主动强制 GC（带节流）：mineflayer 高频创建/销毁区块、实体对象，V8 常延迟回收，
 * 主动 gc 能把已释放但未回收的堆及时归还，防止长挂后内存缓慢攀升。
 * 无 --expose-gc 时为空操作。
 */
export function gcNowIfAvailable (): void {
  if (!gcAvailable()) return
  const now = Date.now()
  if (now - lastGcAt < 60000) return
  lastGcAt = now
  try { (globalThis as unknown as { gc: () => void }).gc() } catch { /* */ }
}

function heapLimitMb (): number {
  const arg = process.argv.find(a => a.startsWith('--max-old-space-size='))
  if (arg) {
    const v = parseInt(arg.split('=')[1], 10)
    if (Number.isFinite(v) && v > 0) return v
  }
  return 1536
}

let started = false
let watchdogTimer: ReturnType<typeof setInterval> | null = null

export function stopMemoryWatchdog (): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  started = false
}

export function startMemoryWatchdog (mcBot: MinecraftBot): void {
  if (started) return
  started = true

  const intervalMs = Number(process.env.MC_MEMORY_WATCH_INTERVAL_MS) || 30000
  const warnRatio = Number(process.env.MC_MEMORY_WARN_RATIO) || 0.85
  const snapshotRatio = Number(process.env.MC_MEMORY_SNAPSHOT_RATIO) || 0.92
  const restartOnCritical =
    process.env.MC_MEMORY_RESTART === '1' || process.env.MC_MEMORY_RESTART === 'true'

  const limit = heapLimitMb() * 1024 * 1024
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)}MB`
  let lastSummary = 0

  watchdogTimer = setInterval(() => {
    const mem = process.memoryUsage()
    const ratio = mem.heapUsed / limit
    const now = Date.now()

    // 主动 GC：堆占用超过 40% 时强制回收，防止长挂后内存缓慢攀升
    if (process.env.MC_MEMORY_GC !== '0' && ratio >= 0.4) {
      gcNowIfAvailable()
    }

    // 每 10 分钟记一条汇总，供排查内存随时间增长
    if (now - lastSummary >= 10 * 60 * 1000) {
      lastSummary = now
      // entities 数量用于验证"内存增长是否与实体累积有关"（mineflayer 幽灵实体常见）
      let entities = -1
      try {
        const bot = mcBot.bot
        if (bot) entities = Object.keys(bot.entities).length
      } catch { /* */ }
      debug(`[Mem] heap=${mb(mem.heapUsed)}/${heapLimitMb()}MB rss=${mb(mem.rss)} external=${mb(mem.external)} entities=${entities} ratio=${(ratio * 100).toFixed(0)}%`)
    }

    if (ratio >= snapshotRatio) {
      if (restartOnCritical) {
        error(`[Mem] 堆占用 ${(ratio * 100).toFixed(0)}% 超过临界值，进程退出以触发重启 (heap=${mb(mem.heapUsed)})`)
        process.exit(1)
      }
      try {
        const file = v8.writeHeapSnapshot()
        error(`[Mem] 堆占用 ${(ratio * 100).toFixed(0)}% 接近上限，已保存堆快照: ${file} (heap=${mb(mem.heapUsed)})`)
      } catch (err) {
        error('[Mem] 堆快照保存失败:', err)
      }
    } else if (ratio >= warnRatio) {
      warn(`[Mem] 堆占用 ${(ratio * 100).toFixed(0)}% (heap=${mb(mem.heapUsed)}/${heapLimitMb()}MB rss=${mb(mem.rss)})`)
    }
  }, intervalMs)

  watchdogTimer.unref?.()
}
