const express = require('express')

class ApiServer {
  constructor (config, minecraftBot, whitelist) {
    this.config = config
    this.bot = minecraftBot
    this.whitelist = whitelist
    this.app = express()
    this.server = null

    this.app.use(express.json())
    this._setupAuth()
    this._setupRoutes()
  }

  _setupAuth () {
    this.app.use((req, res, next) => {
      const apiKey = req.headers['x-api-key']
      if (apiKey !== this.config.apiKey) {
        return res.status(401).json({ success: false, message: 'Unauthorized' })
      }
      next()
    })
  }

  _setupRoutes () {
    // 传送请求
    this.app.post('/api/tp', async (req, res) => {
      const { game_name } = req.body
      if (!game_name) {
        return res.status(400).json({ success: false, message: 'Missing game_name' })
      }

      // 检查白名单
      if (!this.whitelist.isAllowed(game_name)) {
        return res.json({ success: false, message: `${game_name} 不在白名单中` })
      }

      const result = await this.bot.tpa(game_name)
      res.json(result)
    })

    // 添加白名单
    this.app.post('/api/whitelist/add', async (req, res) => {
      const { game_name, added_by } = req.body
      if (!game_name) {
        return res.status(400).json({ success: false, message: 'Missing game_name' })
      }

      if (this.whitelist.isAllowed(game_name)) {
        return res.json({ success: false, message: `${game_name} 已在白名单中` })
      }

      await this.whitelist.add(game_name, added_by)
      res.json({ success: true, message: `已添加白名单: ${game_name}` })
    })

    // 移除白名单
    this.app.post('/api/whitelist/remove', async (req, res) => {
      const { game_name } = req.body
      if (!game_name) {
        return res.status(400).json({ success: false, message: 'Missing game_name' })
      }

      if (!this.whitelist.isAllowed(game_name)) {
        return res.json({ success: false, message: `${game_name} 不在白名单中` })
      }

      await this.whitelist.remove(game_name)
      res.json({ success: true, message: `已移除白名单: ${game_name}` })
    })

    // 查看白名单
    this.app.get('/api/whitelist/list', (req, res) => {
      const list = this.whitelist.list()
      res.json({ success: true, whitelist: list, count: this.whitelist.count() })
    })

    // 检查白名单
    this.app.get('/api/whitelist/check/:game_name', (req, res) => {
      const { game_name } = req.params
      const allowed = this.whitelist.isAllowed(game_name)
      const info = this.whitelist.get(game_name)
      res.json({ success: true, allowed, info })
    })

    // 机器人状态
    this.app.get('/api/status', (req, res) => {
      res.json({
        success: true,
        minecraft: this.bot.isReady,
        username: this.bot.bot?.username || null,
        uptime: process.uptime(),
        whitelist_count: this.whitelist.count()
      })
    })

    // 在线玩家
    this.app.get('/api/players', (req, res) => {
      if (!this.bot.isReady || !this.bot.bot) {
        return res.json({ success: false, message: '机器人未就绪' })
      }

      const players = Object.keys(this.bot.bot.players || {})
      res.json({ success: true, players, count: players.length })
    })

    // 发送公屏消息
    this.app.post('/api/say', async (req, res) => {
      const { message } = req.body
      if (!message) {
        return res.status(400).json({ success: false, message: 'Missing message' })
      }

      if (!this.bot.isReady) {
        return res.json({ success: false, message: '机器人未就绪' })
      }

      this.bot.chat(message)
      res.json({ success: true, message: '已发送消息' })
    })
  }

  start () {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        console.log(`[API] Server listening on port ${this.config.port}`)
        resolve()
      })
    })
  }

  stop () {
    if (this.server) {
      this.server.close()
    }
  }
}

module.exports = ApiServer
