import type { BotBehaviorConfig, CommandConfig } from '../../types'
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
import type SystemMessageBuffer from './system-buffer'
import type LoopCmd from '../loopcmd'
import type BotSync from '../botsync'
import CommandMessages from './messages'
import { sleep } from '../../platform/sleep'
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
import { performDismount } from '../../actions/shared/entity-utils'
import type { DatabaseSync } from 'node:sqlite'

export default class CommandHandler {
  private mcBot: MinecraftBot
  private teleportService: TeleportService
  private gameApiService: GameApiService
  private playerInteraction: PlayerInteractionService
  private minecartInteraction: MinecartInteractionService
  private ridingManager: RidingManager
  private loopCmd: LoopCmd
  private botSync: BotSync
  private db: DatabaseSync
  private jumpModule: JumpModule
  private useItemModule: UseItemModule
  private botIndex: number
  private cascadeDelayMs: number
  private cascadeTimer: ReturnType<typeof setTimeout> | null = null
  private cascadePlayer: string | null = null
  private containerRegistry: ContainerRegistry
  private inventoryActions: InventoryActions
  private systemBuffer: SystemMessageBuffer
  private whitelist: Whitelist
  private standby: StandbyManager
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
    botSync: BotSync,
    db: DatabaseSync,
    containerRegistry: ContainerRegistry,
    inventoryActions: InventoryActions,
    systemBuffer: SystemMessageBuffer,
    whitelist: Whitelist,
    standby: StandbyManager,
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
    this.loopCmd = loopCmd
    this.botSync = botSync
    this.db = db
    this.botIndex = parseInt(process.env.BOT_INDEX || '1', 10)
    this.cascadeDelayMs = parseInt(process.env.BOT_CASCADE_DELAY_MS || '0', 10)
    this.containerRegistry = containerRegistry
    this.inventoryActions = inventoryActions
    this.systemBuffer = systemBuffer
    this.whitelist = whitelist
    this.standby = standby
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

  isWhitelisted (username: string): boolean {
    return this.whitelist.isAllowed(username)
  }

  isBlacklisted (username: string): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM blacklist WHERE game_name = ?').get(username) as { ok: number } | undefined
    return row !== undefined
  }

  getBotIndex(): number { return this.botIndex }

  private tpaNotes = new Map<string, string>()
  private cascadeCancelled = new Set<string>()

  handleCascadeCancelFor(player: string): void {
    this.cascadeCancelled.add(player)
    if (this.cascadeTimer && this.cascadePlayer === player) {
      clearTimeout(this.cascadeTimer)
      this.cascadeTimer = null
      this.cascadePlayer = null
    }
    setTimeout(() => this.cascadeCancelled.delete(player), 5000)
  }

  handleCascadeCancel(): void {
    if (this.cascadeTimer) {
      clearTimeout(this.cascadeTimer)
      this.cascadeTimer = null
      this.cascadePlayer = null
    }
  }

  handleCascadeBusy(playerName: string): void {
    console.log(`[Cascade] Bot upstream busy for ${playerName}, still waiting ${this.cascadeDelayMs}ms`)
  }

  handlePhomeResult(success: boolean, player: string): void {
    if (this.teleportService.isPhomeActive()) {
      if (success) {
        const user = this.teleportService.phomeAccepted()
        this.reply(user, '传送成功', 'whisper').catch(() => {})
      } else {
        const user = this.teleportService.phomeRejected()
        this.reply(user, '传送被拒绝', 'whisper').catch(() => {})
      }
    }
  }

  handleTpaSuccess(player: string): void {
    const note = this.tpaNotes.get(player)
    this.tpaNotes.delete(player)
    this.teleportService.lock(player, note)
    this.teleportService.clearBusy()
    let msg = '传送成功'
    if (note) msg += ` | 备注: ${note}`
    msg += ' | %解锁'
    this.reply(player, msg, 'whisper').catch(() => {})
  }

  private async handleCascadeTrigger(username: string, source: CommandSource): Promise<void> {
    // If Bot1 already handled, don't start cascade
    if (this.cascadeCancelled.has(username)) return

    if (this.botIndex === 1) {
      await this._doTpa(username, source)
      return
    }

    if (this.cascadeTimer) return

    this.cascadePlayer = username
    console.log(`[Cascade] Bot${this.botIndex} waiting ${this.cascadeDelayMs}ms for ${username}`)

    this.cascadeTimer = setTimeout(async () => {
      this.cascadeTimer = null
      if (!this.cascadePlayer) return
      const player = this.cascadePlayer
      this.cascadePlayer = null

      if (this.mcBot.isReady && this.mcBot.bot) {
        if (this.teleportService.isLocked() || this.teleportService.isCommandBusy()) {
          const isLastBot = this.botIndex === 3
          if (isLastBot) {
            await this.reply(player, '繁忙中', source)
          } else {
            this.botSync.syncBusy(player)
          }
          return
        }
        await this._doTpa(player, source)
      }
    }, this.cascadeDelayMs)
  }

  private async _doTpa(username: string, source: CommandSource, note?: string): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) return
    if (this.teleportService.isLocked() && username !== this.teleportService.getLockedBy() && !this.isAdmin(username)) return
    if (this.teleportService.isCommandBusy()) {
      this.botSync.syncBusy(username)
      return
    }

    if (!this.isWhitelisted(username) && !this.isAdmin(username)) {
      await this.reply(username, '你不在白名单中。', source)
      return
    }

    this.teleportService.setBusy(username)
    if (note) this.tpaNotes.set(username, note)
    this.mcBot.chat(`/tpa ${username}`)
    await this.reply(username, '已发送传送请求', source)
  }

  handleTpaFailed(): void {
    const user = this.teleportService.getBusyUser()
    this.teleportService.clearBusy()
    if (user) this.reply(user, '传送失败。', 'whisper').catch(() => {})
  }

  private useWhisperReply (source: CommandSource): boolean {
    return this.replyAlwaysWhisper || source === 'whisper'
  }

  async reply (username: string, message: string, source: CommandSource): Promise<void> {
    const text = message.replace(/\n/g, ' | ')
    if (!text.trim()) return
    const ok = this.mcBot.whisper(username, `#d9afd9${text}`)
    if (!ok) {
      console.warn(`[Command] 回复失败 -> ${username}: ${text}`)
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

  async handle (username: string, message: string, source: CommandSource): Promise<void> {
    if (username === this.mcBot.bot?.username) return

    if (this.isBlacklisted(username)) return

    const text = normalizeInput(message)
    if (!text) return
    const isPhomeNum = /^%?\d+$/.test(text)
    if (!isPhomeNum && !this.isWhitelisted(username)) return
    console.log(`[DEBUG] handle: ${source}:${username} text="${text}" isPhomeNum=${isPhomeNum} whitelisted=${this.isWhitelisted(username)}`)

    // Lock check: only locked player and admins can control bot
    if (this.teleportService.isLocked() && !isPhomeNum) {
      const cmd = text.split(/\s+/)[0]?.toLowerCase() || ''
      const allowedCmds = ['解锁', '状态', '状态2', '状态3', 'status', 'status2', 'status3', 'unlock', '挂机', 'phome', '0', '跳跃', 'xjump', '改锁定']
      if (username !== this.teleportService.getLockedBy() && !this.isAdmin(username) && !allowedCmds.includes(cmd)) {
        return
      }
    }

    let parts: string[] | null = null

    if (source === 'whisper') {
      parts = parseWhisperCommand(text)
      if (!parts) return
    } else {
      if (!this.allowPublicCommands) return
      if (!matchesPrefix(text, this.prefix)) { console.log(`[DEBUG] prefix mismatch: "${text}"`); return }
      const args = parsePrefixedArgs(text, this.prefix)
      console.log(`[DEBUG] public args:`, args)
      if (args.length === 0) {
        await this.reply(username, this.messages.text('emptyCommand'), source)
        this.standby.scheduleAfk()
        return
      }
      parts = args
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
      if (['查 附魔', '指令 循环', '加phome 白名单', '移除phome 白名单', 'phome 白名单列表'].includes(cmd2)) {
        parts.shift()
        cmd = cmd2
      }
    }

    console.log(`[Command:${source}] ${username} -> ${cmd} ${parts.join(' ')}`.trim())

    switch (cmd) {
      // === Teleport ===
      case 'phome':
        await this._phome(username, parts[0], source)
        break
      case '挂机':
        await this._doTpa(username, source, parts.length > 0 ? parts.join(' ') : undefined)
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

      // === Admin ===
      case '加管理员':
        await this._adminAdd(username, parts[0], source)
        break
      case '移除管理员':
        await this._adminRemove(username, parts[0], source)
        break
      case '管理员列表':
        await this._adminList(username, source)
        break

      // === SuperAdmin ===
      case '超管':
        await this._saCmd(username, parts, source)
        break
      case '超管列表':
        await this._saList(username, source)
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
        await this._hold(username, parts[0], source)
        break

      // === Item Actions ===
      case 'use':
        await this._useItem(username, parts.join(' '), source)
        break
      case 'place':
        await this._placeBlock(username, parts.join(' '), source)
        break
      case 'look':
        await this._lookAt(username, parts, source)
        break

      // === Jump ===
      case '跳跃':
      case 'xjump':
        await this._jumpCmd(username, parts, source)
        break

      // === Enchant ===
      case '查 附魔':
        await this._enchantInfo(username, parts.join(' '), source)
        break

      // === Execute ===
      case '指令':
        await this._execCmd(username, parts.join(' '), source)
        break
      case '指令循环':
      case '指令 循环':
        await this._loopCmd(username, parts, source)
        break

      // === Interaction ===
      // === Container ===
      case 'container':
        await this._container(username, parts, source)
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
        if (/^\d+$/.test(cmd)) {
          const num = parseInt(cmd, 10)
          if (num === 0) { await this._phomeList(username, source) } else { await this._phomeNumber(username, num, source) }
          break
        }
        await this.reply(username, this.messages.text('unknownCommand', { cmd }), source)
    }

    this.standby.scheduleAfk()
  }

  private async _phome (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!alias) {
      await this.reply(username, this.teleportService.getPhomeListText(), source)
      return
    }

    const wp = this.teleportService.getWaypointByAlias(alias)
    if (!wp) {
      await this.reply(username, `未知传送点: ${alias}`, source)
      return
    }

    const waypoints = this.teleportService.listWaypoints()
    const idx = waypoints.findIndex(w => w.alias === alias)
    if (idx < 0) return
    if (!this.teleportService.isOwned(idx)) return

    if (this.teleportService.isLocked()) {
      const lockedBy = this.teleportService.getLockedBy()
      const secs = this.teleportService.getLockedTicks() / 20
      const m = Math.floor(secs / 60)
      const s = Math.floor(secs % 60)
      await this.reply(username, `已被 ${lockedBy} 锁定 ${m}分${s}秒。`, source)
      return
    }
    if (this.teleportService.isCommandBusy()) return

    const result = await this.teleportService.executePhome(username, idx)
    if (!result.success && result.message) {
      await this.reply(username, result.message, source)
    }
  }

  private async _phomeList (username: string, source: CommandSource): Promise<void> {
    if (source === 'chat' && this.botIndex !== 1) return
    await this.reply(username, this.teleportService.getPhomeListText(), source)
  }

  private async _phomeNumber (username: string, num: number, source: CommandSource): Promise<void> {
    const idx = num - 1
    if (!this.teleportService.isOwned(idx)) return

    if (this.teleportService.isLocked()) {
      const lockedBy = this.teleportService.getLockedBy()
      const secs = this.teleportService.getLockedTicks() / 20
      const m = Math.floor(secs / 60)
      const s = Math.floor(secs % 60)
      await this.reply(username, `已被 ${lockedBy} 锁定 ${m}分${s}秒。`, source)
      return
    }
    if (this.teleportService.isCommandBusy()) {
      await this.reply(username, '传送失败。', source)
      return
    }

    if (!this.isPhomeAllowed(username)) {
      await this.reply(username, '本机器人仅限拉特兰成员使用，请加入拉特兰后重试。', source)
      return
    }

    const result = await this.teleportService.executePhome(username, idx)
    if (!result.success && result.message) {
      await this.reply(username, result.message, source)
    }
  }

  private latelanMembers = new Set<string>()

  addLatelanMember(username: string): void {
    if (!this.latelanMembers.has(username)) {
      this.latelanMembers.add(username)
      console.log(`[Phome] 拉特兰成员: ${username}`)
    }
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
        if (dist > 6) continue
        if ((e as { username?: string }).username?.toLowerCase() === targetName.toLowerCase()) { entity = e; break }
      }
    }
    if (!entity) { await this.reply(username, `6格内无此玩家: ${targetName}`, source); return }

    try {
      if (this.ridingManager.isActive()) {
        bot.dismount()
        this.ridingManager.clearMode()
        await sleep(200)
      }
      await bot.unequip('hand')
      await bot.lookAt(entity.position.offset(0, 1.6, 0), true)
      bot.activateEntityAt(entity, entity.position.offset(0, 1.6, 0))
      this.ridingManager.enterPlayerMode(targetName)
      await this.reply(username, `已骑乘 ${targetName}`, source)
    } catch (err) {
      await this.reply(username, `骑乘失败: ${(err as Error).message}`, source)
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
    const bot = this.mcBot.bot
    if (!bot) return
    const ok = await performDismount(bot)
    this.ridingManager.clearMode()
    if (!ok) {
      await this.reply(username, this.messages.text('unmountError', { message: '下车失败，请重试' }), source)
      return
    }
    await this.reply(username, '已下车', source)
  }

  private async _sneakCmd (username: string, source: CommandSource): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) return
    const wasSneaking = bot.getControlState('sneak')
    if (wasSneaking) {
      bot.setControlState('sneak', false)
      await this.reply(username, '已起身', source)
    } else {
      bot.setControlState('sneak', true)
      await this.reply(username, '已蹲下', source)
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

  private async _lock (username: string, source: CommandSource, arg?: string): Promise<void> {
    if (this.teleportService.isLocked()) {
      const lockedBy = this.teleportService.getLockedBy()
      await this.reply(username, `已被 ${lockedBy} 锁定中。`, source)
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
    this.botSync.syncWhitelistAdd(gameName)
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
    this.botSync.syncWhitelistRemove(gameName)
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

    const msg = `状态: ${this.resolveActivityStatus()} | 运行: ${hours}h${minutes}m | 位置: ${this.formatPosition()}`
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
    const itemQuery = parts[0]
    const count = parts[1] ? parseInt(parts[1], 10) : undefined

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
    if (!bot) { await this.reply(username, 'bot not ready', source); return }
    const items = bot.inventory.items()
    for (const item of items) {
      try { await bot.tossStack(item) } catch { /* skip */ }
    }
    await this.reply(username, `已丢弃 ${items.length} 组物品`, source)
  }

  private async _hold (username: string, itemName: string | undefined, source: CommandSource): Promise<void> {
    if (!itemName) { await this.reply(username, '用法: 手持 <物品名>', source); return }
    const bot = this.mcBot.bot
    if (!bot) return
    const item = bot.inventory.items().find(i => i.name.includes(itemName))
    if (!item) { await this.reply(username, `没有 ${itemName}`, source); return }
    await bot.equip(item, 'hand')
    await this.reply(username, `已手持 ${item.name}`, source)
  }

  private async _useItem (username: string, args: string, source: CommandSource): Promise<void> {
    await this.reply(username, this.useItemModule.startUse(args), source)
  }

  private async _placeBlock (username: string, args: string, source: CommandSource): Promise<void> {
    await this.reply(username, this.useItemModule.startPlace(args), source)
  }

  private async _lookAt (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (parts.length < 3) { await this.reply(username, '用法: xlook <x> <y> <z>', source); return }
    const x = parseFloat(parts[0]), y = parseFloat(parts[1]), z = parseFloat(parts[2])
    await this.reply(username, this.useItemModule.look(x, y, z), source)
  }

  private async _blacklistCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    const sub = (parts.shift() || '').toLowerCase()
    const target = parts[0]
    if (sub === 'add' && target) {
      if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
      this.db.prepare('INSERT OR REPLACE INTO blacklist (game_name, added_by) VALUES (?, ?)').run(target, username)
      this.botSync.broadcast(`!bladd ${target}`)
      await this.reply(username, `已加入黑名单: ${target}`, source)
    } else if (sub === 'remove' && target) {
      if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
      this.db.prepare('DELETE FROM blacklist WHERE game_name = ?').run(target)
      this.botSync.broadcast(`!blremove ${target}`)
      await this.reply(username, `已从黑名单移除: ${target}`, source)
    } else if (sub === 'list') {
      const rows = this.db.prepare('SELECT game_name FROM blacklist ORDER BY game_name').all() as Array<{ game_name: string }>
      const list = rows.map(r => r.game_name).join(', ') || '空'
      await this.reply(username, `黑名单: ${list}`, source)
    }
  }

  private async _unlockAll (username: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    this.teleportService.unlock()
    this.botSync.broadcast('!unlockall')
    await this.reply(username, '所有 bot 已解锁。', source)
  }

  private async _transferLock (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, '用法: 改锁定 <玩家>', source); return }
    if (!this.teleportService.isLocked()) { await this.reply(username, '当前未锁定。', source); return }
    this.teleportService.transferLock(target)
    await this.reply(username, `已转移锁定给 ${target}。`, source)
  }

  private async _wlList (username: string, source: CommandSource): Promise<void> {
    const list = this.whitelist.list()
    const names = Object.keys(list).join(', ') || '空'
    await this.reply(username, `白名单: ${names}`, source)
  }

  private async _adminAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, '用法: 加管理员 <玩家>', source); return }
    this.adminList.add(target)
    await this.reply(username, `已添加管理员: ${target}`, source)
  }

  private async _adminRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, '用法: 移除管理员 <玩家>', source); return }
    this.adminList.delete(target)
    await this.reply(username, `已移除管理员: ${target}`, source)
  }

  private async _adminList (username: string, source: CommandSource): Promise<void> {
    const list = [...this.adminList].join(', ') || '空'
    await this.reply(username, `管理员: ${list}`, source)
  }

  private async _saCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    const saName = process.env.MC_SUPERADMIN || 'XieveTte'
    if (username !== saName) { await this.reply(username, this.messages.text('noPermission'), source); return }
    const sub = (parts.shift() || '').toLowerCase()
    const target = parts[0]
    if (sub === 'add' && target) {
      this.adminList.add(target)
      await this.reply(username, `已添加超管: ${target}`, source)
    } else if (sub === 'remove' && target) {
      this.adminList.delete(target)
      await this.reply(username, `已移除超管: ${target}`, source)
    } else {
      await this.reply(username, '用法: 超管 add/remove <玩家>', source)
    }
  }

  private async _saList (username: string, source: CommandSource): Promise<void> {
    const saName = process.env.MC_SUPERADMIN || 'XieveTte'
    await this.reply(username, `超管: ${saName}`, source)
  }

  private async _phomeWlAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, '无权限，仅Phome超管可用。', source); return }
    if (!target) { await this.reply(username, '用法: 加phome白名单 <玩家>', source); return }
    if (this.isPhomeAllowed(target)) { await this.reply(username, `${target} 已在Phome白名单中。`, source); return }
    this.db.prepare('INSERT OR REPLACE INTO phome_whitelist (game_name, level) VALUES (?, ?)').run(target, 'wl')
    this.botSync.syncPhomeWlAdd(target)
    await this.reply(username, `已添加 ${target} 到Phome白名单。`, source)
  }

  private async _phomeWlRemove (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, '无权限，仅Phome超管可用。', source); return }
    if (!target) { await this.reply(username, '用法: 移除phome白名单 <玩家>', source); return }
    if (!this.isPhomeAllowed(target)) { await this.reply(username, `${target} 不在Phome白名单中。`, source); return }
    this.db.prepare('DELETE FROM phome_whitelist WHERE game_name = ?').run(target)
    this.botSync.syncPhomeWlRemove(target)
    await this.reply(username, `已从Phome白名单移除 ${target}。`, source)
  }

  private async _phomeWlListCmd (username: string, source: CommandSource): Promise<void> {
    const rows = this.db.prepare('SELECT game_name FROM phome_whitelist WHERE level = ? ORDER BY game_name').all('wl') as Array<{ game_name: string }>
    const list = rows.map(r => r.game_name).join(', ')
    await this.reply(username, `Phome白名单: ${list}`, source)
  }

  private async _phomePointAdd (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, '无权限，仅Phome超管可用。', source); return }
    if (parts.length < 2) { await this.reply(username, '用法: 加phome点 <名称> <指令>', source); return }
    const result = this.teleportService.addPhomePoint(parts[0], parts[1])
    await this.reply(username, result.message!, source)
  }

  private async _phomePointRemove (username: string, numStr: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isPhomeSa(username)) { await this.reply(username, '无权限，仅Phome超管可用。', source); return }
    if (!numStr) { await this.reply(username, '用法: 移除phome点 <编号>', source); return }
    const num = parseInt(numStr, 10)
    if (isNaN(num)) { await this.reply(username, '无效的编号', source); return }
    const result = this.teleportService.removePhomePoint(num - 1)
    await this.reply(username, result.message!, source)
  }

  private async _blacklistAdd (username: string, target: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!target) { await this.reply(username, '用法: 加黑 <玩家>', source); return }
    this.db.prepare('INSERT OR REPLACE INTO blacklist (game_name, added_by) VALUES (?, ?)').run(target, username)
    this.botSync.broadcast(`!bladd ${target}`)
    await this.reply(username, `已加入黑名单: ${target}`, source)
  }

  private async _enchantInfo (username: string, query: string, source: CommandSource): Promise<void> {
    if (source === 'chat' && this.botIndex !== 1) return
    const info = lookEnchant(query)
    if (!info) {
      await this.reply(username, `未找到附魔: ${query}`, source)
      return
    }
    await this.reply(username, info, source)
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
          this.reply(username, `跳跃 ${count} 次完成。`, source).catch(() => {})
        })
        await this.reply(username, this.jumpModule.startCount(count), source)
      } else {
        await this.reply(username, '用法: xjump [次数|无限|停止]', source)
      }
    }
  }

  private async _execCmd (username: string, cmd: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) { await this.reply(username, this.messages.text('noPermission'), source); return }
    if (!cmd) { await this.reply(username, '用法: exec <命令>', source); return }
    this.mcBot.chat(cmd)
    await this.reply(username, `已执行: ${cmd}`, source)
  }

  private async _loopCmd (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isAdmin(username) && !this.isWhitelisted(username)) return
    const first = (parts.shift() || '').toLowerCase()

    if (first === '停止' || first === 'stop') {
      this.loopCmd.stop()
      await this.reply(username, '循环已停止', source)
      return
    }
    if (first === '状态' || first === 'status') {
      const cfg = this.loopCmd.getConfig()
      await this.reply(username, cfg.enabled
        ? `循环中: "${cfg.text}" 每 ${cfg.intervalSec}s`
        : '无循环', source)
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
        await this.reply(username, '用法: %指令循环 间隔1.1s /kiss XieveTte', source)
        return
      }
    } else {
      parts.unshift(first)
      cmd = parts.join(' ')
    }

    if (!cmd) {
      await this.reply(username, '用法: %指令循环 间隔1.1s /kiss XieveTte', source)
      return
    }

    this.loopCmd.update(cmd, intervalSec)
    await this.reply(username, `循环已启动: "${cmd}" 每 ${intervalSec}s`, source)
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
