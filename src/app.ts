import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { loadConfig, validateConfig, resolveDataPath, GAME_CONFIG_DIR } from './config/loader'
import { initDatabase, migrateFromJson, closeDatabase } from './platform/database'
import { importWllbotData } from './platform/import-data'
import MessageQueue from './platform/message-queue'
import MinecraftBot from './platform/minecraft-bot'
import StandbyManager from './features/standby/manager'
import { startViewer, stopViewer } from './features/viewer'
import Whitelist from './permissions/whitelist'
import LoopCmd from './features/loopcmd'
import AntiPVP from './features/antipvp'
import JumpModule from './features/jump'
import UseItemModule from './features/useitem'
import { resumeBotPhysics } from './actions/shared/entity-utils'
import TeleportService from './features/teleport/service'
import TeleportIncomingHandler from './features/teleport/incoming-handler'
import PlayerInteractionService from './actions/player'
import MinecartInteractionService from './actions/minecart'
import RidingManager from './features/riding/manager'
import InventoryActions, { itemDisplayName } from './actions/inventory'
import ContainerRegistry from './features/container/registry'
import GameApiService from './api/game-service'
import SystemMessageBuffer from './features/commands/system-buffer'
import CommandHandler, { setReloadHook } from './features/commands/handler'
import { registerChatListeners } from './features/commands/listeners'
import BrewModule from './features/brew'
import AstrbotServer from './api/server'
import { initLogger, debug, warn, error, closeLogger } from './platform/logger'
import { startMemoryWatchdog, stopMemoryWatchdog } from './platform/memory-watchdog'
import { startChunkPruner, stopChunkPruner } from './platform/chunk-pruner'
import { startEntityPruner, stopEntityPruner } from './platform/entity-pruner'
import { startConsoleUI, setStatus, setUiSend } from './platform/console-ui'

/**
 * 应用生命周期。终端 重载 时执行"进程内软重启"：
 *   1. stopApp：断开 bot、停模块/定时器、关 DB/日志（保留终端 UI 与进程信号处理）
 *   2. 清空 src 模块的 require.cache
 *   3. 重新 require ./app 并 startApp —— 新的代码/配置在同一个进程、同一个窗口里生效
 */
let statusTimer: ReturnType<typeof setInterval> | null = null
let apiServer: AstrbotServer | null = null
let currentStop: (() => void) | null = null
let appStarted = false
let reloading = false

/** 把 Windows 控制台输出代码页切到 UTF-8(65001)，否则 emoji/中文的 UTF-8 字节会被按本机代码页错解成乱码 */
let utf8ConsoleSet = false
function ensureUtf8Console (): void {
  if (utf8ConsoleSet || process.platform !== 'win32') return
  utf8ConsoleSet = true
  try {
    require('child_process').execSync('chcp 65001 > nul', { stdio: 'ignore' })
  } catch { /* 非控制台/受限环境忽略 */ }
}

/** 与进程/终端绑定的模块不能重新加载（否则 TUI/日志会出现双份单例），其余 src 模块全部清缓存 */
function clearSrcModuleCache (): void {
  const KEEP = new Set(['console-ui.ts', 'console-ui.js', 'logger.ts', 'logger.js'])
  const srcDir = __dirname
  for (const key of Object.keys(require.cache)) {
    if (!key.startsWith(srcDir)) continue
    if (KEEP.has(path.basename(key))) continue
    delete require.cache[key]
  }
}

export function stopApp (): void {
  if (currentStop) {
    currentStop()
    currentStop = null
  }
  appStarted = false
}

export async function reloadApp (): Promise<void> {
  if (reloading) return
  reloading = true
  try {
    stopApp()
    clearSrcModuleCache()
    const fresh = require('./app') as typeof import('./app')
    await fresh.startApp()
  } catch (err) {
    error('[Reload] 重载失败:', err)
  } finally {
    reloading = false
  }
}

export async function startApp (): Promise<void> {
  if (appStarted) stopApp()
  ensureUtf8Console()

  const config = loadConfig()
  validateConfig(config)

  const botName = config.botPhome.name || config.minecraft.username || 'bot'
  const logPath = resolveDataPath(`./data/logs/${botName}/${botName}.log`)
  initLogger(logPath)

  // Prevent duplicate startup（stopApp 已删除旧锁，重载不会误判）
  const lockFile = path.join(resolveDataPath('./data'), `.bot-${config.botIdentity.accountName || config.minecraft.username}.lock`)
  const isReloadSpawn = process.env.YAMB_RELOAD === '1'
  try {
    // 退化的 spawn 重启（未注册 reload 钩子时）让新进程接管锁
    if (!isReloadSpawn && fs.existsSync(lockFile)) {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10)
      try { process.kill(pid, 0); console.error(`[Main] Bot already running (PID ${pid}). 请勿重复启动！`); process.exit(1) } catch { /* stale lock */ }
    }
    fs.writeFileSync(lockFile, String(process.pid))
  } catch (err) { console.error('[Main] Lock check failed:', (err as Error).message) }

  debug('[Main] Starting mchatbot...')
  debug(`[Main] AstrBot (QQ群): ${config.astrbot.enabled ? '已启用' : '已禁用'}`)
  debug(`[Main] 管理员: ${config.adminList.length} 人`)
  debug(`[Main] 游戏内命令前缀: ${config.command.prefix}`)
  debug(`[Main] 交互距离: ${config.bot.interactionDistance} 格 / 接近距离: ${config.bot.approachDistance} 格`)
  debug(`[Main] 公屏命令: ${config.command.allowPublicCommands ? '已启用' : '已禁用'}`)
  debug(`[Main] 可视化 (viewer): ${config.viewer.enabled ? `已启用 :${config.viewer.port}` : '已禁用'}`)

  const dbPath = resolveDataPath(config.teleport.databaseFile)
  const db = initDatabase(dbPath)
  migrateFromJson(resolveDataPath('./data/whitelist.json'))
  importWllbotData(db, 'c:/Users/User/Desktop/MIN/BOT/wllbot_data.txt')

  const messageQueue = new MessageQueue(config.messageQueue)
  debug('[Main] Message queue initialized')

  const whitelist = new Whitelist(db)
  const containerRegistry = new ContainerRegistry(db)
  debug(`[Main] Whitelist loaded (${whitelist.count()} entries)`)
  debug(`[Main] Containers loaded (${containerRegistry.count()} entries)`)

  const mcBot = new MinecraftBot(config.minecraft, config.command.whisperCommand)
  mcBot.setMessageQueue(messageQueue)
  startMemoryWatchdog(mcBot)
  startChunkPruner(mcBot)
  startEntityPruner(mcBot)
  const jumpModule = new JumpModule(mcBot)
  const useItemModule = new UseItemModule(mcBot)
  const loopCmd = new LoopCmd(mcBot, config.loopCmd)
  const antiPVP = new AntiPVP(mcBot)

  const systemBuffer = new SystemMessageBuffer()
  const standbyManager = new StandbyManager(mcBot, config.bot)
  standbyManager.setBaseArea(
    config.botIdentity.baseMinX,
    config.botIdentity.baseMaxX,
    config.botIdentity.baseMinZ,
    config.botIdentity.baseMaxZ
  )
  const teleportService = new TeleportService(mcBot, config.teleport)
  const teleportConfigFile = process.env.BOT_TELEPORT_CONFIG || 'teleport.json'
  teleportService.setConfigPath(path.join(GAME_CONFIG_DIR, teleportConfigFile))
  teleportService.setDb(db, config.botPhome.name || config.minecraft.username || 'bot')
  // 小镇委托映射：主 bot 门控 + 同镇代执行（依赖 setDb 设置的 _botName）
  teleportService.setPhomeTowns(config.phomeTowns, GAME_CONFIG_DIR)
  teleportService.setOnUnlock(({ wasHover }) => {
    if (wasHover && mcBot.bot) {
      resumeBotPhysics(mcBot.bot)
    }
  })
  const playerInteraction = new PlayerInteractionService(
    mcBot,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  const minecartInteraction = new MinecartInteractionService(
    mcBot,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  const ridingManager = new RidingManager(mcBot, playerInteraction, config.bot)
  ridingManager.setDb(db, config.botPhome.name || config.minecraft.username || 'bot')
  ridingManager.setLockChecker(() => teleportService.isLocked())
  ridingManager.setBaseArea(
    config.botIdentity.baseMinX,
    config.botIdentity.baseMaxX,
    config.botIdentity.baseMinZ,
    config.botIdentity.baseMaxZ
  )
  standbyManager.setRidingManager(ridingManager)
  standbyManager.setLockChecker(() => teleportService.isLocked())
  const inventoryActions = new InventoryActions(mcBot)
  const brewModule = new BrewModule(
    mcBot,
    config.brew,
    containerRegistry,
    inventoryActions,
    useItemModule,
    config.bot.interactionDistance,
    config.bot.approachDistance,
    db,
    config.botIdentity.index
  )
  brewModule.setIsLockedProvider(() => teleportService.isLocked())
  brewModule.setAgingLockActions(
    by => teleportService.lock(by, '陈化'),
    () => teleportService.unlock(),
    () => teleportService.getLockedNote() === '陈化'
  )
  brewModule.register()
  standbyManager.setBusyChecker(() => brewModule.isRunning())
  const gameApiService = new GameApiService(mcBot, whitelist)
  const commandHandler = new CommandHandler(
    mcBot,
    teleportService,
    gameApiService,
    playerInteraction,
    minecartInteraction,
    ridingManager,
    jumpModule,
    useItemModule,
    loopCmd,
    db,
    containerRegistry,
    inventoryActions,
    systemBuffer,
    whitelist,
    standbyManager,
    brewModule,
    config.command,
    config.bot,
    config.adminList
  )
  // 终端 重载 → 进程内软重启（保持窗口）
  setReloadHook(() => { void reloadApp() })
  const teleportHandler = new TeleportIncomingHandler(
    teleportService,
    whitelist,
    mcBot,
    commandHandler.getCommandMessages(),
    standbyManager,
    config.adminList
  )

  mcBot.onSpawn(() => {
    // 重连后恢复持久化状态（锁、骑乘、拉特兰成员、酿酒任务等存在 DB 里，不会因掉线丢失）
    teleportService.restoreLockState()
    commandHandler.restoreLatelanMembers()
    void brewModule.restorePersisted()
    registerChatListeners(mcBot, commandHandler, teleportHandler, systemBuffer)
    ridingManager.start()
    ridingManager.tryRestoreMount()
    standbyManager.start()
    loopCmd.start()
    antiPVP.start()
    if (config.viewer.enabled && mcBot.bot) {
      startViewer(mcBot.bot, config.viewer)
    }
    // 终端 UI：首次启动时创建；重载后沿用同一个（started 单例），用 setUiSend 把输入指向新 handler
    const name = config.botPhome.name || config.minecraft.username || 'bot'
    startConsoleUI(name, (line) => {
      if (!mcBot.bot || !mcBot.isReady) return
      void commandHandler.handle(name, line, 'console')
    })
    setUiSend((line) => {
      if (!mcBot.bot || !mcBot.isReady) return
      void commandHandler.handle(name, line, 'console')
    })
    // Live status in header：每次 spawn 都复用同一个定时器句柄，防止重连/重载后定时器累积
    const updateStatus = () => {
      if (!mcBot.bot) return
      const bot = mcBot.bot
      const ready = mcBot.isReady
      const ping = bot.players?.[bot.username]?.ping ?? bot.player?.ping ?? 0
      const up = Math.floor(process.uptime())
      const h = Math.floor(up / 3600); const m = Math.floor((up % 3600) / 60); const s = up % 60

      const pos = bot.entity?.position
      const dimRaw = (bot as { game?: { dimension?: unknown } }).game?.dimension
      let dim: string | null = null
      if (typeof dimRaw === 'string') {
        const d = dimRaw.replace(/^minecraft:/, '')
        dim = d === 'overworld' ? '主世界' : d === 'the_nether' ? '下界' : d === 'the_end' ? '末地' : d
      } else if (typeof dimRaw === 'number') {
        dim = String(dimRaw)
      }

      const state = ready
        ? teleportService.isLocked() ? '锁定'
          : brewModule.isRunning() ? `酿酒(${brewModule.status().phase || '-'})`
            : jumpModule.isActive() ? '跳跃'
              : useItemModule.isActive() ? '使用/放置'
                : ridingManager.isActive() ? (ridingManager.getMode() === 'minecart' ? '坐矿车' : '骑乘')
                  : '空闲'
        : '断开'

      const brewStatus = brewModule.status()
      const brewDetail = brewStatus.running
        ? `${brewStatus.recipe || '-'} ${brewStatus.detail || brewStatus.phase || ''}`.trim()
        : null

      const timeOfDay = bot.time?.isDay != null
        ? (bot.time.isDay ? '白天' : '夜晚')
        : null

      const heldItem = bot.heldItem ? itemDisplayName(bot.heldItem) : null

      setStatus({
        online: ready,
        ping,
        uptime: `${h}h${m}m${s}s`,
        health: typeof bot.health === 'number' ? bot.health : null,
        food: typeof bot.food === 'number' ? bot.food : null,
        pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
        dimension: dim,
        viewDistance: mcBot.getViewDistance(),
        state,
        queueSize: messageQueue.getStatus().size,
        heldItem,
        entityCount: bot.entities ? Object.keys(bot.entities).length : null,
        dayTime: timeOfDay,
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        brewDetail
      })
    }
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = setInterval(updateStatus, 3000)
    updateStatus()
  })
  mcBot.create()
  debug('[Main] Minecraft bot starting...')

  if (config.astrbot.enabled) {
    apiServer = new AstrbotServer(config.astrbot, teleportService, gameApiService, whitelist)
    await apiServer.start()
    debug('[Main] AstrBot API server started')
  } else {
    debug('[Main] AstrBot API server skipped (disabled)')
  }

  // 登记本次运行实例的清理函数（重载/退出时调用）
  currentStop = () => {
    stopViewer(mcBot.bot)
    stopChunkPruner()
    stopEntityPruner()
    stopMemoryWatchdog()
    ridingManager.stop()
    standbyManager.stop()
    loopCmd.stop()
    antiPVP.stop()
    brewModule.cancel()
    brewModule.dispose()
    commandHandler.disposeTimers()
    teleportService.stop()
    if (apiServer) { apiServer.stop(); apiServer = null }
    messageQueue.clear()
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
    mcBot.disconnect()
    try { fs.unlinkSync(lockFile) } catch { /* */ }
    closeDatabase()
    closeLogger()
  }
  appStarted = true
}
