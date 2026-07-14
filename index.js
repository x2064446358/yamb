require('dotenv').config()
const path = require('path')
const Whitelist = require('./modules/whitelist')
const MinecraftBot = require('./modules/minecraft-bot')
const ApiServer = require('./modules/api-server')
const MessageQueue = require('./modules/message-queue')

// 从环境变量或配置文件加载配置
const config = {
  minecraft: {
    host: process.env.MC_HOST || 'mc.zenoxs.cn',
    port: parseInt(process.env.MC_PORT || '25565'),
    username: process.env.MC_USERNAME,
    auth: 'microsoft',
    profilesFolder: './mc-tokens',
    version: false,
    checkTimeoutInterval: 300000
  },
  api: {
    port: parseInt(process.env.API_PORT || '15100'),
    apiKey: process.env.API_KEY
  },
  whitelistFile: './data/whitelist.json',
  messageQueue: {
    maxSize: parseInt(process.env.QUEUE_MAX_SIZE || '100'),
    delayMs: parseInt(process.env.QUEUE_DELAY_MS || '1000')
  }
}

// 验证必需的环境变量
if (!config.minecraft.username) {
  console.error('[Main] Error: MC_USERNAME environment variable is required')
  process.exit(1)
}

if (!config.api.apiKey) {
  console.error('[Main] Error: API_KEY environment variable is required')
  process.exit(1)
}

async function main () {
  console.log('[Main] Starting mchatbot...')

  // 初始化消息队列
  const messageQueue = new MessageQueue()
  console.log('[Main] Message queue initialized')

  // 初始化白名单
  const whitelist = new Whitelist(path.join(__dirname, 'data', 'whitelist.json'))
  await whitelist.load()
  console.log('[Main] Whitelist loaded')

  // 初始化Minecraft机器人
  const mcBot = new MinecraftBot(config.minecraft)
  mcBot.setMessageQueue(messageQueue)
  mcBot.create()
  console.log('[Main] Minecraft bot starting...')

  // 初始化HTTP API服务
  const apiServer = new ApiServer(config.api, mcBot, whitelist)
  await apiServer.start()
  console.log('[Main] API server started')

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('[Main] Shutting down...')
    apiServer.stop()
    messageQueue.clear()
    process.exit(0)
  })

  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught exception:', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })
}

main().catch(err => {
  console.error('[Main] Fatal error:', err)
  process.exit(1)
})
