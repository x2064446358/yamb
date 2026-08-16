import { Vec3 } from 'vec3'
import { spawn } from 'child_process'
import type { BotBehaviorConfig, CommandConfig, MessagesConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type GameApiService from '../../api/game-service'
import type TeleportService from '../teleport/service'
import type Whitelist from '../../permissions/whitelist'
import type StandbyManager from '../standby/manager'
import type PlayerInteractionService from '../../actions/player'
import type MinecartInteractionService from '../../actions/minecart'
import type RidingManager from '../riding/manager'
import type ContainerRegistry from '../container/registry'
import type InventoryActions from '../../actions/inventory'
import { cnName, findMatchingItems, itemDisplayName } from '../../actions/inventory'
import type SystemMessageBuffer from './system-buffer'
import type LoopCmd from '../loopcmd'
import CommandMessages from './messages'
import { sleep } from '../../platform/sleep'
import { info, warn, debug } from '../../platform/logger'
import { isMountedOnPlayer, approachEntity } from '../../actions/shared/entity-utils'
import { getTargetContainerBlock } from '../container/utils'
import {
  type CommandSource,
  matchesPrefix,
  normalizeInput,
  parsePrefixedArgs,
  parseWhisperCommand
} from './parser'
import type JumpModule from '../jump'
import type UseItemModule from '../useitem'
import { lookEnchant } from '../enchant'
import type BrewModule from '../brew'
import { getNodeBlockAt } from '../brew/block-node-utils'
import { normalizeItemKey } from '../../actions/inventory'

import type { DatabaseSync } from 'node:sqlite'

/** 进程内软重启钩子：由 app 层注册（重载时重建模块并重连），未注册时退化为 spawn 重启 */
let reloadHook: (() => void) | null = null
export function setReloadHook (fn: () => void): void { reloadHook = fn }

/** 定时任务：到点私信玩家，纯内存提醒，不锁定 bot */
interface TimerEntry {
  username: string
  label: string
  /** 到点时间戳(ms)，用于排序展示剩余 */
  finishAt: number
  /** 展示用时长（如 "12分钟"、"1小时30分钟"） */
  display: string
  handle: ReturnType<typeof setTimeout>
}

export default class CommandHandler {
  private mcBot: MinecraftBot
  private teleportService: TeleportService
  private gameApiService: GameApiService
  private playerInteraction: PlayerInteractionService
  private minecartInteraction: MinecartInteractionService
  private ridingManager: RidingManager
  private loopCmd: LoopCmd
  private db: DatabaseSync
  private jumpModule: JumpModule
  private useItemModule: UseItemModule
  private botIndex: number
  /** 公屏 %挂机 认领：等待所有繁忙 bot 确认无人认领后，才回复"全部繁忙" */
  private static readonly TPA_ARBITRATION_MS = 3000
  /** 认领行 TTL：认领的 bot 崩溃/掉线后自动过期，玩家可重新申请 */
  private static readonly TPA_CLAIM_TTL_MS = 45000
  /** 认领结束后的宽限期：行保留一段时间，让繁忙 bot 的仲裁（3s）仍能看到"已有人处理过"，避免误报全部繁忙 */
  private static readonly TPA_RESOLVE_GRACE_MS = 10000
  /** 全部繁忙提示行 TTL */
  private static readonly TPA_BUSY_TTL_MS = 30000
  /** 锁定的 owner 静默后等待同镇 bot 认领的窗口；超时无认领则回复「捷运繁忙」 */
  private static readonly PHOME_DELEGATE_FALLBACK_MS = 2500
  private containerRegistry: ContainerRegistry
  private inventoryActions: InventoryActions
  private systemBuffer: SystemMessageBuffer
  private whitelist: Whitelist
  private standby: StandbyManager
  private brewModule: BrewModule
  /** brew 开始时的转场 tpa：传送完成后不锁定 */
  private brewTpaRelocate = false
  private messages: CommandMessages
  private prefix: string
  private adminList: Set<string>
  private allowPublicCommands: boolean
  private replyAlwaysWhisper: boolean
  private replyDelayMs: number
  private forwardWaitMs: number
  private interactionDistance: number
  private approachDistance: number
  private _lastCmd?: { key: string; time: number }

  constructor (
    mcBot: MinecraftBot,
    teleportService: TeleportService,
    gameApiService: GameApiService,
    playerInteraction: PlayerInteractionService,
    minecartInteraction: MinecartInteractionService,
    ridingManager: RidingManager,
    jumpModule: JumpModule,
    useItemModule: UseItemModule,
    loopCmd: LoopCmd,
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
    this.minecartInteraction = minecartInteraction
    this.ridingManager = ridingManager
    this.jumpModule = jumpModule
    this.useItemModule = useItemModule
    // 破基岩放置（放置 <方块名>）启动时用"挂机同款"锁定，备注"破基岩"，并把视距固定到 8 保证追踪目标加载；
    // 停止时若锁是破基岩开的则解锁，视距回落
    useItemModule.setOnBreakChange((active, owner) => {
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
    this.db = db
    this.botIndex = parseInt(process.env.BOT_INDEX || '1', 10)
    this.containerRegistry = containerRegistry
    this.inventoryActions = inventoryActions
    this.systemBuffer = systemBuffer
    this.whitelist = whitelist
    this.standby = standby
    this.brewModule = brewModule
    this.prefix = config.prefix || '#ybot'
    this.messages = new CommandMessages(config.messages, this.prefix)
    this.adminList = new Set(adminList)
    this.allowPublicCommands = config.allowPublicCommands
    this.replyAlwaysWhisper = config.replyAlwaysWhisper
    this.replyDelayMs = botConfig.replyDelayMs
    this.forwardWaitMs = botConfig.forwardWaitMs
    this.interactionDistance = botConfig.interactionDistance
    this.approachDistance = botConfig.approachDistance
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

  getBotIndex(): number { return this.botIndex }

  private tpaNotes = new Map<string, string>()

  /** 定时 <标签> <时长>：到点私信提醒，不锁定 bot（键 = 玩家名::标签小写） */
  private timers = new Map<string, TimerEntry>()

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
    if (text.length <= maxLen) {
      const ok = this.mcBot.whisper(username, text)
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
      const ok = this.mcBot.whisper(username, chunk)
      if (!ok) warn(`[Command] 回复失败 -> ${username}: ${chunk}`)
    }
  }

  private waypointHint (): string {
    const aliases = this.teleportService.listWaypointAliases()
    return aliases.length > 0 ? aliases.join(', ') : '无'
  }

  private async notifyLocked (username: string, source: CommandSource): Promise<void> {
    const lockedBy = this.teleportService.getLockedBy() || '未知'
    await this.reply(username, this.messages.text('lockedBlocked', { lockedBy }), source)
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
    const isPhomeNum = /^%?\d+$/.test(text)
    if (source !== 'console' && !isPhomeNum && !this.isWhitelisted(username) && !this.isAdmin(username) && !this.isBrewAllowed(username)) return
    // [DEBUG handle] — enable with VERBOSE=true

    // Lock check: only locked player and admins can control bot
    if (this.teleportService.isLocked() && !isPhomeNum) {
      const cmd = text.split(/\s+/)[0]?.toLowerCase() || ''
      const allowedCmds = ['状态', '状态2', '状态3', 'status', 'status2', 'status3', '挂机', '0', '跳跃', 'xjump', '改锁定']
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
      const brewAllowed = new Set(['brew', '酿酒', 'status', '状态', '状态2', '状态3', 'help', '帮助', '定时'])
      if (!brewAllowed.has(cmd)) {
        const numMatch = cmd.match(/^%?(\d+)$/)
        if (numMatch) {
          const num = parseInt(numMatch[1], 10)
          // 被锁定的 bot（如陈化锁定）不拦截 phome 数字命令，放行给 _phomeNumber 走委托/锁定流程；
          // 未锁定的活跃酿酒才拦截：只有归属 bot（或主 bot 的列表）回复"酿酒中"，delegate/无关 bot 保持静默
          if (!this.teleportService.isLocked()) {
            const shouldReply = num === 0
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
        await this._phomeWlAdd(username, parts[0], source)
        break
      case '移除phome白名单':
      case '移除phome 白名单':
        await this._phomeWlRemove(username, parts[0], source)
        break
      case 'phome白名单列表':
      case 'phome 白名单列表':
        await this._phomeWlListCmd(username, source)
        break

      // === Phome SuperAdmin ===
      case '加phome超管':
      case '加phome 超管':
        await this._phomeSaAdd(username, parts[0], source)
        break
      case '移除phome超管':
      case '移除phome 超管':
        await this._phomeSaRemove(username, parts[0], source)
        break
      case 'phome超管列表':
      case 'phome 超管列表':
        await this._phomeSaList(username, source)
        break

      // === Phome Points ===
      case '加phome点':
        await this._phomePointAdd(username, parts, source)
        break
      case '移除phome点':
        await this._phomePointRemove(username, parts[0], source)
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
        await this._inv(username, source)
        break
      case 'store':
        await this._store(username, parts, source)
        break
      case 'take':
        await this._take(username, parts, source)
        break
      case '丢弃':
        await this._drop(username, parts, source)
        break
      case '丢弃全部':
        await this._dropAll(username, source)
        break
      case '手持':
        await this._hold(username, parts.join(' '), source)
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
        await this._reloadBot(source)
        break

      // === Interaction ===
      // === Container ===
      case 'container':
        await this._container(username, parts, source)
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
        await this._nodeCmd(username, parts, source)
        break

      // === Say/Forward (admin) ===
      case 'say':
        await this._say(username, parts.join(' '), source)
        break
      case 'forward':
        await this._forward(username, parts.join(' '), source)
        break


      // === Numbered Phome ===
      default:
        const numMatch = cmd.match(/^%?(\d+)$/)
        if (numMatch) {
          const num = parseInt(numMatch[1], 10)
          if (num === 0) { await this._phomeList(username, source) } else { await this._phomeNumber(username, num, source) }
          break
        }
        await this.reply(username, this.messages.text('unknownCommand', { cmd }), source)
    }

    this.standby.scheduleAfk()
  }

  private async _phomeList (username: string, source: CommandSource): Promise<void> {
    // 只有主 bot 响应传送点列表；其他 bot 私聊 0 时提醒并指向主 bot，公屏 %0 保持静默（主 bot 已应答）
    if (this.teleportService.isMainBot() || source === 'console') {
      await this.reply(username, this.teleportService.getPhomeListText(), source)
      return
    }
    if (source === 'whisper') {
      await this.reply(username, this.messages.text('phomeRedirect', { mainBot: this.teleportService.getMainBot() }), source)
    }
  }

  private async _phomeNumber (username: string, num: number, source: CommandSource): Promise<void> {
    const idx = num - 1
    const wp = this.teleportService.getWaypointByIndex(idx)
    if (!wp) return
    const delegatable = this.teleportService.isDelegatable(idx)

    if (this.teleportService.isOwned(idx)) {
      // === Owner 路径 ===
      if (this.teleportService.isLocked()) {
        // /phome 点 + 公屏 %N：owner 静默，交由同镇 bot 代执行
        if (delegatable && source === 'chat') {
          if (!this.isPhomeAllowed(username)) {
            await this.reply(username, this.messages.text('latelanOnly'), source)
            return
          }
          // 同镇无任何可用的 delegate（全部被锁/离线/无同镇 bot）→ 立即报繁忙，带锁定人信息
          if (!this.teleportService.hasDelegateCandidates(idx)) {
            await this.reply(username, this.messages.text('phomeBusyNoCandidates', {
              owner: this.teleportService.getBotName(),
              lockedBy: this.teleportService.getLockedBy() ?? '未知'
            }), source)
            return
          }
          this.schedulePhomeDelegateFallback(username, idx, source)
          return
        }
        // /home 点（仅本人，不可委托）或私聊请求：不委托，直接告知被锁（/ts 点小镇共享，已在上方走委托路径）
        const lockedBy = this.teleportService.getLockedBy()
        const secs = this.teleportService.getLockedTicks() / 20
        const m = Math.floor(secs / 60)
        const s = Math.floor(secs % 60)
        await this.reply(username, this.messages.text('lockedForTime', { lockedBy: lockedBy ?? '未知', time: `${m}分${s}秒` }), source)
        return
      }
      if (this.teleportService.isCommandBusy()) {
        await this.reply(username, this.messages.text('teleportFailed'), source)
        return
      }
      if (!this.isPhomeAllowed(username)) {
        await this.reply(username, this.messages.text('latelanOnly'), source)
        return
      }

      const result = await this.teleportService.executePhome(username, idx)
      if (!result.success && result.message) {
        await this.reply(username, result.message, source)
      }
      return
    }

    // === Delegate 路径：仅公屏 %N；同镇点 + owner 被锁 + 本 bot 空闲未锁 + 玩家有权限才代执行 ===
    if (delegatable && source === 'chat' && this.isPhomeAllowed(username) && this.teleportService.canDelegateFor(idx)) {
      const owner = this.teleportService.ownerOf(idx)
      if (this.teleportService.claimPhomeDelegate(username, idx)) {
        const result = await this.teleportService.executePhomeDelegated(username, idx)
        if (result.success) {
          await this.reply(username, this.messages.text('phomeDelegated', { owner: owner ?? '同镇bot', alias: wp.alias }), source)
        } else {
          // 执行失败（极罕见）→ 释放认领，让 owner 兜底仲裁接管
          this.teleportService.releasePhomeClaim(username, idx)
        }
      }
    }
    // 其他情况（非本镇点 / owner 未锁定 / 认领失败 / 无权限）：保持静默
  }

  /** 锁定的 owner 静默后，等待同镇 delegate 认领；超时无认领则回复「捷运繁忙」 */
  private schedulePhomeDelegateFallback (username: string, idx: number, source: CommandSource): void {
    const scheduledAt = Date.now()
    setTimeout(() => {
      if (this.teleportService.isDelegateClaimed(username, idx, scheduledAt)) return
      this.reply(username, this.messages.text('phomeBusyTimeout'), source).catch(() => {})
    }, CommandHandler.PHOME_DELEGATE_FALLBACK_MS)
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
    const targetName = target?.trim() || username

    // Find player entity
    let entity = bot.players[targetName]?.entity
    if (!entity) {
      for (const [, e] of Object.entries(bot.entities)) {
        if (e?.type !== 'player' || e === bot.entity || (e as { username?: string }).username === bot.username) continue
        const dist = bot.entity.position.distanceTo(e.position)
        if (dist > 5) continue
        if ((e as { username?: string }).username?.toLowerCase() === targetName.toLowerCase()) { entity = e; break }
      }
    }
    if (!entity) { await this.reply(username, this.messages.text('mountNoPlayerNear', { target: targetName }), source); return }

    try {
      if (this.ridingManager.isActive()) {
        await this.ridingManager.dismount()
        await sleep(300)
      }

      // Walk to player (within 5 blocks)
      const approach = await approachEntity(bot, entity, this.interactionDistance, 5)
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
        this.mcBot.chat('/afk')
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

  private async _container (
    username: string,
    parts: string[],
    source: CommandSource
  ): Promise<void> {
    const sub = (parts.shift() || '').toLowerCase()
    switch (sub) {
      case 'add':
        await this._containerAdd(username, parts[0], source)
        break
      case 'remove':
        await this._containerRemove(username, parts[0], source)
        break
      case 'list':
        await this._containerList(username, source)
        break
      case 'info':
        await this._containerInfo(username, parts[0], source)
        break
      default:
        await this.reply(username, [
          this.messages.text('containerAddUsage'),
          this.messages.text('containerRemoveUsage'),
          this.messages.text('containerInfoUsage'),
          'container list — 列出容器'
        ].join('\n'), source)
    }
  }

  private async _containerAdd (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!alias) {
      await this.reply(username, this.messages.text('containerAddUsage'), source)
      return
    }

    const bot = this.mcBot.bot
    if (!bot) {
      await this.reply(username, this.messages.text('containerNoTarget'), source)
      return
    }

    const target = getTargetContainerBlock(bot)
    if (!target) {
      await this.reply(username, this.messages.text('containerNoTarget'), source)
      return
    }

    const pos = target.block.position
    this.containerRegistry.add({
      alias,
      type: target.type,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      dimension: bot.game?.dimension || 'overworld',
      addedBy: username
    })

    await this.reply(username, this.messages.text('containerAddSuccess', {
      alias,
      type: target.type,
      x: pos.x,
      y: pos.y,
      z: pos.z
    }), source)
  }

  private async _containerRemove (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!alias) {
      await this.reply(username, this.messages.text('containerRemoveUsage'), source)
      return
    }
    if (!this.containerRegistry.remove(alias)) {
      await this.reply(username, this.messages.text('containerRemoveNotFound', { alias }), source)
      return
    }
    await this.reply(username, this.messages.text('containerRemoveSuccess', { alias }), source)
  }

  private async _containerList (username: string, source: CommandSource): Promise<void> {
    const list = this.containerRegistry.list()
    if (list.length === 0) {
      await this.reply(username, this.messages.text('containerListEmpty'), source)
      return
    }

    const lines = [
      this.messages.text('containerListHeader', { count: list.length }),
      ...list.map(c => this.messages.text('containerListEntry', {
        alias: c.alias,
        type: c.type,
        x: c.x,
        y: c.y,
        z: c.z
      }))
    ]
    await this.reply(username, lines.join('\n'), source)
  }

  private async _containerInfo (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!alias) {
      await this.reply(username, this.messages.text('containerInfoUsage'), source)
      return
    }
    const info = this.containerRegistry.get(alias)
    if (!info) {
      await this.reply(username, this.messages.text('containerInfoNotFound', { alias }), source)
      return
    }
    const lines = this.messages.lines('containerInfoLines', {
      alias: info.alias,
      type: info.type,
      x: info.x,
      y: info.y,
      z: info.z,
      dimension: info.dimension,
      addedBy: info.addedBy,
      date: info.addedAt.slice(0, 10)
    })
    await this.reply(username, lines.join('\n'), source)
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
        const relocated = await this._relocateForBrew(username, source)
        if (!relocated) return
        const result = await this.brewModule.start(
          recipe,
          async message => this.reply(username, message, source),
          username
        )
        await this.reply(
          username,
          result.success
            ? this.messages.text('brewStarted', { recipe })
            : result.message || this.messages.text('brewBusy'),
          source
        )
        break
      }

      case 'status':
      case '状态': {
        const status = this.brewModule.status()
        const agingLines = status.aging ?? []
        if (!status.running) {
          if (agingLines.length > 0) {
            await this.reply(username, [
              this.messages.text('brewStatusIdle'),
              ...agingLines
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
          ...agingLines
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

  private async _nodeCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    const sub = (parts.shift() || '').toLowerCase()

    switch (sub) {
      case 'reg':
      case '登记':
      case '注册':
        await this._nodeReg(username, parts, source)
        break
      case 'list':
      case '列表':
        await this._nodeList(username, parts, source)
        break
      case 'info':
      case '详情':
        await this._nodeInfo(username, parts[0], source)
        break
      case 'remove':
      case '删除':
        await this._nodeRemove(username, parts[0], source)
        break
      default:
        await this.reply(username, [
          '用法: node 登记 <别名> <x> <y> <z> [-混合] [-区域 区域]',
          '      node 列表 [区域]',
          '      node 详情 <别名>',
          '      node 删除 <别名>'
        ].join('\n'), source)
    }
  }

  private async _nodeReg (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }

    const [alias, xRaw, yRaw, zRaw, ...options] = parts
    if (
      !alias ||
      !/^-?\d+$/.test(xRaw ?? '') ||
      !/^-?\d+$/.test(yRaw ?? '') ||
      !/^-?\d+$/.test(zRaw ?? '')
    ) {
      await this.reply(username, this.messages.text('nodeAddUsage'), source)
      return
    }

    let mixed = false
    let group: string | undefined
    for (let i = 0; i < options.length; i++) {
      const opt = options[i].toLowerCase()
      if (opt === '-m' || opt === '-mixed' || opt === '-混合') {
        mixed = true
      } else if (opt === '-g' || opt === '-group' || opt === '--group' || opt === '-区域') {
        group = options[++i]
        if (!group) {
          await this.reply(username, this.messages.text('nodeAddUsage'), source)
          return
        }
      } else {
        await this.reply(username, this.messages.text('nodeAddUsage'), source)
        return
      }
    }

    const bot = this.mcBot.bot
    if (!bot) {
      await this.reply(username, this.messages.text('botNotReady'), source)
      return
    }

    const x = Number(xRaw)
    const y = Number(yRaw)
    const z = Number(zRaw)
    const target = getNodeBlockAt(bot, x, y, z)
    if (!target) {
      await this.reply(username, this.messages.text('nodeAddNoTarget'), source)
      return
    }

    const blockType = target.blockType
    if (blockType !== 'Container' && mixed) {
      await this.reply(username, this.messages.text('nodeAddUsage'), source)
      return
    }

    const resolvedGroup = (group ?? this.brewModule.getGroup()).trim()

    let isDedicated: boolean | null = null
    let itemId: string | null = null
    if (blockType === 'Container') {
      isDedicated = !mixed
      if (isDedicated) {
        try {
          const approach = await this.inventoryActions.approachBlock(
            x,
            y,
            z,
            this.interactionDistance,
            this.approachDistance
          )
          if (!approach.success) {
            await this.reply(username, approach.message || '无法接近容器', source)
            return
          }
          const chest = await bot.openContainer(target.block)
          try {
            const first = chest.slots[0]
            if (!first) {
              await this.reply(username, '专用容器第一格没有物品，无法绑定', source)
              return
            }
            itemId = normalizeItemKey(first.name)
          } finally {
            chest.close()
          }
        } catch (err) {
          await this.reply(username, `登记容器失败: ${(err as Error).message}`, source)
          return
        }
      }
    }

    this.containerRegistry.add({
      alias,
      type: target.block.name,
      blockType,
      x,
      y,
      z,
      dimension: bot.game?.dimension || 'overworld',
      isDedicated,
      itemId,
      nodeGroup: resolvedGroup,
      addedBy: username
    })

    const bindText = blockType === 'Container'
      ? (itemId ? ` | 绑定 ${cnName(itemId)}` : (mixed ? '' : ' | 空容器'))
      : ''
    await this.reply(username, this.messages.text('nodeAddSuccess', {
      alias,
      type: blockType,
      group: resolvedGroup,
      bind: bindText,
      x,
      y,
      z
    }), source)
  }

  private async _nodeList (username: string, parts: string[], source: CommandSource): Promise<void> {
    const groupArg = (parts[0] ?? '').trim()
    const group = groupArg || this.brewModule.getGroup()
    const list = this.containerRegistry.list(group)
    if (list.length === 0) {
      await this.reply(username, this.messages.text('nodeListEmpty', { group }), source)
      return
    }

    const lines = [
      this.messages.text('nodeListHeader', { count: list.length, group }),
      ...list.map(n => this.messages.text('nodeListEntry', {
        alias: n.alias,
        type: n.blockType ?? n.type,
        x: n.x,
        y: n.y,
        z: n.z,
        item: n.itemId ? ` [${cnName(n.itemId)}]` : ''
      }))
    ]
    await this.reply(username, lines.join('\n'), source)
  }

  private async _nodeInfo (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!alias) {
      await this.reply(username, this.messages.text('nodeInfoUsage'), source)
      return
    }
    const info = this.containerRegistry.get(alias)
    if (!info) {
      await this.reply(username, this.messages.text('nodeInfoNotFound', { alias }), source)
      return
    }
    const lines = this.messages.lines('nodeInfoLines', {
      alias: info.alias,
      type: info.blockType ?? info.type,
      block: info.type,
      x: info.x,
      y: info.y,
      z: info.z,
      dimension: info.dimension,
      group: info.nodeGroup || '-',
      item: info.itemId ? cnName(info.itemId) : '-',
      addedBy: info.addedBy,
      date: info.addedAt.slice(0, 10)
    })
    await this.reply(username, lines.join('\n'), source)
  }

  private async _nodeRemove (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    if (!alias) {
      await this.reply(username, this.messages.text('nodeRemoveUsage'), source)
      return
    }
    if (!this.containerRegistry.remove(alias)) {
      await this.reply(username, this.messages.text('nodeRemoveNotFound', { alias }), source)
      return
    }
    await this.reply(username, this.messages.text('nodeRemoveSuccess', { alias }), source)
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

  private async _inv (username: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }

    const result = this.inventoryActions.listInventory()
    if (!result.success) {
      await this.reply(username, this.messages.text('invError', { message: result.message || '失败' }), source)
      return
    }

    if (!result.lines?.length) {
      await this.reply(username, this.messages.text('invEmpty'), source)
      return
    }

    const header = this.messages.text('invHeader', { count: result.lines.length })
    await this.reply(username, [header, ...result.lines].join('\n'), source)
  }

  private async _store (username: string, parts: string[], source: CommandSource): Promise<void> {
    const alias = parts[0]
    const itemQuery = parts[1]
    const count = parts[2] ? parseInt(parts[2], 10) : undefined

    if (!alias || !itemQuery) {
      await this.reply(username, this.messages.text('storeUsage'), source)
      return
    }

    const record = this.containerRegistry.get(alias)
    if (!record) {
      await this.reply(username, this.messages.text('containerInfoNotFound', { alias }), source)
      return
    }

    const result = await this.inventoryActions.storeInContainer(
      record.x,
      record.y,
      record.z,
      itemQuery,
      Number.isFinite(count) ? count : undefined,
      this.interactionDistance,
      this.approachDistance
    )
    await this.reply(username, result.success
      ? this.messages.text('storeSuccess', { message: result.message || '已存入' })
      : this.messages.text('storeError', { message: result.message || '存入失败' }), source)
  }

  private async _take (username: string, parts: string[], source: CommandSource): Promise<void> {
    const alias = parts[0]
    const itemQuery = parts[1]
    const count = parts[2] ? parseInt(parts[2], 10) : undefined

    if (!alias || !itemQuery) {
      await this.reply(username, this.messages.text('takeUsage'), source)
      return
    }

    const record = this.containerRegistry.get(alias)
    if (!record) {
      await this.reply(username, this.messages.text('containerInfoNotFound', { alias }), source)
      return
    }

    const result = await this.inventoryActions.takeFromContainer(
      record.x,
      record.y,
      record.z,
      itemQuery,
      Number.isFinite(count) ? count : undefined,
      this.interactionDistance,
      this.approachDistance
    )
    await this.reply(username, result.success
      ? this.messages.text('takeSuccess', { message: result.message || '已取出' })
      : this.messages.text('takeError', { message: result.message || '取出失败' }), source)
  }

  private async _drop (username: string, parts: string[], source: CommandSource): Promise<void> {
    // Item display names may contain a duration (for example "抗火药水 8分钟").
    // Only a final all-digit argument is interpreted as the optional quantity.
    const last = parts.at(-1)
    const count = last && /^\d+$/.test(last) ? parseInt(parts.pop() as string, 10) : undefined
    const itemQuery = parts.join(' ')

    if (!itemQuery) {
      await this.reply(username, this.messages.text('dropUsage'), source)
      return
    }

    const result = await this.inventoryActions.dropItem(
      itemQuery,
      Number.isFinite(count) ? count : undefined
    )
    await this.reply(username, result.success
      ? this.messages.text('dropSuccess', { message: result.message || '已丢弃' })
      : this.messages.text('dropError', { message: result.message || '丢弃失败' }), source)
  }

  private async _dropAll (username: string, source: CommandSource): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) { await this.reply(username, this.messages.text('botNotReady'), source); return }
    const items = bot.inventory.items()
    for (const item of items) {
      try { await bot.tossStack(item) } catch { /* skip */ }
    }
    await this.reply(username, this.messages.text('dropAllSuccess', { count: items.length }), source)
  }

  private async _hold (username: string, itemName: string | undefined, source: CommandSource): Promise<void> {
    if (!itemName) { await this.reply(username, this.messages.text('holdUsage'), source); return }
    const bot = this.mcBot.bot
    if (!bot) return
    const matches = findMatchingItems(bot.inventory.items(), itemName)
    if (matches.length === 0) { await this.reply(username, this.messages.text('holdNotFound', { item: itemName }), source); return }
    await bot.equip(matches[0], 'hand')
    await this.reply(username, this.messages.text('holdSuccess', { item: itemDisplayName(matches[0]) }), source)
  }

  private async _useItem (username: string, args: string, source: CommandSource): Promise<void> {
    const result = this.useItemModule.startUse(args, () => {
      void this.reply(username, this.messages.text('useComplete'), source)
    }, () => {
      void this.reply(username, this.messages.text('useFailed'), source)
    })
    await this.reply(username, result, source)
  }

  private async _placeBlock (username: string, args: string, source: CommandSource): Promise<void> {
    await this.reply(username, this.useItemModule.startPlace(args, username), source)
  }

  private async _lookAt (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (parts.length === 2) {
      const yaw = parseFloat(parts[0]), pitch = parseFloat(parts[1])
      if (!isNaN(yaw) && !isNaN(pitch)) {
        await this.reply(username, this.useItemModule.look(yaw, pitch), source)
        return
      }
    }
    if (parts.length === 1) {
      const res = this.useItemModule.lookPlayer(parts[0])
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
    await this.reply(username, await this.useItemModule.lookAtCoord(x, y, z), source)
  }

  private async _waterFill (username: string, choice: string | undefined, source: CommandSource): Promise<void> {
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

  private async _phomeWlAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, this.messages.text('phomeSaOnly'), source); return }
    if (!target) { await this.reply(username, this.messages.text('phomeWlAddUsage'), source); return }
    if (this.isPhomeAllowed(target)) { await this.reply(username, this.messages.text('phomeWlAlready', { target }), source); return }
    this.db.prepare('INSERT OR REPLACE INTO phome_whitelist (game_name, level) VALUES (?, ?)').run(target, 'wl')
    await this.reply(username, this.messages.text('phomeWlAddSuccess', { target }), source)
  }

  private async _phomeWlRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, this.messages.text('phomeSaOnly'), source); return }
    if (!target) { await this.reply(username, this.messages.text('phomeWlRemoveUsage'), source); return }
    if (!this.isPhomeAllowed(target)) { await this.reply(username, this.messages.text('phomeWlNotFound', { target }), source); return }
    this.db.prepare('DELETE FROM phome_whitelist WHERE game_name = ?').run(target)
    await this.reply(username, this.messages.text('phomeWlRemoveSuccess', { target }), source)
  }

  private async _phomeWlListCmd (username: string, source: CommandSource): Promise<void> {
    const rows = this.db.prepare('SELECT game_name FROM phome_whitelist WHERE level = ? ORDER BY game_name').all('wl') as Array<{ game_name: string }>
    const list = rows.map(r => r.game_name).join(', ')
    await this.reply(username, this.messages.text('phomeWlList', { list }), source)
  }

  private async _phomeSaAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, this.messages.text('phomeSaAddUsage'), source); return }
    if (this.isPhomeSa(target)) { await this.reply(username, this.messages.text('phomeSaAlready', { target }), source); return }
    this.db.prepare("INSERT INTO phome_whitelist (game_name, level) VALUES (?, 'sa') ON CONFLICT(game_name) DO UPDATE SET level = 'sa'").run(target)
    await this.reply(username, this.messages.text('phomeSaAddSuccess', { target }), source)
  }

  private async _phomeSaRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, this.messages.text('phomeSaRemoveUsage'), source); return }
    if (!this.isPhomeSa(target)) { await this.reply(username, this.messages.text('phomeSaNotFound', { target }), source); return }
    this.db.prepare("UPDATE phome_whitelist SET level = 'wl' WHERE game_name = ? AND level = 'sa'").run(target)
    await this.reply(username, this.messages.text('phomeSaRemoveSuccess', { target }), source)
  }

  private async _phomeSaList (username: string, source: CommandSource): Promise<void> {
    const rows = this.db.prepare("SELECT game_name FROM phome_whitelist WHERE level = 'sa' ORDER BY game_name").all() as Array<{ game_name: string }>
    const list = rows.map(r => r.game_name).join(', ')
    await this.reply(username, this.messages.text('phomeSaList', { list }), source)
  }

  private async _phomePointAdd (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, this.messages.text('phomeSaOnly'), source); return }
    if (parts.length < 2) { await this.reply(username, this.messages.text('phomePointAddUsage'), source); return }
    const noIdCmds = new Set(['/home', '/ts', '/tsl'])
    const toPos = (s: string | undefined): number | undefined => {
      const n = s ? parseInt(s, 10) : undefined
      return n !== undefined && n > 0 ? n - 1 : undefined
    }
    const alias = parts[0]
    let id: string | undefined
    let cmd: string
    let pos: number | undefined

    if (parts.length >= 4) {
      id = parts[1]
      cmd = parts[2]
      pos = toPos(parts[3])
    } else if (parts.length === 3) {
      if (noIdCmds.has(parts[1]) || /^\d+$/.test(parts[2])) {
        cmd = parts[1]
        pos = toPos(parts[2])
      } else {
        id = parts[1]
        cmd = parts[2]
      }
    } else {
      cmd = parts[1]
    }

    const result = this.teleportService.addPhomePoint(alias, id, cmd, pos)
    await this.reply(username, result.message!, source)
  }

  private async _phomePointRemove (username: string, numStr: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, this.messages.text('phomeSaOnly'), source); return }
    if (!numStr) { await this.reply(username, this.messages.text('phomePointRemoveUsage'), source); return }
    const num = parseInt(numStr, 10)
    if (isNaN(num)) { await this.reply(username, this.messages.text('invalidNumber'), source); return }
    const result = this.teleportService.removePhomePoint(num - 1)
    await this.reply(username, result.message!, source)
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
    if (sub === '取消' || sub === 'cancel') {
      const label = (parts.shift() || '').trim()
      if (!label) {
        await this.reply(username, this.messages.text('timerCancelUsage'), source)
        return
      }
      await this._timerCancel(username, label, source)
      return
    }
    if (sub === '列表' || sub === 'list') {
      await this._timerList(username, source)
      return
    }
    const label = sub
    if (!label) {
      await this.reply(username, this.messages.text('timerUsage'), source)
      return
    }
    const raw = (parts.shift() || '').trim()
    const seconds = this.parseTimerDuration(raw)
    if (seconds === null || seconds <= 0) {
      await this.reply(username, this.messages.text('timerInvalid', { input: raw || '空' }), source)
      return
    }
    if (seconds > 200 * 1200) {
      await this.reply(username, this.messages.text('timerTooLong'), source)
      return
    }
    // 显示沿用用户原始输入（如 "5天"、"1小时30分钟"），不重新格式化，避免 5天→1小时40分钟 这类错位
    const display = raw.trim().toLowerCase().replace(/\s+/g, '')
    const replaced = this.startTimer(username, label, seconds, display)
    await this.reply(username, this.messages.text(replaced ? 'timerReplaced' : 'timerStarted', { label, display }), source)
  }

  private timerKey (username: string, label: string): string {
    return `${username.toLowerCase()}::${label.toLowerCase()}`
  }

  /** 解析时长：支持 秒/s、分/分钟/m、小时/h、游戏日；游戏日按 MC 游戏日（1游戏日=20分钟），可组合如 "1小时30分钟"、"90m"；不再支持 天/d */
  private parseTimerDuration (raw: string): number | null {
    const value = raw.trim().toLowerCase().replace(/\s+/g, '')
    if (!value) return null
    const units: Record<string, number> = {
      '秒': 1, 's': 1,
      '分': 60, '分钟': 60, 'm': 60,
      '小时': 3600, 'h': 3600,
      '游戏日': 1200
    }
    // 注意：不提供 '天'/'d'，避免与游戏日混淆；天/天缩写一律按无效时长处理
    const pattern = /(\d+(?:\.\d+)?)([a-z一-龥]+)/g
    let total = 0
    let cursor = 0
    let matched = false
    let m: RegExpExecArray | null
    while ((m = pattern.exec(value)) !== null) {
      if (m.index !== cursor) return null // 中间有非法字符
      const mult = units[m[2]]
      if (mult === undefined) return null
      total += Number(m[1]) * mult
      cursor = pattern.lastIndex
      matched = true
    }
    if (!matched || cursor !== value.length) return null
    return total
  }

  private formatTimerDuration (seconds: number): string {
    if (seconds >= 86400) {
      const d = seconds / 86400
      return `${d % 1 === 0 ? d : d.toFixed(1)}天`
    }
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600)
      const m = Math.round((seconds % 3600) / 60)
      return m > 0 ? `${h}小时${m}分钟` : `${h}小时`
    }
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60)
      const s = seconds % 60
      return s > 0 ? `${m}分钟${s}秒` : `${m}分钟`
    }
    return `${seconds}秒`
  }

  /** 返回是否覆盖了旧定时（同玩家同标签已存在） */
  private startTimer (username: string, label: string, seconds: number, display?: string): boolean {
    const key = this.timerKey(username, label)
    const existing = this.timers.get(key)
    const replaced = existing !== undefined
    if (existing) clearTimeout(existing.handle)
    const shown = display ?? this.formatTimerDuration(seconds)
    const handle = setTimeout(() => {
      this.timers.delete(key)
      const msg = this.messages.text('timerDone', { label, display: shown })
      try { this.mcBot.whisper(username, msg) } catch { /* 私信失败静默 */ }
    }, seconds * 1000)
    this.timers.set(key, { username, label, finishAt: Date.now() + seconds * 1000, display: shown, handle })
    return replaced
  }

  private async _timerCancel (username: string, label: string, source: CommandSource): Promise<void> {
    const key = this.timerKey(username, label)
    const t = this.timers.get(key)
    if (!t) {
      await this.reply(username, this.messages.text('timerCancelNotFound', { label }), source)
      return
    }
    clearTimeout(t.handle)
    this.timers.delete(key)
    await this.reply(username, this.messages.text('timerCanceled', { label }), source)
  }

  private async _timerList (username: string, source: CommandSource): Promise<void> {
    const mine = [...this.timers.values()]
      .filter(t => t.username.toLowerCase() === username.toLowerCase())
      .sort((a, b) => a.finishAt - b.finishAt)
    if (mine.length === 0) {
      await this.reply(username, this.messages.text('timerListEmpty'), source)
      return
    }
    const lines = mine.map(t => `${t.label} (${t.display})`)
    await this.reply(username, this.messages.text('timerList', { list: lines.join(', ') }), source)
  }

  /** 停止全部定时（重载/退出时调用，防止旧 handler 的倒计时幽灵私信） */
  disposeTimers (): void {
    for (const t of this.timers.values()) clearTimeout(t.handle)
    this.timers.clear()
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

  /**
   * 终端重载：优先走 app 层注册的进程内软重启（拆模块 + 清 require.cache + 重建，保持窗口不断开进程），
   * 未注册时退化为"以相同参数拉起新进程接管"。仅限终端使用。
   */
  private async _reloadBot (source: CommandSource): Promise<void> {
    if (source !== 'console') {
      await this.reply('console-admin', '重载 仅限终端使用', source)
      return
    }
    if (reloadHook) {
      await this.reply('console-admin', '正在重载 bot 脚本（进程内软重启，保持窗口）...', 'console')
      setTimeout(() => { reloadHook?.() }, 300)
      return
    }
    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: { ...process.env, YAMB_RELOAD: '1' },
        stdio: 'inherit'
      })
      child.unref()
      await this.reply('console-admin', '正在重载 bot 脚本，新进程将自动接管...', 'console')
      setTimeout(() => process.exit(0), 1000)
    } catch (err) {
      await this.reply('console-admin', `重载失败: ${(err as Error).message}`, 'console')
    }
  }

  private async _jumpCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    const arg = parts[0]
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
