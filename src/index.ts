import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { loadConfig, validateConfig, resolveDataPath } from './config/loader'
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
import BotSync from './features/botsync'
import TeleportService from './features/teleport/service'
import TeleportIncomingHandler from './features/teleport/incoming-handler'
import PlayerInteractionService from './actions/player'
import MinecartInteractionService from './actions/minecart'
import RidingManager from './features/riding/manager'
import InventoryActions from './actions/inventory'
import ContainerRegistry from './features/container/registry'
import GameApiService from './api/game-service'
import SystemMessageBuffer from './features/commands/system-buffer'
import CommandHandler from './features/commands/handler'
import { registerChatListeners } from './features/commands/listeners'
import BrewModule from './features/brew'
import AstrbotServer from './api/server'

async function main (): Promise<void> {
  const config = loadConfig()
  validateConfig(config)

  // Prevent duplicate startup
  const lockFile = path.join(resolveDataPath('./data'), `.bot-${config.botIdentity.accountName || config.minecraft.username}.lock`)
  try {
    if (fs.existsSync(lockFile)) {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10)
      try { process.kill(pid, 0); console.error(`[Main] Bot already running (PID ${pid}). 请勿重复启动！`); process.exit(1) } catch { /* stale lock */ }
    }
    fs.writeFileSync(lockFile, String(process.pid))
  } catch (err) { console.error('[Main] Lock check failed:', (err as Error).message) }

  console.log('[Main] Starting mchatbot...')
  console.log(`[Main] AstrBot (QQ群): ${config.astrbot.enabled ? '已启用' : '已禁用'}`)
  console.log(`[Main] 管理员: ${config.adminList.length} 人`)
  console.log(`[Main] 游戏内命令前缀: ${config.command.prefix}`)
  console.log(`[Main] 交互距离: ${config.bot.interactionDistance} 格 / 接近距离: ${config.bot.approachDistance} 格`)
  console.log(`[Main] 公屏命令: ${config.command.allowPublicCommands ? '已启用' : '已禁用'}`)
  console.log(`[Main] 可视化 (viewer): ${config.viewer.enabled ? `已启用 :${config.viewer.port}` : '已禁用'}`)

  const dbPath = resolveDataPath(config.teleport.databaseFile)
  const db = initDatabase(dbPath)
  migrateFromJson(resolveDataPath('./data/whitelist.json'))
  importWllbotData(db, 'c:/Users/User/Desktop/MIN/BOT/wllbot_data.txt')

  const messageQueue = new MessageQueue(config.messageQueue)
  console.log('[Main] Message queue initialized')

  const whitelist = new Whitelist(db)
  const containerRegistry = new ContainerRegistry(db)
  console.log(`[Main] Whitelist loaded (${whitelist.count()} entries)`)
  console.log(`[Main] Containers loaded (${containerRegistry.count()} entries)`)

  const mcBot = new MinecraftBot(config.minecraft, config.command.whisperCommand)
  const jumpModule = new JumpModule(mcBot)
  const useItemModule = new UseItemModule(mcBot)
  const loopCmd = new LoopCmd(mcBot, config.loopCmd)
  const antiPVP = new AntiPVP(mcBot)

  const syncTargets = (process.env.BOT_SYNC_TARGETS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const botSync = new BotSync(mcBot, {
    botName: config.botPhome.name,
    syncTargets,
    enabled: syncTargets.length > 0
  }, db)
  mcBot.setMessageQueue(messageQueue)

  const systemBuffer = new SystemMessageBuffer()
  const standbyManager = new StandbyManager(mcBot, config.bot)
  const teleportService = new TeleportService(mcBot, config.teleport)
  teleportService.setDb(db, config.botPhome.name || config.minecraft.username || 'bot')
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
  standbyManager.setRidingManager(ridingManager)
  standbyManager.setLockChecker(() => teleportService.isLocked())
  const inventoryActions = new InventoryActions(mcBot)
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
    botSync,
    db,
    containerRegistry,
    inventoryActions,
    systemBuffer,
    whitelist,
    standbyManager,
    config.command,
    config.bot,
    config.adminList
  )
  botSync.setCascadeHandlers(
    (player: string) => commandHandler.handleCascadeCancelFor(player),
    (player: string) => commandHandler.handleCascadeBusy(player)
  )
  const teleportHandler = new TeleportIncomingHandler(
    teleportService,
    whitelist,
    mcBot,
    commandHandler.getCommandMessages(),
    standbyManager,
    config.adminList
  )

  mcBot.onSpawn(() => {
    registerChatListeners(mcBot, commandHandler, teleportHandler, systemBuffer)
    ridingManager.start()
    standbyManager.start()
    loopCmd.start()
    antiPVP.start()
    if (syncTargets.length > 0) botSync.start()
    if (config.viewer.enabled && mcBot.bot) {
      startViewer(mcBot.bot, config.viewer)
    }
  })
  mcBot.create()
  console.log('[Main] Minecraft bot starting...')

  const brewModule = new BrewModule(mcBot, config.brew)
  brewModule.register()

  let apiServer: AstrbotServer | null = null
  if (config.astrbot.enabled) {
    apiServer = new AstrbotServer(config.astrbot, teleportService, gameApiService, whitelist)
    await apiServer.start()
    console.log('[Main] AstrBot API server started')
  } else {
    console.log('[Main] AstrBot API server skipped (disabled)')
  }

  process.on('SIGINT', () => {
    console.log('[Main] Shutting down...')
    try { fs.unlinkSync(lockFile) } catch { /* */ }
    stopViewer(mcBot.bot)
    ridingManager.stop()
    standbyManager.stop()
    loopCmd.stop()
    antiPVP.stop()
    apiServer?.stop()
    messageQueue.clear()
    closeDatabase()
    process.exit(0)
  })

  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught exception:', err)
    try { fs.unlinkSync(lockFile) } catch { /* */ }
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    const msg = String(reason)
    if (msg.includes('blockUpdate') || msg.includes('did not fire within timeout')) {
      console.warn('[Main] Place block timeout (ignored)')
      return
    }
    console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
  })
}

main().catch(err => {
  console.error('[Main] Fatal error:', err)
  process.exit(1)
})
