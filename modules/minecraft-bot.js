const mineflayer = require('mineflayer')

class MinecraftBot {
  constructor (config) {
    this.config = config
    this.bot = null
    this.isReady = false
    this.acceptedResourcePacks = new Set()
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
    this.reconnectDelay = 5000
    this.messageQueue = null
  }

  setMessageQueue (queue) {
    this.messageQueue = queue
  }

  create () {
    console.log('[MC] Creating bot...')
    this.bot = mineflayer.createBot({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth,
      profilesFolder: this.config.profilesFolder,
      version: this.config.version || false,
      checkTimeoutInterval: this.config.checkTimeoutInterval || 300000,
      connectTimeout: 60000,
      keepAlive: true,
      skipValidation: true,
      hideErrors: true
    })

    this._setupEvents()
    return this.bot
  }

  _setupEvents () {
    this._suppressProtocolErrors()

    this.bot.on('login', () => {
      console.log(`[MC] Logged in as ${this.bot.username}`)
    })

    this.bot.on('spawn', () => {
      console.log('[MC] Bot spawned in world')
      this.isReady = true
      this.reconnectAttempts = 0
    })

    this.bot.on('kicked', (reason) => {
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log('[MC] Kicked:', reasonStr)
      this.isReady = false
    })

    this.bot.on('error', (err) => {
      if (err.message && (err.message.includes('PartialReadError') ||
          err.message.includes('Read error') ||
          err.message.includes('resource_pack') ||
          err.message.includes('UUID') ||
          err.message.includes('configuration'))) {
        return
      }
      console.error('[MC] Error:', err.message)

      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        this._handleReconnect('连接错误')
      }
    })

    this.bot.on('resourcePack', (url, hash) => {
      this._handleResourcePack(url, hash)
    })

    this.bot._client?.on('add_resource_pack', (data) => {
      console.log('[MC] add_resource_pack received')
      this._acceptResourcePackOnce(data.uuid)
    })

    this.bot._client?.on('resource_pack_send', (data) => {
      console.log('[MC] resource_pack_send received')
      this._acceptResourcePackOnce(data.uuid)
    })

    this.bot.on('end', (reason) => {
      console.log('[MC] Disconnected:', reason)
      this.isReady = false
      this._handleReconnect('连接断开')
    })
  }

  _suppressProtocolErrors () {
    if (!this.bot._client) return

    this.bot._client.on('error', (err) => {
      if (err && err.message) {
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

    if (this.bot._client.socket) {
      this.bot._client.socket.on('error', (err) => {
        if (err && err.message) {
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

    const originalEmit = this.bot._client.emit
    if (originalEmit) {
      this.bot._client.emit = function (event, ...args) {
        if (event === 'error') {
          const err = args[0]
          if (err && err.message &&
              (err.message.includes('PartialReadError') ||
               err.message.includes('Read error') ||
               err.message.includes('f32'))) {
            return false
          }
        }
        return originalEmit.apply(this, [event, ...args])
      }
    }
  }

  _handleResourcePack (url, hash) {
    console.log('[MC] Resource pack received')
    const packKey = String(hash?.ascii || hash || url || '')

    if (packKey && this.acceptedResourcePacks.has(packKey)) {
      console.log('[MC] Resource pack already accepted')
      return
    }

    try {
      const uuidStr = hash?.ascii ? hash.ascii : String(hash || '')
      console.log('[MC] Pack UUID:', uuidStr)

      const statuses = [
        ['ACCEPTED', 3],
        ['DOWNLOADED', 4],
        ['SUCCESSFULLY_LOADED', 0]
      ]

      for (const [label, result] of statuses) {
        try {
          this.bot._client.write('resource_pack_receive', {
            uuid: uuidStr,
            result: result
          })
          console.log(`[MC] Resource pack ${label} sent`)
        } catch (err) {
          console.error(`[MC] Resource pack ${label} failed:`, err.message)
        }
      }

      if (packKey) {
        this.acceptedResourcePacks.add(packKey)
      }
      console.log('[MC] Resource pack response completed')
    } catch (err) {
      console.error('[MC] Resource pack error:', err.message)
    }
  }

  _acceptResourcePackOnce (uuid) {
    const key = String(uuid || '')
    if (key && this.acceptedResourcePacks.has(key)) {
      return
    }
    this._handleResourcePack('', uuid)
  }

  _handleReconnect (reason) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log(`[MC] 已达到最大重连次数 (${this.maxReconnectAttempts})，停止重连`)
      return
    }

    this.reconnectAttempts++
    const delay = reason.includes('spam') ? 30000 : this.reconnectDelay
    console.log(`[MC] ${reason} - 第 ${this.reconnectAttempts}/${this.maxReconnectAttempts} 次重连，等待 ${delay / 1000} 秒...`)

    setTimeout(() => {
      console.log('[MC] Reconnecting...')
      this.create()
    }, delay)
  }

  async tpa (playerName) {
    if (!this.isReady) {
      return { success: false, message: '机器人未就绪' }
    }

    try {
      this.bot.chat(`/tpa ${playerName}`)
      console.log(`[MC] Sent /tpa ${playerName}`)
      return { success: true, message: `已向 ${playerName} 发送传送请求` }
    } catch (err) {
      console.error('[MC] TPA error:', err.message)
      return { success: false, message: `传送失败: ${err.message}` }
    }
  }

  chat (message) {
    if (!this.isReady) return
    this.bot.chat(message)
  }
}

module.exports = MinecraftBot
