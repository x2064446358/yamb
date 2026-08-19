import mineflayer, { Bot, BotOptions } from 'mineflayer'
import type { MinecraftConfig } from '../types'
import type MessageQueue from './message-queue'
import { getBotClient } from './bot-client'
import { debug, info, warn, error } from './logger'

/** 高视距上限（use/place/look/跳跃 时临时拉高）。可用 MC_HIGH_VIEW_DISTANCE 覆盖。
 *  视距每 +1，加载区块数按 ~(2d+1)² 增长，是 mineflayer 内存消耗的大头，默认不宜过高。 */
function highViewDistance (): number {
  const raw = Number(process.env.MC_HIGH_VIEW_DISTANCE)
  if (Number.isFinite(raw)) return Math.max(6, Math.min(12, Math.floor(raw)))
  return 10
}

/** 破基岩模式（放置 <方块名> 追踪）固定视距（区块）。可用 MC_BREAK_VIEW_DISTANCE 覆盖，默认 8。
 *  追踪的机器/方块通常远离 bot，需要更远视距保证方块加载，故固定为 8 区块。 */
function breakViewDistance (): number {
  const raw = Number(process.env.MC_BREAK_VIEW_DISTANCE)
  if (Number.isFinite(raw)) return Math.max(6, Math.min(12, Math.floor(raw)))
  return 8
}

export default class MinecraftBot {
  config: MinecraftConfig
  bot: Bot | null = null
  isReady = false
  private acceptedResourcePacks = new Set<string>()
  private readonly reconnectDelay = 20000
  private reconnectScheduled = false
  private stopped = false
  private messageQueue: MessageQueue | null = null
  private onSpawnCallbacks: Array<(bot: MinecraftBot) => void> = []
  private whisperCommand = '/msg'
  private currentViewDistance = 6
  private highViewRequests = 0
  private highViewTimer: ReturnType<typeof setTimeout> | null = null
  private afkCommand = '/afk'
  // The server does not expose AFK as a protocol field. Track only AFK
  // toggles issued by this process and reset it whenever the connection ends.
  private serverAfk = false
  /** 破基岩模式是否开启：开启时视距固定 breakViewDistance()，占住高位请求不回落 */
  private breakViewActive = false
  private kaMonitor: ReturnType<typeof setInterval> | null = null
  // 关闭聊天签名：部分服务器(改过的 /msg 等命令)会让签名命令 argSigs=0 触发 chat_validation_failed。
  // 社区标准解法，环境变量 MC_DISABLE_CHAT_SIGNING=true 开启
  private readonly disableChatSigning = process.env.MC_DISABLE_CHAT_SIGNING === 'true'

  constructor (config: MinecraftConfig, whisperCommand = '/msg') {
    this.config = config
    this.whisperCommand = whisperCommand
  }

  setMessageQueue (queue: MessageQueue): void {
    this.messageQueue = queue
  }

  setAfkCommand (command: string): void {
    const normalized = command.trim()
    if (normalized) this.afkCommand = normalized
  }

  isServerAfk (): boolean {
    return this.serverAfk
  }

  setServerAfk (active: boolean, source = 'local'): void {
    if (this.serverAfk === active) return
    this.serverAfk = active
    debug(`[AFK] State: ${active ? 'active' : 'inactive'} (${source})`)
  }

  /** Queue the configured AFK toggle and remember the state for this connection. */
  sendAfk (): boolean {
    return this.chat(this.afkCommand)
  }

  /** 重载时断开当前连接（不触发自动重连），随后可调用 create() 重建 */
  disconnect (): void {
    this.stopped = true
    this._stopKeepAliveMonitor()
    this.isReady = false
    this.reconnectScheduled = false
    if (this.bot) {
      const old = this.bot
      this.bot = null
      try { old.end('reload') } catch { /* */ }
      try { old.removeAllListeners() } catch { /* */ }
    }
    this.acceptedResourcePacks.clear()
    this.setServerAfk(false, 'disconnect')
  }

  onSpawn (callback: (bot: MinecraftBot) => void): void {
    this.onSpawnCallbacks.push(callback)
  }

  create (): Bot {
    // 清理旧 bot：removeAllListeners 防止重连后旧 bot 的事件监听器残留
    if (this.bot) {
      try { this.bot.removeAllListeners() } catch { /* */ }
      this.bot = null
    }
    this.stopped = false
    this.setServerAfk(false, 'new connection')
    info('[MC] Creating bot...')
    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username!,
      auth: this.config.auth as 'microsoft' | 'mojang' | 'offline',
      profilesFolder: this.config.profilesFolder,
      checkTimeoutInterval: this.config.checkTimeoutInterval || 60000,
      connectTimeout: 60000,
      keepAlive: true,
      skipValidation: true,
      hideErrors: true,
      ...(this.disableChatSigning ? { disableChatSigning: true } : {}),
      ...(this.config.version !== false ? { version: this.config.version } : {})
    } as BotOptions

    // 微软账号走 OAuth，不能传 password
    if (this.config.auth !== 'microsoft' && this.config.password) {
      options.password = this.config.password
    }

    if (this.config.auth === 'microsoft') {
      info('[MC] 使用微软账号登录，首次运行需在终端完成浏览器授权')
    }

    this.bot = mineflayer.createBot(options)

    this._setupEvents()
    return this.bot
  }

  private _setupEvents (): void {
    if (!this.bot) return
    this._suppressProtocolErrors()

    this.bot.on('login', () => {
      const ver = this.bot!.version
      info(`[MC] Logged in as ${this.bot!.username} (协议 ${ver})`)
    })

    this.bot.on('spawn', () => {
      info('[MC] Bot spawned in world')
      this.isReady = true
      this.reconnectScheduled = false
      this._startKeepAliveMonitor()
      if (this.messageQueue) {
        this.messageQueue.setBot(this)
      }

      for (const callback of this.onSpawnCallbacks) {
        callback(this)
      }
    })

    this.bot.on('kicked', (reason) => {
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
      warn('[MC] Kicked:', reasonStr)
      this.isReady = false
      this._stopKeepAliveMonitor()
      this.acceptedResourcePacks.clear()
      setTimeout(() => this._handleReconnect(reasonStr.includes('spam') ? 'spam踢出' : '被踢出'), 1000)
    })

    this.bot.on('error', (err: NodeJS.ErrnoException) => {
      if (err.message && (err.message.includes('PartialReadError') ||
          err.message.includes('Read error') ||
          err.message.includes('resource_pack') ||
          err.message.includes('UUID') ||
          err.message.includes('configuration'))) {
        return
      }

      // 认证/profile 错误：微软 token 过期或 Mojang API 暂时不可用，自动重试
      if (err.message && (err.message.includes('Failed to obtain profile data') ||
          err.message.includes('profile data'))) {
        warn('[MC] 认证错误:', err.message)
        if (this.config.auth === 'microsoft') {
          warn('[MC] 微软账号 token 可能已过期，若持续失败请删除',
            this.config.profilesFolder || './mc-tokens',
            '后重新运行以重新授权')
        }
        this.isReady = false
        this._handleReconnect('认证失败')
        return
      }

      error('[MC] Error:', err.message)

      if (err.message.includes('fetch failed') || err.message.includes('Sign in failed')) {
        console.error('[MC] 登录失败提示:')
        console.error('  - 微软账号 (MC_AUTH=microsoft) 不需要填写 MC_PASSWORD')
        console.error('  - 删除 mc-tokens 目录后重新运行，在终端按提示完成浏览器授权')
        console.error('  - 若仍失败，检查网络是否能访问 Microsoft 登录服务')
      }

      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        this._handleReconnect('连接错误')
      }
    })

    this.bot.on('resourcePack', (url, hash) => {
      this._handleResourcePack(url, hash ?? '')
    })

    getBotClient(this.bot)?.on('add_resource_pack', (data: unknown) => {
      debug('[MC] add_resource_pack received')
      this._acceptResourcePackOnce(String((data as { uuid?: string }).uuid || ''))
    })

    getBotClient(this.bot)?.on('resource_pack_send', (data: unknown) => {
      debug('[MC] resource_pack_send received')
      this._acceptResourcePackOnce(String((data as { uuid?: string }).uuid || ''))
    })

    this.bot.on('end', (reason) => {
      warn('[MC] Disconnected:', reason)
      this.isReady = false
      this._stopKeepAliveMonitor()
      this.acceptedResourcePacks.clear()
      this._handleReconnect('连接断开')
    })
  }

  private _suppressProtocolErrors (): void {
    if (!this.bot) return
    const client = getBotClient(this.bot)
    if (!client) return

    client.on('error', (err: Error) => {
      if (err?.message) {
        const msg = err.message
        if (msg.includes('PartialReadError') ||
            msg.includes('Read error') ||
            msg.includes('protocol') ||
            msg.includes('decoder') ||
            msg.includes('parser') ||
            msg.includes('f32') ||
            msg.includes('intArray')) {
          return
        }
      }
    })

    if (client.socket) {
      client.socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.message) {
          const msg = err.message
          if (msg.includes('PartialReadError') ||
              msg.includes('read') ||
              msg.includes('ECONNRESET') ||
              msg.includes('EPIPE')) {
            return
          }
        }
      })
    }

    const originalEmit = client.emit.bind(client)
    client.emit = function (event: string, ...args: unknown[]) {
      if (event === 'error') {
        const err = args[0] as Error
        if (err?.message &&
            (err.message.includes('PartialReadError') ||
             err.message.includes('Read error') ||
             err.message.includes('f32'))) {
          return false
        }
      }
      return originalEmit(event, ...args)
    }
  }

  private _handleResourcePack (url: string, hash: { ascii?: string } | string): void {
    if (!this.bot) return
    debug('[MC] Resource pack received')
    const hashObj = typeof hash === 'object' ? hash : { ascii: String(hash) }
    const packKey = String(hashObj?.ascii || hash || url || '')

    if (packKey && this.acceptedResourcePacks.has(packKey)) {
      debug('[MC] Resource pack already accepted')
      return
    }

    try {
      const uuidStr = hashObj?.ascii ? hashObj.ascii : String(hash || '')
      debug('[MC] Pack UUID:', uuidStr)

      const statuses: Array<[string, number]> = [
        ['ACCEPTED', 3],
        ['DOWNLOADED', 4],
        ['SUCCESSFULLY_LOADED', 0]
      ]

      const client = getBotClient(this.bot)
      if (!client) return
      for (const [label, result] of statuses) {
        try {
          client.write('resource_pack_receive', {
            uuid: uuidStr,
            result: result
          })
          debug(`[MC] Resource pack ${label} sent`)
        } catch (err) {
          console.error(`[MC] Resource pack ${label} failed:`, (err as Error).message)
        }
      }

      if (packKey) {
        this.acceptedResourcePacks.add(packKey)
      }
      debug('[MC] Resource pack response completed')

      // If bot doesn't spawn within 30s of resource pack, force reconnect
      const spawnTimeout = setTimeout(() => {
        if (this.bot && !this.isReady) {
          console.log('[MC] Spawn timeout (30s), forcing reconnect...')
          this.acceptedResourcePacks.clear()
          try { this.bot?.end('spawn timeout') } catch { /* */ }
          this._handleReconnect('spawn超时')
        }
      }, 30000)
      this.bot.once('spawn', () => clearTimeout(spawnTimeout))
    } catch (err) {
      console.error('[MC] Resource pack error:', (err as Error).message)
    }
  }

  private _acceptResourcePackOnce (uuid: string): void {
    const key = String(uuid || '')
    if (key && this.acceptedResourcePacks.has(key)) {
      return
    }
    this._handleResourcePack('', uuid)
  }

  private _startKeepAliveMonitor (): void {
    this._stopKeepAliveMonitor()
    // 每 10s 检查距上次收到服务端包已多久。超过 15s 说明事件循环可能被阻塞
    // （路径规划、大量区块加载等会推迟 keep-alive 响应，导致服务端踢人）
    this.kaMonitor = setInterval(() => {
      if (!this.bot) return
      const botAny = this.bot as unknown as { _lastKeepAlive?: number }
      const lastKa = botAny._lastKeepAlive
      if (!lastKa) return
      const ago = Date.now() - lastKa
      if (ago > 15000) {
        warn(`[MC] ⚠ 距上次服务端包已 ${(ago / 1000).toFixed(0)}s，事件循环可能阻塞！`)
      }
    }, 10000)
    this.kaMonitor.unref?.()
  }

  private _stopKeepAliveMonitor (): void {
    if (this.kaMonitor) { clearInterval(this.kaMonitor); this.kaMonitor = null }
  }

  private _handleReconnect (reason: string): void {
    if (this.stopped) return
    if (this.reconnectScheduled) return
    this.reconnectScheduled = true
    this._stopKeepAliveMonitor()
    const delay = reason.includes('spam') ? 30000 : this.reconnectDelay
    warn(`[MC] ${reason} - 等待 ${delay / 1000} 秒后重连...`)

    setTimeout(() => {
      this.reconnectScheduled = false
      info('[MC] Reconnecting...')
      this.create()
    }, delay)
  }

  chat (message: string): boolean {
    if (!this.isReady || !this.bot) return false
    const normalized = message.trim()
    if (normalized === this.afkCommand) {
      this.setServerAfk(!this.serverAfk, 'AFK command queued')
    } else if (normalized) {
      // Any command/chat activity may make the server-side AFK plugin leave
      // AFK. Do not keep suppressing food after the bot becomes active again.
      this.setServerAfk(false, 'outgoing activity')
    }
    if (this.messageQueue) {
      this.messageQueue.enqueue(message)
    } else {
      this.bot.chat(message)
    }
    return true
  }

  whisper (username: string, message: string): boolean {
    if (!this.isReady || !this.bot) return false
    const full = `${this.whisperCommand} ${username} ${message}`
    if (this.messageQueue) {
      this.messageQueue.enqueue(full)
    } else {
      this.bot.chat(full)
    }
    return true
  }

  /** 队列专用：跳过消息队列，直接把消息发给服务器（由 MessageQueue 的 process 在间隔后调用） */
  sendRaw (message: string): void {
    if (this.isReady && this.bot) {
      try { this.bot.chat(message) } catch { /* */ }
    }
  }

  /** 当前请求的视距（区块）。供区块裁剪等外部模块使用。 */
  getViewDistance (): number {
    return this.currentViewDistance
  }

  /** Dynamically switch view distance (chunks). Sends settings packet to server. */
  setViewDistance (n: number): void {
    if (!this.isReady || !this.bot || this.currentViewDistance === n) return
    try {
      this.bot.setSettings({ viewDistance: n })
      this.currentViewDistance = n
      debug(`[MC] View distance → ${n}`)
    } catch { /* */ }
  }

  /** 破基岩模式开启/关闭。开启时视距固定 breakViewDistance() 并占住高位请求；关闭后按常规回落。 */
  setBreakViewActive (active: boolean): void {
    if (this.breakViewActive === active) return
    this.breakViewActive = active
    if (active) {
      this.setViewDistance(breakViewDistance())
    } else {
      this._dropToBaseView()
    }
  }

  /** Request high view distance. Called on jump/place/use/look. Auto-releases after 15s idle. */
  requestHighView (): void {
    if (this.highViewRequests === 0) {
      this.setViewDistance(this.breakViewActive ? breakViewDistance() : highViewDistance())
    }
    this.highViewRequests++
    this._resetHighViewTimer()
  }

  /** Release high view distance request. When all released, drops to base. */
  releaseHighView (): void {
    if (this.highViewRequests > 0) this.highViewRequests--
    if (this.highViewRequests <= 0) {
      this.highViewRequests = 0
      if (this.highViewTimer) { clearTimeout(this.highViewTimer); this.highViewTimer = null }
      this._dropToBaseView()
    }
  }

  /** 刷新高位保持定时器。连续高频调用（如跳跃循环）只会续期，不会造成计数泄漏。 */
  private _resetHighViewTimer (): void {
    if (this.highViewTimer) clearTimeout(this.highViewTimer)
    this.highViewTimer = setTimeout(() => {
      // 15 秒内无新请求 → 所有持有视为过期，直接归零回落，防止计数泄漏把视距永久钉在高位
      this.highViewRequests = 0
      this.highViewTimer = null
      this._dropToBaseView()
    }, 15000)
  }

  /** 无高位请求时的回落视距：破基岩模式保持 breakViewDistance()，否则回落 6。 */
  private _dropToBaseView (): void {
    this.setViewDistance(this.breakViewActive ? breakViewDistance() : 6)
  }
}
