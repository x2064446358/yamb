import { Vec3 } from 'vec3'
import type { BotBehaviorConfig, CommandConfig, MessagesConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type GameApiService from '../../api/game-service'
import type TeleportService from '../teleport/service'
import PhomeCommands from '../teleport/phome-commands'
import PhomeAdminCommands from '../teleport/phome-admin-commands'
import type Whitelist from '../../permissions/whitelist'
import type StandbyManager from '../standby/manager'
import type PlayerInteractionService from '../../actions/player'
import type HissModule from '../hiss'
import type MinecartInteractionService from '../../actions/minecart'
import type RidingManager from '../riding/manager'
import type ContainerRegistry from '../container/registry'
import ContainerCommands from '../container/commands'
import type InventoryActions from '../../actions/inventory'
import InventoryCommandModule from '../inventory'
import type SystemMessageBuffer from './system-buffer'
import type LoopCmd from '../loopcmd'
import type TimerModule from '../timer'
import CommandMessages from './messages'
import { sleep } from '../../platform/sleep'
import { info, warn, debug } from '../../platform/logger'
import { isMountedOnPlayer, approachEntity } from '../../actions/shared/entity-utils'
import {
  type CommandSource,
  matchesPrefix,
  normalizeInput,
  parsePrefixedArgs,
  parseWhisperCommand
} from './parser'
import type JumpModule from '../jump'
import type UseItemModule from '../useitem'
import type PlaceModule from '../place'
import type LookModule from '../look'
import { lookEnchant } from '../enchant'
import type BrewModule from '../brew'
import BrewNodeCommands from '../brew/node-commands'
import { reloadBot } from '../reload'

import type { DatabaseSync } from 'node:sqlite'

export default class CommandHandler {
  private mcBot: MinecraftBot
  private teleportService: TeleportService
  private gameApiService: GameApiService
  private playerInteraction: PlayerInteractionService
  private hissModule: HissModule
  private minecartInteraction: MinecartInteractionService
  private ridingManager: RidingManager
  private loopCmd: LoopCmd
  private timerModule: TimerModule
  private db: DatabaseSync
  private jumpModule: JumpModule
  private useItemModule: UseItemModule
  private placeModule: PlaceModule
  private lookModule: LookModule
  private botIndex: number
  /** 公屏 %挂机 认领：等待所有繁忙 bot 确认无人认领后，才回复"全部繁忙" */
  private static readonly TPA_ARBITRATION_MS = 3000
  /** 认领行 TTL：认领的 bot 崩溃/掉线后自动过期，玩家可重新申请 */
  private static readonly TPA_CLAIM_TTL_MS = 45000
  /** 认领结束后的宽限期：行保留一段时间，让繁忙 bot 的仲裁（3s）仍能看到"已有人处理过"，避免误报全部繁忙 */
  private static readonly TPA_RESOLVE_GRACE_MS = 10000
  /** 全部繁忙提示行 TTL */
  private static readonly TPA_BUSY_TTL_MS = 30000
  private phomeCommands: PhomeCommands
  private phomeAdminCommands: PhomeAdminCommands
  private containerRegistry: ContainerRegistry
  private containerCommands: ContainerCommands
  private inventoryCommand: InventoryCommandModule
  private systemBuffer: SystemMessageBuffer
  private whitelist: Whitelist
  private standby: StandbyManager
  private brewModule: BrewModule
  private brewNodeCommands: BrewNodeCommands
  /** brew 开始时的转场 tpa：传送完成后不锁定 */
  private brewTpaRelocate = false
  private messages: CommandMessages
  private prefix: string
  private adminList: Set<string>
  private allowPublicCommands: boolean
  private replyAlwaysWhisper: boolean
  private forwardWaitMs: number
  private interactionDistance: number
  private _lastCmd?: { key: string; time: number }

  constructor (
    mcBot: MinecraftBot,
    teleportService: TeleportService,
    gameApiService: GameApiService,
    playerInteraction: PlayerInteractionService,
    hissModule: HissModule,
    minecartInteraction: MinecartInteractionService,
    ridingManager: RidingManager,
    jumpModule: JumpModule,
    useItemModule: UseItemModule,
    placeModule: PlaceModule,
    lookModule: LookModule,
    loopCmd: LoopCmd,
    timerModule: TimerModule,
    db: DatabaseSync,
    containerRegistry: ContainerRegistry,
    inventoryActions: InventoryActions,
    systemBuffer: SystemMessageBuffer,
    whitelist: Whitelist,
    standby: StandbyManager,
    brewModule: BrewModule,
    config: CommandConfig,
    botConfig: BotBehaviorConfig,
    adminList: string[]
  ) {
    this.mcBot = mcBot
    this.teleportService = teleportService
    this.gameApiService = gameApiService
    this.playerInteraction = playerInteraction
    this.hissModule = hissModule
    this.minecartInteraction = minecartInteraction
    this.ridingManager = ridingManager
    this.jumpModule = jumpModule
    this.useItemModule = useItemModule
    this.placeModule = placeModule
    this.lookModule = lookModule
    // 破基岩放置（放置 <方块名>）启动时用"挂机同款"锁定，备注"破基岩"，并把视距固定到 8 保证追踪目标加载；
    // 停止时若锁是破基岩开的则解锁，视距回落
    placeModule.setOnBreakChange((active, owner) => {
      this.mcBot.setBreakViewActive(active)
      if (active) {
        if (!this.teleportService.isLocked()) {
          this.teleportService.lock(owner ?? 'bot', '破基岩')
        }
      } else if (this.teleportService.getLockedNote() === '破基岩') {
        this.teleportService.unlock()
      }
    })
    this.loopCmd = loopCmd
    this.timerModule = timerModule
    this.db = db
    this.botIndex = parseInt(process.env.BOT_INDEX || '1', 10)
    this.containerRegistry = containerRegistry
    this.systemBuffer = systemBuffer
    this.whitelist = whitelist
    this.standby = standby
    this.brewModule = brewModule
    this.prefix = config.prefix || '#ybot'
    this.messages = new CommandMessages(config.messages, this.prefix)
    this.phomeCommands = new PhomeCommands(
      teleportService,
      this.messages,
      this.reply.bind(this),
      this.isPhomeAllowed.bind(this)
    )
    this.phomeAdminCommands = new PhomeAdminCommands(
      db,
      teleportService,
      this.messages,
      this.reply.bind(this),
      this.isAdmin.bind(this),
      this.isPhomeSa.bind(this)
    )
    this.containerCommands = new ContainerCommands(
      mcBot,
      containerRegistry,
      this.messages,
      this.isAdmin.bind(this),
      this.reply.bind(this)
    )
    this.brewNodeCommands = new BrewNodeCommands(
      mcBot,
      inventoryActions,
      containerRegistry,
      brewModule,
      this.messages,
      this.isAdmin.bind(this),
      this.reply.bind(this),
      botConfig.interactionDistance,
      botConfig.approachDistance
    )
    this.inventoryCommand = new InventoryCommandModule(
      mcBot,
      inventoryActions,
      containerRegistry,
      this.messages,
      this.isAdmin.bind(this),
      this.reply.bind(this),
      botConfig.interactionDistance,
      botConfig.approachDistance
    )
    this.timerModule.setOnDone(timer => {
      const message = this.messages.text('timerDone', { label: timer.label, display: timer.display })
      try { this.mcBot.whisper(timer.username, message) } catch { /* best effort */ }
    })
    this.adminList = new Set(adminList)
    this.allowPublicCommands = config.allowPublicCommands
    this.replyAlwaysWhisper = config.replyAlwaysWhisper
    this.forwardWaitMs = botConfig.forwardWaitMs
    this.interactionDistance = botConfig.interactionDistance
  }

  getCommandMessages (): CommandMessages {
    return this.messages
  }

  isAdmin (username: string): boolean {
    return this.adminList.has(username)
  }

  /** 终端(console)输入使用的身份：优先第一个管理员 */
  private consoleAdminIdentity (): string {
    if (this.adminList.size > 0) return [...this.adminList][0]
    return 'console-admin'
  }

  isWhitelisted (username: string): boolean {
    return this.whitelist.isAllowed(username)
  }

  isBlacklisted (username: string): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM blacklist WHERE game_name = ?').get(username) as { ok: number } | undefined
    return row !== undefined
  }

  /** 酿酒权限：管理员始终可用；酿酒白名单成员可用（持久化在 brew_whitelist 表） */
  isBrewAllowed (username: string): boolean {
    if (this.isAdmin(username)) return true
    const row = this.db.prepare('SELECT 1 AS ok FROM brew_whitelist WHERE game_name = ?').get(username) as { ok: number } | undefined
    return row !== undefined
  }

  private tpaNotes = new Map<string, string>()

  /**
   * 标记认领已结束（成功/被拒/超时）：不删行，而是置 resolved=1 并保留宽限期，
   * 这样 3s 后才触发仲裁的繁忙 bot 依然能看到"已有人处理过"而保持静默。
   * 玩家再次申请时，空闲 bot 会先清掉 resolved 行再认领（见 _doTpa）。
   */
  private resolveClaim (player: string): void {
    try {
      this.db.prepare(
        'UPDATE tpa_claims SET resolved = 1, expires_at = ? WHERE player = ? AND kind = ?'
      ).run(Date.now() + CommandHandler.TPA_RESOLVE_GRACE_MS, player, 'claim')
    } catch { /* */ }
  }

  /**
   * 本 bot 无法服务公屏 %挂机（忙/被锁/不在白名单）时的仲裁：
   * 稍等片刻让空闲 bot 有机会认领；若仍无人认领说明全部繁忙，由"第一个"成功写入
   * busy 行的 bot 回复玩家，其余 bot 保持静默（靠主键去重）。
   */
  private scheduleAllBusyCheck (username: string, source: CommandSource, messageKey: keyof MessagesConfig): void {
    setTimeout(() => {
      try {
        this.db.prepare("DELETE FROM tpa_claims WHERE kind = 'busy' AND expires_at < ?").run(Date.now())
      } catch { /* */ }
      const claimed = this.db.prepare("SELECT 1 AS ok FROM tpa_claims WHERE player = ? AND kind = 'claim'").get(username) as { ok: number } | undefined
      if (claimed) return
      const now = Date.now()
      const res = this.db.prepare(
        "INSERT OR IGNORE INTO tpa_claims (player, kind, bot_index, note, claimed_at, expires_at) VALUES (?, 'busy', ?, NULL, ?, ?)"
      ).run(username, this.botIndex, now, now + CommandHandler.TPA_BUSY_TTL_MS)
      if (res.changes === 1) {
        void this.reply(username, this.messages.text(messageKey), source)
      }
    }, CommandHandler.TPA_ARBITRATION_MS)
  }

  handlePhomeResult(success: boolean, player: string): void {
    this.resolveClaim(player)
    if (this.teleportService.isPhomeActive()) {
      if (success) {
        const user = this.teleportService.phomeAccepted()
        this.reply(user, '传送成功', 'whisper').catch(() => {})
      } else {
        const user = this.teleportService.phomeRejected()
        this.reply(user, '传送被拒绝', 'whisper').catch(() => {})
      }
      return
    }
    // 非 phome 模式的拒绝 → 走通用 TPA 拒绝处理
    if (!success) {
      this.handleTpaFailed()
    }
  }

  handleTpaSuccess(player: string): void {
    // 挂机/tpahere 流程：传送完成后锁定。
    // phome 流程中 bot 用 /phome 传送到传送点的系统消息也会匹配到这里，忽略。
    if (this.teleportService.isPhomeActive()) return

    this.resolveClaim(player)
    const note = this.tpaNotes.get(player)
    this.tpaNotes.delete(player)
    // 酿酒转场 tpa：只传送不锁定，避免长期锁定影响陈化自动收取。
    if (this.brewTpaRelocate) {
      this.brewTpaRelocate = false
      this.teleportService.clearBusy()
      this.reply(player, '传送成功，开始酿酒', 'whisper').catch(() => {})
      return
    }
    this.teleportService.lock(player, note)
    this.teleportService.clearBusy()
    let msg = '传送成功'
    if (note) msg += ` | 备注: ${note}`
    this.reply(player, msg, 'whisper').catch(() => {})
  }

  private async _doTpa (username: string, source: CommandSource, note?: string, opts?: { publicClaim?: boolean }): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) return

    const publicClaim = opts?.publicClaim === true

    // 公屏 %挂机：被锁定的 bot 一律不响应（任何人，含锁定者本人），进入仲裁等待
    if (this.teleportService.isLocked()) {
      if (publicClaim) { this.scheduleAllBusyCheck(username, source, 'allBusy'); return }
      await this.reply(username, this.messages.text('lockedBlocked', { lockedBy: this.teleportService.getLockedBy() || '未知' }), source)
      return
    }

    if (this.teleportService.isCommandBusy()) {
      if (publicClaim) { this.scheduleAllBusyCheck(username, source, 'allBusy'); return }
      await this.reply(username, this.messages.text('tpaBusy'), source)
      return
    }

    if (!this.isWhitelisted(username) && !this.isAdmin(username)) {
      if (publicClaim) { this.scheduleAllBusyCheck(username, source, 'notWhitelisted'); return }
      await this.reply(username, this.messages.text('notWhitelisted'), source)
      return
    }

    // 原子认领：多 bot 同时收到公屏指令时，只有 INSERT OR IGNORE 成功的一方会真正发 /tpa
    if (source !== 'console') {
      const now = Date.now()
      try {
        this.db.prepare('DELETE FROM tpa_claims WHERE expires_at < ?').run(now)
        // 清掉该玩家已结束（宽限期内）的认领行，允许重新认领；仍在处理中的行不会被清除
        this.db.prepare("DELETE FROM tpa_claims WHERE player = ? AND kind = 'claim' AND resolved = 1").run(username)
      } catch { /* */ }
      const res = this.db.prepare(
        "INSERT OR IGNORE INTO tpa_claims (player, kind, bot_index, note, claimed_at, expires_at) VALUES (?, 'claim', ?, ?, ?, ?)"
      ).run(username, this.botIndex, note || null, now, now + CommandHandler.TPA_CLAIM_TTL_MS)
      if (res.changes !== 1) {
        debug(`[Claim] Bot${this.botIndex} 已有人认领 ${username}，放弃`)
        return
      }
      debug(`[Claim] Bot${this.botIndex} 认领成功: ${username}`)
    }

    this.teleportService.setBusy(username)
    if (note) this.tpaNotes.set(username, note)
    this.mcBot.chat(`/tpa ${username}`)
    await this.reply(username, this.messages.text('tpaRequestSent'), source)
  }

  handleTpaFailed(): void {
    const user = this.teleportService.getBusyUser()
    this.teleportService.clearBusy()
    if (user) {
      this.resolveClaim(user)
      const note = this.tpaNotes.get(user)
      this.tpaNotes.delete(user)
      if (note) {
        this.reply(user, `传送请求已被从 ${note} 拒绝`, 'whisper').catch(() => {})
      } else {
        this.reply(user, this.messages.text('tpaRejected'), 'whisper').catch(() => {})
      }
    }
  }

  private useWhisperReply (source: CommandSource): boolean {
    return this.replyAlwaysWhisper || source === 'whisper'
  }

  async reply (username: string, message: string, source: CommandSource): Promise<void> {
    const text = message.replace(/\n/g, ' | ')
    if (!text.trim()) return
    // Console sends directly to terminal, not via whisper
    if (source === 'console') {
      info(`[Reply] ${text}`)
      return
    }
    const maxLen = 240
    const whisper = this.useWhisperReply(source)
    if (text.length <= maxLen) {
      const ok = whisper ? this.mcBot.whisper(username, text) : this.mcBot.chat(text)
      if (!ok) {
        warn(`[Command] 回复失败 -> ${username}: ${text}`)
      }
      return
    }
    // Chunk long messages to avoid kick
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break }
      let cut = maxLen
      while (cut > 0 && remaining[cut] !== ' ' && remaining[cut] !== ',') cut--
      if (cut === 0) cut = maxLen
      chunks.push(remaining.slice(0, cut))
      remaining = remaining.slice(cut).trim()
    }
    for (const chunk of chunks) {
      const ok = whisper ? this.mcBot.whisper(username, chunk) : this.mcBot.chat(chunk)
      if (!ok) warn(`[Command] 回复失败 -> ${username}: ${chunk}`)
    }
  }

  // Commands that are whisper-only (not allowed in public chat)
  private static PUBLIC_DISALLOWED = new Set([
    '丢弃', '丢弃全部', '手持', 'drop', 'dropall', 'hold',
    'inv', 'store', 'take', 'container'
  ])

  async handle (username: string, message: string, source: CommandSource): Promise<void> {
    // 终端(console)输入自动获得管理员权限：以管理员身份执行
    if (source === 'console') {
      username = this.consoleAdminIdentity()
    }

    if (source !== 'console' && username === this.mcBot.bot?.username) return

    if (this.isBlacklisted(username)) return

    const text = normalizeInput(message)
    if (!text) return
    // Numbered phome commands use the configured public prefix (for example !1).
    // Plain numbers are still accepted for whisper/console input.
    const phomeText = text.startsWith(this.prefix) ? text.slice(this.prefix.length).trim() : text
    const isPhomeNum = /^\d+$/.test(phomeText)
    const requestedText = source === 'console' && text.startsWith(this.prefix)
      ? text.slice(this.prefix.length).trim()
      : text
    const requestedCommand = source === 'chat' && matchesPrefix(text, this.prefix)
      ? (parsePrefixedArgs(text, this.prefix)[0]?.toLowerCase() || '')
      : (requestedText.split(/\s+/)[0]?.toLowerCase() || '')
    const isPhomeCommand = isPhomeNum || requestedCommand === 'phome'
    // sp 是紧急停止指令，所有未被拉黑的玩家都可以使用。
    const isHissStop = requestedCommand === 'sp'
    if (source !== 'console' && !isHissStop && !isPhomeCommand && !this.isWhitelisted(username) && !this.isAdmin(username) && !this.isBrewAllowed(username)) return
    // [DEBUG handle] — enable with VERBOSE=true

    // Lock check: only locked player and admins can control bot
    if (this.teleportService.isLocked() && !isPhomeCommand) {
      const cmd = requestedCommand
      const allowedCmds = ['状态', '状态2', '状态3', 'status', 'status2', 'status3', '挂机', '0', '跳跃', 'xjump', '改锁定', 'sp']
      if (username !== this.teleportService.getLockedBy() && !this.isAdmin(username) && !allowedCmds.includes(cmd)) {
        if (cmd === '解锁' || cmd === 'unlock') {
          await this.reply(username, this.messages.text('lockedCannotUnlock', { lockedBy: this.teleportService.getLockedBy() || '未知' }), source)
        }
        return
      }
    }

    let parts: string[] | null = null

    if (source === 'console') {
      // Console input: strip prefix if present, split, process as command
      const clean = text.startsWith(this.prefix) ? text.slice(this.prefix.length).trim() : text
      if (!clean) { await this.reply(username, this.messages.text('emptyCommand'), source); return }
      parts = clean.split(/\s+/)
    } else if (source === 'whisper') {
      parts = parseWhisperCommand(text)
      if (!parts) return
    } else {
      if (!this.allowPublicCommands) return
      if (!matchesPrefix(text, this.prefix)) return
      const args = parsePrefixedArgs(text, this.prefix)
      if (args.length === 0) {
        await this.reply(username, this.messages.text('emptyCommand'), source)
        this.standby.scheduleAfk()
        return
      }
      parts = args
      // Block whisper-only commands from public chat
      const pubCmd = (parts[0] || '').toLowerCase()
      if (CommandHandler.PUBLIC_DISALLOWED.has(pubCmd)) return
    }

    const dedupeKey = `${source}:${username}:${text}`
    const now = Date.now()
    if (this._lastCmd?.key === dedupeKey && now - this._lastCmd.time < 2000) return
    this._lastCmd = { key: dedupeKey, time: now }

    this.standby.touch()

    let cmd = (parts.shift() || '').toLowerCase()

    // Support two-word commands like "查 附魔", "指令 循环", "右键 玩家"
    if (parts.length > 0) {
      const cmd2 = cmd + ' ' + parts[0].toLowerCase()
      if (['查 附魔', '指令 循环', '加phome 白名单', '移除phome 白名单', 'phome 白名单列表', '加phome 超管', '移除phome 超管', 'phome 超管列表'].includes(cmd2)) {
        parts.shift()
        cmd = cmd2
      }
    }

    debug(`[Command:${source}] ${username} -> ${cmd} ${parts.join(' ')}`.trim())

    // 酿酒期间仅放行 brew/status/help，避免打断流水线。
    if (this.brewModule.isRunning()) {
      const brewAllowed = new Set(['brew', '酿酒', 'status', '状态', '状态2', '状态3', 'help', '帮助', '定时', 'sp'])
      if (!brewAllowed.has(cmd)) {
        const numMatch = cmd.match(/^(\d+)$/)
        if (numMatch || cmd === 'phome') {
          const num = numMatch ? parseInt(numMatch[1], 10) : -1
          // 被锁定的 bot（如陈化锁定）不拦截 phome 数字命令，放行给 phome 模块走委托/锁定流程；
          // 未锁定的活跃酿酒才拦截：只有归属 bot（或主 bot 的列表）回复"酿酒中"，delegate/无关 bot 保持静默
          if (!this.teleportService.isLocked()) {
            const aliasIndex = cmd === 'phome'
              ? this.teleportService.listWaypoints().findIndex(waypoint => waypoint.alias === parts.join(' ').trim())
              : -1
            const shouldReply = cmd === 'phome'
              ? aliasIndex >= 0 && this.teleportService.isOwned(aliasIndex)
              : num === 0
                ? this.teleportService.isMainBot()
                : this.teleportService.isOwned(num - 1)
            if (shouldReply) {
              await this.reply(username, 'bot 正在酿酒，请稍后（brew status 可查看进度）', source)
            }
            return
          }
        } else {
          await this.reply(username, 'bot 正在酿酒，请稍后（brew status 可查看进度）', source)
          return
        }
      }
    }

    switch (cmd) {
      // === Teleport ===
      case '挂机':
        await this._doTpa(username, source, parts.length > 0 ? parts.join(' ') : undefined, { publicClaim: source === 'chat' })
        break

      // === Mount ===
      case '坐':
      case 'mount':
        await this._mount(username, parts[0], source)
        break
      case '下车':
      case 'unmount':
        await this._dismountCmd(username, source)
        break
      case '蹲下':
        await this._sneakCmd(username, source)
        break
      case '上车':
        await this._cart(username, source)
        break

      // === Combat ===
      case 'attack':
        await this._attack(username, parts[0], source)
        break
      case '哈气':
        await this._hiss(username, parts[0], source)
        break
      case '对':
        if (parts.length >= 2 && parts[1] === '哈气') {
          await this._hiss(username, parts[0], source)
        } else {
          await this.reply(username, this.messages.text('hissUsage'), source)
        }
        break
      case 'sp':
        await this._stopHiss(username, source)
        break

      // === Lock ===
      case '锁定':
        await this._lock(username, source, parts[0])
        break
      case '解锁':
        await this._unlock(username, source)
        break
      case '改锁定':
        await this._transferLock(username, parts[0], source)
        break
      case '解锁all':
        await this._unlockAll(username, source)
        break

      // === Status ===
      case '状态':
      case 'status':
      case '状态2':
      case 'status2':
      case '状态3':
      case 'status3':
        await this._status(username, source, cmd)
        break

      // === Whitelist ===
      case '加白名单':
        await this._add(username, parts[0], source)
        break
      case '移除白名单':
        await this._remove(username, parts[0], source)
        break
      case '白名单列表':
        await this._wlList(username, source)
        break

      // === Phome Whitelist ===
      case '加phome白名单':
      case '加phome 白名单':
        await this.phomeAdminCommands.whitelistAdd(username, parts[0], source)
        break
      case '移除phome白名单':
      case '移除phome 白名单':
        await this.phomeAdminCommands.whitelistRemove(username, parts[0], source)
        break
      case 'phome白名单列表':
      case 'phome 白名单列表':
        await this.phomeAdminCommands.whitelistList(username, source)
        break

      // === Phome SuperAdmin ===
      case '加phome超管':
      case '加phome 超管':
        await this.phomeAdminCommands.superAdminAdd(username, parts[0], source)
        break
      case '移除phome超管':
      case '移除phome 超管':
        await this.phomeAdminCommands.superAdminRemove(username, parts[0], source)
        break
      case 'phome超管列表':
      case 'phome 超管列表':
        await this.phomeAdminCommands.superAdminList(username, source)
        break

      // === Phome Points ===
      case '加phome点':
        await this.phomeAdminCommands.pointAdd(username, parts, source)
        break
      case '移除phome点':
        await this.phomeAdminCommands.pointRemove(username, parts[0], source)
        break

      // === Blacklist ===
      case '加黑':
        await this._blacklistAdd(username, parts[0], source)
        break

      // === Brew Whitelist ===
      case '加酿酒白名单':
        await this._brewWlAdd(username, parts[0], source)
        break
      case '移除酿酒白名单':
        await this._brewWlRemove(username, parts[0], source)
        break
      case '酿酒白名单列表':
        await this._brewWlListCmd(username, source)
        break

      // === Inventory ===
      case 'inv':
        await this.inventoryCommand.inventory(username, source)
        break
      case 'store':
        await this.inventoryCommand.store(username, parts, source)
        break
      case 'take':
        await this.inventoryCommand.take(username, parts, source)
        break
      case '丢弃':
        await this.inventoryCommand.drop(username, parts, source)
        break
      case '丢弃全部':
        await this.inventoryCommand.dropAll(username, source)
        break
      case '手持':
        await this.inventoryCommand.hold(username, parts.join(' '), source)
        break

      // === Item Actions ===
      case '使用':
        this.mcBot.requestHighView()
        await this._useItem(username, parts.join(' '), source)
        break
      case '放置':
      case 'place':
        this.mcBot.requestHighView()
        await this._placeBlock(username, parts.join(' '), source)
        break
      case 'look':
        this.mcBot.requestHighView()
        await this._lookAt(username, parts, source)
        break
      case '看向':
        this.mcBot.requestHighView()
        await this._lookAtCoord(username, parts, source)
        break
      case '装水':
      case 'fillwater':
        await this._waterFill(username, parts[0], source)
        break

      // === Jump ===
      case '跳跃':
      case 'xjump':
        this.mcBot.requestHighView()
        await this._jumpCmd(username, parts, source)
        break

      // === Enchant ===
      case '查 附魔':
        await this._enchantInfo(username, parts.join(' '), source)
        break

      // === Help ===
      case 'help':
      case '帮助':
        await this._help(username, source, parts[0])
        break

      // === Execute ===
      case '指令':
        await this._execCmd(username, parts.join(' '), source)
        break
      case '指令循环':
      case '指令 循环':
        await this._loopCmd(username, parts, source)
        break

      // === Reload (terminal only) ===
      case '重载':
      case 'reload':
        await reloadBot(source, this.reply.bind(this))
        break

      // === Interaction ===
      // === Container ===
      case 'container':
        await this.containerCommands.handle(username, parts, source)
        break

      // === Brew ===
      case 'brew':
      case '酿酒':
        await this._brew(username, parts, source)
        break

      // === 定时（倒计时提醒，不锁定）===
      case '定时':
        await this._timerCmd(username, parts, source)
        break

      // === Brew Node (方块登记) ===
      case 'node':
        await this.brewNodeCommands.handle(username, parts, source)
        break

      // === Say/Forward (admin) ===
      case 'say':
        await this._say(username, parts.join(' '), source)
        break
      case 'forward':
        await this._forward(username, parts.join(' '), source)
        break


      // === Numbered Phome ===
      case 'phome':
        if (parts.length === 0) {
          await this.reply(username, this.messages.text('phomeUsage', {
            waypoints: this.teleportService.getPhomeListText()
          }), source)
        } else {
          await this.phomeCommands.handleAlias(username, parts.join(' '), source)
        }
        break
      default:
        const numMatch = cmd.match(/^(\d+)$/)
        if (numMatch) {
          const num = parseInt(numMatch[1], 10)
          await this.phomeCommands.handleNumber(username, num, source)
          break
        }
        await this.reply(username, this.messages.text('unknownCommand', { cmd }), source)
    }

    this.standby.scheduleAfk()
  }

  private latelanMembers = new Set<string>()

  /** 添加拉特兰成员，同时持久化到 DB */
  addLatelanMember(username: string): void {
    if (!this.latelanMembers.has(username)) {
      this.latelanMembers.add(username)
      try {
        this.db.exec("CREATE TABLE IF NOT EXISTS latelan_members (game_name TEXT PRIMARY KEY)")
        this.db.prepare('INSERT OR IGNORE INTO latelan_members (game_name) VALUES (?)').run(username)
      } catch { /* */ }
      debug(`[Phome] 拉特兰成员: ${username}`)
    }
  }

  /** 从 DB 恢复拉特兰成员列表（启动 + 重连 spawn 后调用） */
  restoreLatelanMembers(): void {
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS latelan_members (game_name TEXT PRIMARY KEY)")
      const rows = this.db.prepare('SELECT game_name FROM latelan_members').all() as Array<{ game_name: string }>
      for (const row of rows) {
        if (!this.latelanMembers.has(row.game_name)) {
          this.latelanMembers.add(row.game_name)
        }
      }
      if (this.latelanMembers.size > 0) {
        debug(`[Phome] 从 DB 恢复 ${this.latelanMembers.size} 名拉特兰成员`)
      }
    } catch { /* */ }
  }

  private isPhomeAllowed (username: string): boolean {
    if (this.latelanMembers.has(username)) return true
    const row = this.db.prepare('SELECT 1 AS ok FROM phome_whitelist WHERE game_name = ?').get(username) as { ok: number } | undefined
    return row !== undefined
  }

  private isPhomeSa (username: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM phome_whitelist WHERE game_name = ? AND level = 'sa'").get(username) as { ok: number } | undefined
    return row !== undefined
  }

  private async _mount (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) return
    if (this.hissModule.isActive()) {
      await this.reply(username, 'bot \u6b63\u5728\u54c8\u6c14\u8ffd\u51fb\uff0c\u8bf7\u5148\u4f7f\u7528 sp \u505c\u6b62\u54c8\u6c14\u3002', source)
      return
    }
    const targetName = target?.trim() || username

    // Find player entity
    let entity = bot.players[targetName]?.entity
    if (!entity) {
      for (const [, e] of Object.entries(bot.entities)) {
        if (e?.type !== 'player' || e === bot.entity || (e as { username?: string }).username === bot.username) continue
        const dist = bot.entity.position.distanceTo(e.position)
        if (dist > 32) continue
        if ((e as { username?: string }).username?.toLowerCase() === targetName.toLowerCase()) { entity = e; break }
      }
    }
    if (!entity) { await this.reply(username, this.messages.text('mountNoPlayerNear', { target: targetName }), source); return }

    try {
      if (this.ridingManager.isActive()) {
        await this.ridingManager.dismount()
        await sleep(300)
      }

      // Walk to a loaded player within the remount seek range.
      const approach = await approachEntity(bot, entity, this.interactionDistance, 32)
      if (!approach.success) {
        await this.reply(username, this.messages.text('cannotApproach', { target: targetName, message: approach.message || '' }), source)
        return
      }
      // Refresh entity after moving
      entity = bot.players[targetName]?.entity ?? entity

      await bot.unequip('hand')
      await bot.lookAt(entity.position.offset(0, 1.6, 0), true)
      bot.activateEntityAt(entity, entity.position.offset(0, 1.6, 0))
      this.ridingManager.enterPlayerMode(targetName)

      // Wait and verify mount succeeded
      await sleep(800)
      if (isMountedOnPlayer(bot, targetName)) {
        await this.reply(username, this.messages.text('mounted', { target: targetName }), source)
        this.mcBot.sendAfk()
      } else {
        this.ridingManager.clearMode()
        await this.reply(username, this.messages.text('mountFailed'), source)
      }
    } catch (err) {
      this.ridingManager.clearMode()
      await this.reply(username, this.messages.text('mountFailedDetail', { message: (err as Error).message }), source)
    }
  }

  private async _cart (username: string, source: CommandSource): Promise<void> {
    if (this.hissModule.isActive()) {
      await this.reply(username, 'bot \u6b63\u5728\u54c8\u6c14\u8ffd\u51fb\uff0c\u8bf7\u5148\u4f7f\u7528 sp \u505c\u6b62\u54c8\u6c14\u3002', source)
      return
    }
    const ridingTarget = this.ridingManager.getTargetPlayer()
    if (
      this.ridingManager.getMode() === 'player' &&
      ridingTarget &&
      !this.playerInteraction.isMountedOn(ridingTarget)
    ) {
      this.ridingManager.clearMode()
    }

    const result = await this.minecartInteraction.boardNearest()
    if (result.success) {
      this.ridingManager.enterMinecartMode()
    }
    await this.reply(username, result.success
      ? this.messages.text('cartSuccess', { message: result.message || '已上车' })
      : this.messages.text('cartError', { message: result.message || '上车失败' }), source)
  }

  private async _dismountCmd (username: string, source: CommandSource): Promise<void> {
    const result = await this.ridingManager.dismount()
    if (!result.success) {
      await this.reply(username, this.messages.text('unmountError', { message: result.message }), source)
      return
    }
    await this.reply(username, this.messages.text('unmounted'), source)
  }

  private async _sneakCmd (username: string, source: CommandSource): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) return
    const wasSneaking = bot.getControlState('sneak')
    if (wasSneaking) {
      bot.setControlState('sneak', false)
      await this.reply(username, this.messages.text('stoodUp'), source)
    } else {
      bot.setControlState('sneak', true)
      await this.reply(username, this.messages.text('crouched'), source)
    }
  }

  private async _attack (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    const targetName = target?.trim() || username
    const result = await this.playerInteraction.attack(targetName)
    await this.reply(username, result.success
      ? this.messages.text('attackSuccess', { message: result.message || '已攻击' })
      : this.messages.text('attackError', { message: result.message || '攻击失败' }), source)
  }

  private async _hiss (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }

    if (this.ridingManager.isActive()) {
      await this.reply(username, 'bot \u5f53\u524d\u6b63\u5728\u9a91\u4e58\uff0c\u8bf7\u5148\u4e0b\u8f66\u540e\u518d\u54c8\u6c14\u3002', source)
      return
    }
    if (this.jumpModule.isActive()) {
      await this.reply(username, 'bot \u5f53\u524d\u6b63\u5728\u8df3\u8dc3\uff0c\u8bf7\u5148\u505c\u6b62\u8df3\u8dc3\u540e\u518d\u54c8\u6c14\u3002', source)
      return
    }
    if (this.placeModule.isActive()) {
      await this.reply(username, 'bot \u5f53\u524d\u6b63\u5728\u653e\u7f6e\uff0c\u8bf7\u5148\u505c\u6b62\u653e\u7f6e\u540e\u518d\u54c8\u6c14\u3002', source)
      return
    }
    if (this.useItemModule.isActive()) {
      await this.reply(username, 'bot \u5f53\u524d\u6b63\u5728\u4f7f\u7528\u7269\u54c1\uff0c\u8bf7\u5148\u6267\u884c \u4f7f\u7528 \u505c\u6b62\u540e\u518d\u54c8\u6c14\u3002', source)
      return
    }

    const targetName = target?.trim()
    if (!targetName) {
      await this.reply(username, this.messages.text('hissUsage'), source)
      return
    }
    if (targetName === this.mcBot.bot?.username) {
      await this.reply(username, '不能对 bot 自己哈气。', source)
      return
    }
    if (this.teleportService.isLocked() && this.teleportService.getLockedNote() !== '哈气') {
      await this.reply(username, 'bot 当前被其他任务锁定，无法开始哈气。', source)
      return
    }

    // 目标会在 bot 开始移动前收到警告，可由任何玩家用 sp 随时终止。
    this.mcBot.whisper(targetName, this.messages.text('hissWarn', { owner: username }))
    const result = await this.hissModule.start(targetName, (stoppedTarget, reason) => {
      this.onHissStopped(username, stoppedTarget, reason)
    })
    if (!result.success) {
      await this.reply(username, `哈气启动失败: ${result.message || '未知错误'}`, source)
      return
    }

    this.teleportService.lock(username, '哈气')
    await this.reply(username, this.messages.text('hissStarted', { target: targetName }), source)
  }

  private async _stopHiss (username: string, source: CommandSource): Promise<void> {
    const targetName = this.hissModule.stop()
    if (!targetName) {
      // A process restart cannot resume the in-memory hiss task, but its
      // persistent teleport lock may still exist. Let sp repair that stale
      // state instead of incorrectly reporting that nothing can be stopped.
      if (this.teleportService.getLockedNote() === '哈气') {
        this.teleportService.unlock()
        await this.reply(username, this.messages.text('hissStaleCleared'), source)
        return
      }
      await this.reply(username, this.messages.text('hissNotActive'), source)
      return
    }
    this.mcBot.whisper(targetName, '哈气追击已停止。')
    await this.reply(username, this.messages.text('hissStopped', { target: targetName }), source)
  }

  private onHissStopped (
    owner: string,
    targetName: string,
    reason: 'stopped' | 'target_lost' | 'bot_unavailable' | 'replaced' | 'riding' | 'error'
  ): void {
    if (this.teleportService.getLockedNote() === '哈气') this.teleportService.unlock()
    if (reason === 'stopped') return

    const reasonText: Record<Exclude<typeof reason, 'stopped'>, string> = {
      target_lost: '目标离线或离开视距超过 15 秒',
      bot_unavailable: '机器人已断开',
      replaced: '被新的哈气目标替换',
      riding: '\u54c8\u6c14\u8ffd\u51fb\u65f6\u8fdb\u5165\u9a91\u4e58\u72b6\u6001',
      error: '追击发生异常'
    }
    this.mcBot.whisper(owner, this.messages.text('hissEnded', {
      target: targetName,
      reason: reasonText[reason]
    }))
  }

  private async _brew (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isBrewAllowed(username)) {
      await this.reply(username, this.messages.text('brewNotAllowed'), source)
      return
    }
    const sub = (parts.shift() || '').toLowerCase()
    const phaseNames: Record<string, string> = {
      checking: '检查',
      fermenting: '投料',
      waiting: '等待发酵',
      bottling: '装瓶',
      'distillery-loading': '装载蒸馏',
      distilling: '蒸馏中',
      'distillery-unloading': '取出蒸馏',
      storing: '入库'
    }

    switch (sub) {
      case 'start':
      case '开始': {
        const recipe = parts[0]
        if (!recipe) {
          await this.reply(username, this.messages.text('brewUsage'), source)
          return
        }
        // bot 离酒庄较远时先 tpa 到发起者，到达后再开酿
        if (!this.brewModule.isRunning()) {
          const relocated = await this._relocateForBrew(username, source)
          if (!relocated) return
        }
        const result = await this.brewModule.start(
          recipe,
          async message => this.reply(username, message, source),
          username
        )
        await this.reply(
          username,
          result.success
            ? result.queued ? result.message || '已加入酿酒队列' : this.messages.text('brewStarted', { recipe })
            : result.message || this.messages.text('brewBusy'),
          source
        )
        break
      }

      case 'queue':
      case '队列': {
        const action = (parts.shift() || '').toLowerCase()
        if (action === 'clear' || action === '清空') {
          const count = this.brewModule.clearQueue()
          await this.reply(username, count > 0 ? `已清空 ${count} 个酿酒队列任务` : '酿酒队列为空', source)
          break
        }
        if (action === 'delete' || action === 'remove' || action === '删除' || action === '移除') {
          const position = Number(parts.shift())
          const result = this.brewModule.removeQueueItem(position)
          await this.reply(username, result.message || '删除队列失败', source)
          break
        }
        if (!action) {
          const queue = this.brewModule.status().queue || []
          await this.reply(username, queue.length > 0 ? queue.join('\n') : '酿酒队列为空', source)
          break
        }
        if (!this.brewModule.isRunning()) {
          const relocated = await this._relocateForBrew(username, source)
          if (!relocated) return
        }
        const result = await this.brewModule.start(
          action,
          async message => this.reply(username, message, source),
          username
        )
        await this.reply(username, result.message || (result.success ? '已加入酿酒队列' : this.messages.text('brewBusy')), source)
        break
      }

      case 'status':
      case '状态': {
        const status = this.brewModule.status()
        const agingLines = status.aging ?? []
        const queueLines = status.queue ?? []
        if (!status.running) {
          if (agingLines.length > 0 || queueLines.length > 0) {
            await this.reply(username, [
              this.messages.text('brewStatusIdle'),
              ...agingLines,
              ...queueLines
            ].join('\n'), source)
            return
          }
          await this.reply(username, this.messages.text('brewStatusIdle'), source)
          return
        }
        const phaseText = phaseNames[status.phase ?? ''] ?? status.phase ?? '-'
        const lines = [
          this.messages.text('brewStatusRunning', {
            recipe: status.recipe || '-',
            phase: phaseText,
            status: status.detail || phaseText
          }),
          ...agingLines,
          ...queueLines
        ]
        await this.reply(username, lines.join('\n'), source)
        break
      }

      case 'reload':
      case '重载': {
        if (!this.isAdmin(username)) {
          await this.reply(username, this.messages.text('noPermission'), source)
          return
        }
        const result = this.brewModule.reloadRecipes()
        await this.reply(username, result.message || '重新加载配方失败', source)
        break
      }

      case 'aging-stop':
      case '陈化停止':
      case '停止陈化': {
        const rawPosition = parts.shift()
        const position = rawPosition === undefined ? undefined : Number(rawPosition)
        const result = await this.brewModule.stopAging(position)
        if (result.invalidPosition) {
          await this.reply(username, this.messages.text('brewAgingStopNotFound', { position: rawPosition || '-' }), source)
          break
        }
        await this.reply(
          username,
          result.stopped > 0
            ? this.messages.text('brewAgingStopped', { count: result.stopped })
            : this.messages.text('brewAgingIdle'),
          source
        )
        break
      }

      case 'cancel':
      case '取消':
        await this.reply(
          username,
          this.brewModule.cancel()
            ? this.messages.text('brewCancelRequested')
            : this.messages.text('brewStatusIdle'),
          source
        )
        break

      case 'stop':
      case '停止':
        await this.reply(
          username,
          await this.brewModule.stop()
            ? this.messages.text('brewStopped')
            : this.messages.text('brewStatusIdle'),
          source
        )
        break

      default:
        await this.reply(username, this.messages.text('brewUsage'), source)
    }
  }

  /** brew 开始时：bot 离酒庄较远则 tpa 到发起者，等待传送完成；返回 false 表示取消开酿 */
  private async _relocateForBrew (username: string, source: CommandSource): Promise<boolean> {
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) return true
    if (this.teleportService.isLocked() || this.teleportService.isCommandBusy()) return true

    const fermenter = this.containerRegistry.list(this.brewModule.getGroup())
      .find(n => n.blockType === 'Fermenter')
    if (!fermenter) return true

    const target = new Vec3(fermenter.x + 0.5, fermenter.y + 0.5, fermenter.z + 0.5)
    const start = bot.entity.position
    if (start.distanceTo(target) <= 40) return true

    this.brewTpaRelocate = true
    this.mcBot.chat(`/tpa ${username}`)
    await this.reply(
      username,
      `bot 距酒庄较远 (${start.distanceTo(target).toFixed(1)} 格)，已向 ${username} 发送 tpa，到达后自动开酿`,
      source
    )

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await sleep(500)
      if (bot.entity.position.distanceTo(start) > 3) break
    }
    this.brewTpaRelocate = false
    await sleep(500)

    if (bot.entity.position.distanceTo(target) > 40) {
      await this.reply(username, '传送未到达酒庄附近，酿酒流程可能因距离过远失败', source)
    }
    return true
  }

  private async _lock (username: string, source: CommandSource, arg?: string): Promise<void> {
    if (this.teleportService.isLocked()) {
      const lockedBy = this.teleportService.getLockedBy()
      await this.reply(username, this.messages.text('alreadyLocked', { lockedBy: lockedBy ?? '未知' }), source)
      return
    }

    const mode = (arg || '').toLowerCase().trim()
    if (mode && mode !== '滞空') {
      await this.reply(username, this.messages.text('lockUsage'), source)
      return
    }

    const hover = mode === '滞空'
    const result = await this.teleportService.prepareAndLock(username, { hover })

    if (!result.success) {
      if (result.code === 'hover_failed' || result.code === 'not_ready') {
        await this.reply(username, this.messages.text('lockHoverFailed'), source)
        return
      }
      await this.reply(username, this.messages.text('lockAlready'), source)
      return
    }

    await this.reply(
      username,
      this.messages.text(hover ? 'lockHoverSuccess' : 'lockSuccess'),
      source
    )
  }

  private async _unlock (username: string, source: CommandSource): Promise<void> {
    if (!this.teleportService.isLocked()) {
      await this.reply(username, this.messages.text('unlockNotLocked'), source)
      return
    }
    this.teleportService.unlock()
    await this.reply(username, this.messages.text('unlockSuccess'), source)
  }

  private async _add (username: string, gameName: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!gameName) {
      await this.reply(username, this.messages.text('addUsage'), source)
      return
    }
    if (this.whitelist.isAllowed(gameName)) {
      await this.reply(username, this.messages.text('addAlready', { gameName }), source)
      return
    }

    this.whitelist.add(gameName, username)
    await this.reply(username, this.messages.text('addSuccess', { gameName }), source)
  }

  private async _remove (username: string, gameName: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!gameName) {
      await this.reply(username, this.messages.text('removeUsage'), source)
      return
    }
    if (!this.whitelist.isAllowed(gameName)) {
      await this.reply(username, this.messages.text('removeNotFound', { gameName }), source)
      return
    }

    this.whitelist.remove(gameName)
    await this.reply(username, this.messages.text('removeSuccess', { gameName }), source)
  }

  private resolveActivityStatus (): string {
    if (this.teleportService.isLocked()) return this.teleportService.getStatusText()
    const mode = this.ridingManager.getMode()
    if (mode === 'player') return '骑乘'
    if (mode === 'minecart') return '矿车'
    return '空闲'
  }

  private formatPosition (): string {
    const bot = this.mcBot.bot
    if (!bot) return '未知'
    const p = bot.entity.position
    return `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`
  }

  private async _status (username: string, source: CommandSource, cm_d?: string): Promise<void> {
    // Public: %状态→Bot1, %状态2→Bot2, %状态3→Bot3
    if (source === 'chat') {
      const num = cm_d?.endsWith('2') ? 2 : cm_d?.endsWith('3') ? 3 : 1
      if (this.botIndex !== num) return
    }
    const uptimeSec = Math.floor(process.uptime())
    const hours = Math.floor(uptimeSec / 3600)
    const minutes = Math.floor((uptimeSec % 3600) / 60)

    const activity = this.resolveActivityStatus()
    const msg = this.teleportService.isLocked()
      ? this.messages.text('statusLineLocked', {
          activity,
          lockTime: this.teleportService.getLockedTimeText(),
          position: this.formatPosition()
        })
      : this.messages.text('statusLine', {
          activity,
          uptime: `${hours}h${minutes}m`,
          position: this.formatPosition()
        })
    await this.reply(username, msg, source)
  }

  private async _useItem (username: string, args: string, source: CommandSource): Promise<void> {
    const firstArg = args.trim().split(/\s+/)[0]?.toLowerCase() || ''
    if (firstArg === 'stop' || firstArg === '\u505c\u6b62') {
      await this.reply(username, this.useItemModule.stopUse(), source)
      return
    }
    if (this.placeModule.isBedrockBreak()) {
      await this.reply(username, '破基岩追踪放置进行中；请先执行 放置 停止 后再使用物品。', source)
      return
    }
    this.placeModule.interrupt('开始使用物品')
    const result = this.useItemModule.startUse(args, () => {
      void this.reply(username, this.messages.text('useComplete'), source)
    }, () => {
      void this.reply(username, this.messages.text('useFailed'), source)
    })
    await this.reply(username, result, source)
  }

  private async _placeBlock (username: string, args: string, source: CommandSource): Promise<void> {
    const firstArg = args.trim().split(/\s+/)[0]?.toLowerCase() || ''
    if (this.hissModule.isActive() && firstArg !== 'stop' && firstArg !== '\u505c\u6b62') {
      await this.reply(username, 'bot \u6b63\u5728\u54c8\u6c14\u8ffd\u51fb\uff0c\u8bf7\u5148\u4f7f\u7528 sp \u505c\u6b62\u54c8\u6c14\u3002', source)
      return
    }
    if (firstArg === 'stop' || firstArg === '\u505c\u6b62') {
      await this.reply(username, this.placeModule.stop(), source)
      return
    }
    this.useItemModule.interrupt('开始放置')
    await this.reply(username, this.placeModule.start(args, username), source)
  }

  private async _lookAt (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (parts.length === 2) {
      const yaw = parseFloat(parts[0]), pitch = parseFloat(parts[1])
      if (!isNaN(yaw) && !isNaN(pitch)) {
        await this.reply(username, this.lookModule.look(yaw, pitch), source)
        return
      }
    }
    if (parts.length === 1) {
      const res = this.lookModule.lookPlayer(parts[0])
      if (res) { await this.reply(username, res, source); return }
      await this.reply(username, this.messages.text('lookPlayerNotFound', { player: parts[0] }), source)
      return
    }
    await this.reply(username, this.messages.text('lookUsage'), source)
  }

  private async _lookAtCoord (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (parts.length < 3) {
      await this.reply(username, '用法: 看向 x y z', source)
      return
    }
    const x = parseFloat(parts[0])
    const y = parseFloat(parts[1])
    const z = parseFloat(parts[2])
    if (isNaN(x) || isNaN(y) || isNaN(z)) {
      await this.reply(username, '用法: 看向 x y z', source)
      return
    }
    await this.reply(username, await this.lookModule.lookAtCoord(x, y, z), source)
  }

  private async _waterFill (username: string, choice: string | undefined, source: CommandSource): Promise<void> {
    if (this.placeModule.isBedrockBreak()) {
      await this.reply(username, '破基岩追踪放置进行中；请先执行 放置 停止 后再装水。', source)
      return
    }
    this.placeModule.interrupt('开始装水')
    const r = await this.useItemModule.fillWater(choice || '')
    const d = r.data ?? {}
    let msg: string
    if (r.success) {
      msg = this.messages.text(r.code === 'bucket' ? 'waterBucketSuccess' : 'waterBottleSuccess')
    } else {
      switch (r.code) {
        case 'no_water': msg = this.messages.text('waterNoWater'); break
        case 'no_item': msg = this.messages.text('waterNoItem'); break
        case 'equip_fail': msg = this.messages.text('waterEquipFail', { item: String(d.item ?? ''), message: r.message ?? '' }); break
        case 'too_far': msg = this.messages.text('waterTooFar', { distance: String(d.distance ?? '') }); break
        case 'break_active': msg = r.message || '破基岩追踪放置进行中，请先执行 放置 停止'; break
        case 'not_filled': msg = this.messages.text('waterNotFilled', { item: String(d.item ?? ''), distance: String(d.distance ?? ''), version: String(d.version ?? '') }); break
        case 'unsupported': msg = this.messages.text('waterUnsupported'); break
        default: msg = this.messages.text('waterFail', { message: r.message ?? '未知原因' })
      }
    }
    await this.reply(username, msg, source)
  }

  private async _unlockAll (username: string, source: CommandSource): Promise<void> {
    if (this.teleportService.getLockedBy() !== username) { return }
    this.teleportService.unlock()
    await this.reply(username, this.messages.text('unlockedShort'), source)
  }

  private async _transferLock (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, this.messages.text('transferLockUsage'), source); return }
    if (!this.teleportService.isLocked()) { await this.reply(username, this.messages.text('notLocked'), source); return }
    this.teleportService.transferLock(target)
    await this.reply(username, this.messages.text('transferLockSuccess', { target }), source)
  }

  private async _wlList (username: string, source: CommandSource): Promise<void> {
    const list = this.whitelist.list()
    const names = Object.keys(list)
    if (names.length === 0) {
      await this.reply(username, this.messages.text('wlListEmpty'), source)
      return
    }
    const per = 9
    for (let i = 0; i < names.length; i += per) {
      const chunk = names.slice(i, i + per).join(', ')
      await this.reply(username, this.messages.text('wlListPage', { page: i / per + 1, total: Math.ceil(names.length / per), chunk }), source)
    }
  }

  private async _blacklistAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, this.messages.text('blacklistAddUsage'), source); return }
    this.db.prepare('INSERT OR REPLACE INTO blacklist (game_name, added_by) VALUES (?, ?)').run(target, username)
    await this.reply(username, this.messages.text('blacklistAdd', { target }), source)
  }

  private async _brewWlAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, this.messages.text('brewWlAddUsage'), source); return }
    const exists = this.db.prepare('SELECT 1 AS ok FROM brew_whitelist WHERE game_name = ?').get(target) as { ok: number } | undefined
    if (exists) { await this.reply(username, this.messages.text('brewWlAlready', { target }), source); return }
    this.db.prepare('INSERT OR REPLACE INTO brew_whitelist (game_name, added_by, added_at) VALUES (?, ?, ?)').run(target, username, new Date().toISOString())
    await this.reply(username, this.messages.text('brewWlAddSuccess', { target }), source)
  }

  private async _brewWlRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, this.messages.text('brewWlRemoveUsage'), source); return }
    const exists = this.db.prepare('SELECT 1 AS ok FROM brew_whitelist WHERE game_name = ?').get(target) as { ok: number } | undefined
    if (!exists) { await this.reply(username, this.messages.text('brewWlNotFound', { target }), source); return }
    this.db.prepare('DELETE FROM brew_whitelist WHERE game_name = ?').run(target)
    await this.reply(username, this.messages.text('brewWlRemoveSuccess', { target }), source)
  }

  private async _brewWlListCmd (username: string, source: CommandSource): Promise<void> {
    const rows = this.db.prepare('SELECT game_name FROM brew_whitelist ORDER BY game_name').all() as Array<{ game_name: string }>
    if (rows.length === 0) { await this.reply(username, this.messages.text('brewWlListEmpty'), source); return }
    const list = rows.map(r => r.game_name).join(', ')
    await this.reply(username, this.messages.text('brewWlList', { list }), source)
  }

  // === 定时（酿酒等倒计时提醒，不锁定 bot）===
  // 用法: 定时 <标签> <时长> | 定时 取消 <标签> | 定时 列表
  private async _timerCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    const sub = (parts.shift() || '').trim().toLowerCase()
    if (sub === '\u53d6\u6d88' || sub === 'cancel') {
      const label = (parts.shift() || '').trim()
      if (!label) {
        await this.reply(username, this.messages.text('timerCancelUsage'), source)
        return
      }
      await this.reply(username, this.messages.text(
        this.timerModule.cancel(username, label) ? 'timerCanceled' : 'timerCancelNotFound',
        { label }
      ), source)
      return
    }
    if (sub === '\u5217\u8868' || sub === 'list') {
      const timers = this.timerModule.list(username)
      await this.reply(username, timers.length === 0
        ? this.messages.text('timerListEmpty')
        : this.messages.text('timerList', { list: timers.map(timer => `${timer.label} (${timer.display})`).join(', ') }), source)
      return
    }
    const label = sub
    if (!label) {
      await this.reply(username, this.messages.text('timerUsage'), source)
      return
    }
    const raw = (parts.shift() || '').trim()
    const result = this.timerModule.start(username, label, raw)
    if (result.status === 'invalid') {
      await this.reply(username, this.messages.text('timerInvalid', { input: result.input || '\u7a7a' }), source)
      return
    }
    if (result.status === 'too_long') {
      await this.reply(username, this.messages.text('timerTooLong'), source)
      return
    }
    await this.reply(username, this.messages.text(
      result.replaced ? 'timerReplaced' : 'timerStarted',
      { label, display: result.display }
    ), source)
  }

  private async _enchantInfo (username: string, query: string, source: CommandSource): Promise<void> {
    if (source === 'chat' && this.botIndex !== 1) return
    const info = lookEnchant(query)
    if (!info) {
      await this.reply(username, this.messages.text('enchantNotFound', { query }), source)
      return
    }
    await this.reply(username, info, source)
  }

  private async _help (username: string, source: CommandSource, section?: string): Promise<void> {
    const wantAdmin = section === 'admin' || section === '管理'
    if (wantAdmin && !this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    const lines: string[] = [this.messages.text(wantAdmin ? 'helpAdminIntro' : 'helpIntro')]
    lines.push(...this.messages.lines(wantAdmin ? 'helpAdmin' : 'helpBasic'))
    if (!wantAdmin && this.isAdmin(username)) {
      lines.push(this.messages.text('helpAdminHint'))
    }
    await this.reply(username, lines.join('\n'), source)
  }

  private async _jumpCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    const arg = parts[0]
    const isStop = arg === 'stop' || arg === '\u505c\u6b62'
    if (this.hissModule.isActive() && !isStop) {
      await this.reply(username, 'bot \u6b63\u5728\u54c8\u6c14\u8ffd\u51fb\uff0c\u8bf7\u5148\u4f7f\u7528 sp \u505c\u6b62\u54c8\u6c14\u3002', source)
      return
    }
    if (!arg || arg === '1') {
      await this.reply(username, this.jumpModule.startSingle(), source)
    } else if (arg === 'stop' || arg === '停止') {
      await this.reply(username, this.jumpModule.stop(), source)
    } else if (arg === 'infinite' || arg === '无限' || arg === '无限次') {
      await this.reply(username, this.jumpModule.startInfinite(), source)
    } else {
      const count = parseInt(arg, 10)
      if (!isNaN(count) && count > 0) {
        this.jumpModule.setOnDone(() => {
          this.reply(username, this.messages.text('jumpDone', { count }), source).catch(() => {})
        })
        await this.reply(username, this.jumpModule.startCount(count), source)
      } else {
        await this.reply(username, this.messages.text('jumpUsage'), source)
      }
    }
  }

  private async _execCmd (username: string, cmd: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!cmd) { await this.reply(username, this.messages.text('execUsage'), source); return }
    this.mcBot.chat(cmd)
    await this.reply(username, this.messages.text('execSuccess', { cmd }), source)
  }

  private async _loopCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    const first = (parts.shift() || '').toLowerCase()

    if (first === '停止' || first === 'stop') {
      this.loopCmd.stop()
      await this.reply(username, this.messages.text('loopStopped'), source)
      return
    }
    if (first === '状态' || first === 'status') {
      const cfg = this.loopCmd.getConfig()
      await this.reply(username, cfg.enabled
        ? this.messages.text('loopStatusActive', { text: cfg.text, interval: cfg.intervalSec })
        : this.messages.text('loopStatusIdle'), source)
      return
    }

    // Parse: 间隔1.1s /command args
    let intervalSec = 60
    let cmd = ''
    if (first.startsWith('间隔')) {
      const match = first.match(/^间隔([\d.]+)s?$/i)
      if (match) {
        intervalSec = parseFloat(match[1]) || 60
        cmd = parts.join(' ')
      } else {
        await this.reply(username, this.messages.text('loopUsage'), source)
        return
      }
    } else {
      parts.unshift(first)
      cmd = parts.join(' ')
    }

    if (!cmd) {
      await this.reply(username, this.messages.text('loopUsage'), source)
      return
    }

    this.loopCmd.update(cmd, intervalSec)
    await this.reply(username, this.messages.text('loopStarted', { cmd, interval: intervalSec }), source)
  }

  private async _say (username: string, message: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!message) {
      await this.reply(username, this.messages.text('sayUsage'), source)
      return
    }

    const result = this.gameApiService.say(message)
    await this.reply(username, result.success
      ? this.messages.text('saySuccess')
      : this.messages.text('sayError', { message: result.message || '发送失败' }), source)
  }

  private async _forward (username: string, message: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!message) {
      await this.reply(username, this.messages.text('forwardUsage'), source)
      return
    }

    const sentAt = Date.now()
    const result = this.gameApiService.say(message)
    if (!result.success) {
      await this.reply(username, this.messages.text('forwardError', { message: result.message || '发送失败' }), source)
      return
    }

    await sleep(this.forwardWaitMs)
    const systemLines = this.systemBuffer.collect(sentAt, this.forwardWaitMs)

    if (systemLines.length === 0) {
      await this.reply(username, this.messages.text('forwardEmpty'), source)
      return
    }

    await this.reply(username, systemLines.join('\n'), source)
  }

}
