import fs from 'fs'
import path from 'path'
import type { ServiceResult, TeleportConfig, WaypointConfig, PhomeTownsConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type { DatabaseSync } from 'node:sqlite'
import { jumpAndHover } from '../../actions/shared/entity-utils'
import { debug, warn } from '../../platform/logger'

export default class TeleportService {
  /** 委托认领行 TTL：认领的 delegate 崩溃/掉线后自动过期，玩家可重新申请 */
  private static readonly PHOME_CLAIM_TTL_MS = 45000
  /** 认领结束后的宽限期：行保留一段时间，让 owner 的兜底仲裁（2.5s）仍能看到"已有人处理过" */
  private static readonly PHOME_RESOLVE_GRACE_MS = 10000
  /** 心跳写入间隔：已连接时每个 bot 周期写 last_seen，同镇 bot 据此判断 owner 是否离线 */
  private static readonly BOT_HEARTBEAT_INTERVAL_MS = 5000
  /** last_seen 超过该时长即判定离线（进程崩溃/掉线未回连），同镇 bot 可代执行 */
  private static readonly BOT_OFFLINE_THRESHOLD_MS = 20000
  /** 定期从磁盘重新加载点位列表并重建 owner 映射，运行中的 加phome点/移除phome点 无需重启即生效 */
  private static readonly CONFIG_REFRESH_INTERVAL_MS = 3000

  private mcBot: MinecraftBot
  private tpacceptCommand: string
  private tpdenyCommand: string
  private tpahereCommand: string
  private phomeCommand: string
  private waypointByAlias: Map<string, { id: string; cmd: string }>
  private waypointList: Array<{ id: string; alias: string; cmd: string }>
  private waypointDelayMs: number
  private locked = false
  private lockedBy: string | null = null
  private lockedNote: string | null = null
  private lockedTicks = 0
  private hoverLocked = false
  private lockTimer: ReturnType<typeof setInterval> | null = null
  private onUnlock: ((info: { wasHover: boolean }) => void) | null = null
  private phomeActive = false
  private commandBusy = false
  private busyUser: string | null = null
  /** 当前正在执行的 phome 传送点下标（owner 与 delegate 都记录，用于结束后释放 phome_claims） */
  private busyIndex = -1
  private phomeTimeout: ReturnType<typeof setTimeout> | null = null
  private _ownedIndices: number[] = []
  private _configPath = ''

  // === 小镇委托映射（来自 phome_towns.json + 各 teleportN.json 的 ownedIndices） ===
  private _phomeTowns: PhomeTownsConfig | null = null
  private _mainBot = ''
  private _townOfBot: Map<string, string> = new Map()
  private _botIndexOfBot: Map<string, number> = new Map()
  /** 传送点下标 → 归属 bot 名（由各 teleport 配置的 ownedIndices 汇总） */
  private _ownerOfIndex: Map<number, string> = new Map()
  /** 上次小镇映射签名；仅映射变化时输出日志，避免每 30s 刷新刷屏 */
  private _lastTownMapSig = ''
  private _myBotIndex = 0
  private _configDir = ''
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private configRefreshTimer: ReturnType<typeof setInterval> | null = null

  setConfigPath (p: string): void {
    this._configPath = p
  }

  constructor (mcBot: MinecraftBot, config: TeleportConfig) {
    this.mcBot = mcBot
    this.tpacceptCommand = config.tpacceptCommand
    this.tpdenyCommand = config.tpdenyCommand
    this.tpahereCommand = config.tpahereCommand
    this.phomeCommand = config.phomeCommand
    const waypoints = config.waypoints || []
    this.waypointList = waypoints.map(w => ({
      id: w.id,
      alias: w.alias || w.id,
      cmd: w.cmd || '/phome'
    }))
    this._ownedIndices = (config.ownedIndices ?? []).filter(i => i >= 0 && i < this.waypointList.length)
    this.waypointByAlias = new Map(
      this.waypointList.map(w => [w.alias, { id: w.id, cmd: w.cmd }])
    )
    this.waypointDelayMs = config.waypointDelayMs ?? 3000
    this.startLockTimer()
  }

  /** 从 DB 恢复锁定状态（进程启动时 / 重连 spawn 后调用）。
   *  注意：如果是重连（同一进程），内存里的锁状态通常还在（单例未销毁），
   *  此时 DB 值可能比内存旧（因为 lockedTicks 一直在计时、DB 只在 lock/unlock 时写），
   *  所以优先保留内存值；只在内存无锁时才从 DB 恢复（进程重启场景）。 */
  restoreLockState(): void {
    // 内存里已经有锁 → DB 值是旧的，不覆盖
    if (this.locked && this.lockedBy) {
      this.saveLockState() // 顺便把最新 lockedTicks 写回 DB
      return
    }
    // 内存无锁 → 从 DB 恢复（进程重启场景）
    if (!this._db) return
    try {
      this._db.exec("CREATE TABLE IF NOT EXISTS lock_state (bot_name TEXT PRIMARY KEY, locked_by TEXT, locked_note TEXT, locked_ticks INTEGER, hover_locked INTEGER DEFAULT 0)")
      try { this._db.exec("ALTER TABLE lock_state ADD COLUMN hover_locked INTEGER DEFAULT 0") } catch { /* */ }
      const row = this._db.prepare('SELECT locked_by, locked_note, locked_ticks, hover_locked FROM lock_state WHERE bot_name = ?').get(this._botName) as { locked_by: string; locked_note: string | null; locked_ticks: number; hover_locked: number } | undefined
      if (row?.locked_by) {
        this.locked = true
        this.lockedBy = row.locked_by
        this.lockedNote = row.locked_note || null
        this.lockedTicks = row.locked_ticks || 0
        this.hoverLocked = row.hover_locked === 1
        debug(`[Teleport] 从 DB 恢复锁定: ${this.lockedBy}${this.lockedNote ? ` (${this.lockedNote})` : ''}${this.hoverLocked ? ' (滞空)' : ''}`)
      }
    } catch (err) {
      warn('[Teleport] 恢复锁定状态失败:', (err as Error).message)
    }
  }

  private saveLockState(): void {
    try {
      if (!this._db) return
      try { this._db.exec("ALTER TABLE lock_state ADD COLUMN hover_locked INTEGER DEFAULT 0") } catch { /* */ }
      if (this.locked && this.lockedBy) {
        this._db.prepare('INSERT OR REPLACE INTO lock_state (bot_name, locked_by, locked_note, locked_ticks, hover_locked) VALUES (?, ?, ?, ?, ?)').run(this._botName, this.lockedBy, this.lockedNote, this.lockedTicks, this.hoverLocked ? 1 : 0)
      } else {
        this._db.prepare('DELETE FROM lock_state WHERE bot_name = ?').run(this._botName)
      }
    } catch { /* */ }
  }

  private _db: DatabaseSync | null = null
  private _botName = 'bot'

  setDb(db: DatabaseSync, botName: string): void {
    this._db = db
    this._botName = botName
    this.restoreLockState()
    this.startHeartbeat()
  }

  /** 状态文本：锁定(锁定人:备注) —— 时长单独用 getLockedTimeText() 取 */
  getStatusText(): string {
    if (!this.locked) return '空闲'
    const note = this.lockedNote ? `:${this.lockedNote}` : ''
    return `锁定(${this.lockedBy}${note})`
  }

  /** 已锁时长文本，如 "1时5分3秒" / "5分3秒" / "3秒" */
  getLockedTimeText(): string {
    const secs = this.lockedTicks / 20
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = Math.floor(secs % 60)
    if (h > 0) return `${h}时${m}分${s}秒`
    if (m > 0) return `${m}分${s}秒`
    return `${s}秒`
  }

  isOwned(idx: number): boolean {
    return this._ownedIndices.includes(idx)
  }

  // === 小镇委托 ===

  /**
   * 注入小镇配置并建立 下标→owner 映射（启动时）。
   * owner 映射由各 teleport{index}.json 的 ownedIndices 汇总而来（单一事实来源），
   * 因此每个 bot 进程启动时都会重新读一遍同目录下其他 bot 的配置；
   * 之后每 30s 由 startConfigRefresh 定期重建，让运行中 加phome点 无需重启即生效。
   */
  setPhomeTowns(cfg: PhomeTownsConfig, configDir: string): void {
    this._phomeTowns = cfg
    this._mainBot = cfg?.mainBot || ''
    this._configDir = configDir
    this.rebuildTownMaps()
    this.startConfigRefresh()
  }

  /** 重建 下标→owner 映射（启动时 + 定期刷新）。跳过读取失败/重复归属的 bot，其余照常生效 */
  private rebuildTownMaps(): void {
    this._townOfBot.clear()
    this._botIndexOfBot.clear()
    this._ownerOfIndex.clear()
    if (!this._phomeTowns?.bots) return

    for (const [name, info] of Object.entries(this._phomeTowns.bots)) {
      this._townOfBot.set(name, info.town)
      this._botIndexOfBot.set(name, info.index)
      if (name.toLowerCase() === this._botName.toLowerCase()) {
        this._myBotIndex = info.index
      }
    }

    for (const [name, info] of Object.entries(this._phomeTowns.bots)) {
      const file = info.index === 1 ? 'teleport.json' : `teleport${info.index}.json`
      const data = this.readConfigFile(path.join(this._configDir, file))
      if (!data) {
        warn(`[Teleport] 读取 ${file} 失败，${name} 的 /phome 点将无法被同镇 bot 委托`)
        continue
      }
      const indices = (data.ownedIndices as number[] | undefined) ?? []
      for (const idx of indices) {
        if (this._ownerOfIndex.has(idx)) {
          warn(`[Teleport] 重复归属 index ${idx}: ${this._ownerOfIndex.get(idx)} 与 ${name}`)
          continue
        }
        this._ownerOfIndex.set(idx, name)
      }
    }

    // 只在映射内容变化时输出（启动/配置变更时提示一次），平时 30s 刷新静默
    const sig = `${this._mainBot}|${this._townOfBot.size}|${this._ownerOfIndex.size}|` +
      [...this._townOfBot.entries()].map(([n, t]) => `${n}:${t}`).sort().join(',') + '|' +
      [...this._ownerOfIndex.entries()].map(([i, o]) => `${i}:${o}`).sort().join(',')
    if (sig !== this._lastTownMapSig) {
      this._lastTownMapSig = sig
      debug(`[Teleport] 小镇映射: mainBot=${this._mainBot}, ${this._townOfBot.size} bots, ${this._ownerOfIndex.size} 个点有归属`)
    }
  }

  /** 心跳：已连接时周期写 last_seen 到共享 DB。崩溃/掉线 → last_seen 停止更新 → 同镇 bot 判离线后代执行 */
  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this._db) return
    this.heartbeatTimer = setInterval(() => {
      if (!this._db || !this._botName || !this.mcBot.isReady) return
      try {
        this._db.prepare(
          'INSERT OR REPLACE INTO bot_heartbeat (bot_name, last_seen) VALUES (?, ?)'
        ).run(this._botName, Date.now())
      } catch { /* 写失败下次再试 */ }
    }, TeleportService.BOT_HEARTBEAT_INTERVAL_MS)
  }

  /** 定期从磁盘同步点位变化：本 bot 重载自己的列表，owner 映射从兄弟配置重建 */
  private startConfigRefresh(): void {
    if (this.configRefreshTimer) return
    this.configRefreshTimer = setInterval(() => {
      this.reloadFromConfig()
      this.rebuildTownMaps()
    }, TeleportService.CONFIG_REFRESH_INTERVAL_MS)
  }

  isMainBot(): boolean {
    return !!this._mainBot && this._botName.toLowerCase() === this._mainBot.toLowerCase()
  }

  getMainBot(): string {
    return this._mainBot
  }

  /** 本 bot 的名字（phome_towns.json / botPhome.name） */
  getBotName(): string {
    return this._botName
  }

  /** 该点是否可由同小镇 bot 委托（只有 /phome 指令的点可以，/home、/ts 等不行） */
  isDelegatable(idx: number): boolean {
    const wp = this.getWaypointByIndex(idx)
    // /ts 点小镇共享（同镇可代执行）；/home 点仅本人不可委托
    return !!wp && (wp.cmd === '/phome' || wp.cmd === '/ts')
  }

  ownerOf(idx: number): string | null {
    return this._ownerOfIndex.get(idx) ?? null
  }

  townOf(botName: string): string | null {
    return this._townOfBot.get(botName) ?? null
  }

  /** 从共享 DB 的 lock_state 判断某 bot 当前是否被锁定（跨进程） */
  isBotLocked(botName: string): boolean {
    if (!this._db) return false
    try {
      const row = this._db.prepare('SELECT locked_by FROM lock_state WHERE bot_name = ?').get(botName) as { locked_by: string | null } | undefined
      return !!row?.locked_by
    } catch { return false }
  }

  /**
   * 心跳判定某 bot 是否离线（进程崩溃/掉线未回连：last_seen 超过 BOT_OFFLINE_THRESHOLD_MS 未更新）。
   * 没写过头跳（旧版本 bot 未升级）→ 保守按"在线"处理，避免误判让同镇 bot 抢活。
   */
  isBotOffline(botName: string): boolean {
    if (!this._db) return false
    try {
      const row = this._db.prepare('SELECT last_seen FROM bot_heartbeat WHERE bot_name = ?').get(botName) as { last_seen: number } | undefined
      if (!row) return false
      return Date.now() - row.last_seen > TeleportService.BOT_OFFLINE_THRESHOLD_MS
    } catch { return false }
  }

  /** 本 bot 是否可作为该点的 delegate（公屏 %N 触发，owner 被锁或离线、同镇、本 bot 空闲未锁） */
  canDelegateFor(idx: number): boolean {
    const owner = this.ownerOf(idx)
    if (!owner) return false
    if (owner.toLowerCase() === this._botName.toLowerCase()) return false
    if (!this.isDelegatable(idx)) return false
    const myTown = this.townOf(this._botName)
    const ownerTown = this.townOf(owner)
    if (!myTown || !ownerTown || myTown !== ownerTown) return false
    if (this.locked || this.isCommandBusy()) return false
    return this.isBotLocked(owner) || this.isBotOffline(owner)
  }

  /** owner 被锁/离线时：同镇是否还有可能代执行的 bot（至少一个未锁且在线） */
  hasDelegateCandidates(idx: number): boolean {
    if (!this.isDelegatable(idx)) return false
    const myTown = this.townOf(this._botName)
    if (!myTown) return false
    for (const [bot, town] of this._townOfBot) {
      if (bot.toLowerCase() === this._botName.toLowerCase()) continue
      if (town !== myTown) continue
      if (this.isBotLocked(bot)) continue
      if (this.isBotOffline(bot)) continue
      return true
    }
    return false
  }

  /** 原子认领委托：player+index 主键，只有一方成功；已结束(宽限期内)的行允许重新认领 */
  claimPhomeDelegate(player: string, idx: number): boolean {
    if (!this._db) return false
    try {
      const now = Date.now()
      this._db.prepare('DELETE FROM phome_claims WHERE expires_at < ?').run(now)
      this._db.prepare('DELETE FROM phome_claims WHERE player = ? AND "index" = ? AND resolved = 1').run(player, idx)
      const res = this._db.prepare(
        'INSERT OR IGNORE INTO phome_claims (player, "index", bot_index, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).run(player, idx, this._myBotIndex, now, now + TeleportService.PHOME_CLAIM_TTL_MS)
      return res.changes === 1
    } catch { return false }
  }

  /**
   * owner 兜底仲裁：本次请求（自 scheduledAt 起）是否有 delegate 认领过。
   * 按 claimed_at 判定而非 resolved——delegate 可能在 2.5s 窗口内就完成并释放认领(resolved=1)，
   * 若此时 owner 只认 active 行会误报繁忙；只要任何 delegate 响应过本次请求，owner 都应保持静默。
   */
  isDelegateClaimed(player: string, idx: number, sinceMs: number): boolean {
    if (!this._db || !player || idx < 0) return false
    try {
      const row = this._db.prepare(
        'SELECT 1 AS ok FROM phome_claims WHERE player = ? AND "index" = ? AND claimed_at >= ? AND expires_at > ?'
      ).get(player, idx, sinceMs - 1000, Date.now()) as { ok: number } | undefined
      return row !== undefined
    } catch { return false }
  }

  /** 释放委托认领（执行完成/被拒/超时/异常）：置 resolved=1 并保留宽限期 */
  releasePhomeClaim(player: string, idx: number): void {
    if (!this._db || !player || idx < 0) return
    try {
      this._db.prepare(
        'UPDATE phome_claims SET resolved = 1, expires_at = ? WHERE player = ? AND "index" = ?'
      ).run(Date.now() + TeleportService.PHOME_RESOLVE_GRACE_MS, player, idx)
    } catch { /* */ }
  }

  // === Lock ===

  transferLock (newOwner: string): boolean {
    if (!this.locked) return false
    const old = this.lockedBy
    this.lockedBy = newOwner
    this.lockedTicks = 0
    this.saveLockState()
    debug(`[Teleport] Lock transferred: ${old} -> ${newOwner}`)
    return true
  }

  isLocked(): boolean { return this.locked }
  isHoverLocked(): boolean { return this.locked && this.hoverLocked }
  getLockedBy(): string | null { return this.lockedBy }
  getLockedNote(): string | null { return this.lockedNote }
  getLockedTicks(): number { return this.lockedTicks }

  setOnUnlock (onUnlock: (info: { wasHover: boolean }) => void): void {
    this.onUnlock = onUnlock
  }

  async prepareAndLock (
    by: string,
    options?: { hover?: boolean }
  ): Promise<{ success: boolean; code?: 'already' | 'not_ready' | 'hover_failed' }> {
    if (this.locked) return { success: false, code: 'already' }

    if (options?.hover) {
      const bot = this.mcBot.bot
      if (!bot || !this.mcBot.isReady) {
        return { success: false, code: 'not_ready' }
      }
      const hovered = await jumpAndHover(bot)
      if (!hovered) return { success: false, code: 'hover_failed' }
      this.hoverLocked = true
    }

    this.lock(by, undefined, options?.hover)
    return { success: true }
  }

  lock(by: string, note?: string, hover?: boolean): void {
    this.locked = true
    this.lockedBy = by
    this.lockedTicks = 0
    this.lockedNote = note || null
    if (hover !== undefined) this.hoverLocked = hover
    this.saveLockState()
    debug(`[Teleport] Locked by ${by}${note ? ` (${note})` : ''}${this.hoverLocked ? ' (hover)' : ''}`)
  }

  unlock(): { wasHover: boolean } {
    const wasHover = this.hoverLocked
    this.locked = false
    this.lockedBy = null
    this.lockedNote = null
    this.lockedTicks = 0
    this.hoverLocked = false
    this.onUnlock?.({ wasHover })
    this.saveLockState()
    debug(`[Teleport] Unlocked${wasHover ? ' (resume physics)' : ''}`)
    return { wasHover }
  }

  private startLockTimer(): void {
    if (this.lockTimer) return
    let saveCounter = 0
    this.lockTimer = setInterval(() => {
      if (this.locked) {
        this.lockedTicks++
        // 每 30 秒把 lockedTicks 刷回 DB，防止进程重启后时间丢失过多
        if (++saveCounter >= 600) { // 50ms * 600 = 30s
          saveCounter = 0
          this.saveLockState()
        }
      }
    }, 50)
  }

  stop(): void {
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.configRefreshTimer) { clearInterval(this.configRefreshTimer); this.configRefreshTimer = null }
    this.clearPhomeTimeout()
  }

  // === Busy ===

  isCommandBusy(): boolean { return this.commandBusy || this.phomeActive }
  isPhomeActive(): boolean { return this.phomeActive }
  getBusyUser(): string | null { return this.busyUser }

  setBusy(user: string): void {
    this.commandBusy = true
    this.busyUser = user
  }

  clearBusy(): void {
    this.commandBusy = false
    this.busyUser = null
    this.busyIndex = -1
  }

  // === TPA ===

  canAcceptRequest(type: 'tpa' | 'tpahere', playerName?: string, isWhitelisted = false): boolean {
    if (!this.locked) return true
    // 锁定者本人始终允许（管理员由 incoming-handler 层放行）
    if (playerName && this.lockedBy?.toLowerCase() === playerName.toLowerCase()) return true
    // 锁定状态下：白名单用户只允许 tpa（玩家传送到 bot 位置），不允许 tpahere
    if (type === 'tpa' && isWhitelisted) return true
    return false
  }

  canUseWaypoint(): boolean {
    return !this.locked
  }

  async acceptRequest(playerName: string, type: 'tpa' | 'tpahere'): Promise<ServiceResult> {
    if (!this.mcBot.isReady) return { success: false, message: '机器人未就绪', code: 'not_ready' }
    try {
      this.mcBot.chat(`${this.tpacceptCommand} ${playerName}`)
      debug(`[Teleport] Auto-accepted ${type} from ${playerName}`)
      return { success: true }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  }

  async denyRequest(playerName: string): Promise<void> {
    if (!this.mcBot.isReady) return
    try {
      this.mcBot.chat(`${this.tpdenyCommand} ${playerName}`)
      debug(`[Teleport] Denied request from ${playerName}`)
    } catch { /* */ }
  }

  // === Phome ===

  listWaypointAliases(): string[] {
    return this.waypointList.map(w => w.alias)
  }

  listWaypoints(): Array<{ id: string; alias: string; cmd: string }> {
    return [...this.waypointList]
  }

  getWaypointByAlias(alias: string): { id: string; cmd: string } | null {
    return this.waypointByAlias.get(alias) ?? null
  }

  getWaypointByIndex(index: number): { id: string; alias: string; cmd: string } | null {
    if (index < 0 || index >= this.waypointList.length) return null
    return this.waypointList[index]
  }

  async executePhome(sender: string, idx: number): Promise<ServiceResult> {
    if (!this.isOwned(idx)) return { success: false, message: '' }

    if (this.phomeActive) return { success: false, message: '已在传送中' }
    if (this.commandBusy) return { success: false, message: '传送失败。' }

    if (this.locked) {
      const secs = this.lockedTicks / 20
      const h = Math.floor(secs / 3600)
      const m = Math.floor((secs % 3600) / 60)
      const s = Math.floor(secs % 60)
      let t = ''
      if (h > 0) t = `${h}时${m}分${s}秒`
      else if (m > 0) t = `${m}分${s}秒`
      else t = `${s}秒`
      return { success: false, message: `已被 ${this.lockedBy} 锁定 ${t}。` }
    }

    return this.runPhome(sender, idx)
  }

  /** 委托执行：同小镇 bot 代替被锁定的 owner 执行 /phome 点（handler 层已完成认领与资格检查） */
  async executePhomeDelegated(sender: string, idx: number): Promise<ServiceResult> {
    if (this.phomeActive) return { success: false, message: '已在传送中' }
    if (this.commandBusy) return { success: false, message: '传送失败。' }
    if (this.locked) return { success: false, message: '已被锁定' }

    return this.runPhome(sender, idx)
  }

  private async runPhome(sender: string, idx: number): Promise<ServiceResult> {
    const wp = this.getWaypointByIndex(idx)
    if (!wp) return { success: false, message: '传送点不存在' }

    let fullCmd: string
    if (wp.cmd === '/home' || wp.cmd === '/ts' || wp.cmd === '/tsl') {
      fullCmd = wp.cmd
    } else {
      fullCmd = `${wp.cmd} ${wp.id}`
    }

    this.phomeActive = true
    this.commandBusy = true
    this.busyUser = sender
    this.busyIndex = idx

    this.clearPhomeTimeout()
    this.phomeTimeout = setTimeout(() => {
      if (this.phomeActive) {
        const user = this.busyUser
        const index = this.busyIndex
        debug('[Teleport] Phome timeout, sending /ts')
        this.mcBot.chat('/ts')
        // 释放委托认领，让 owner 兜底仲裁不再把这次请求当作"已有人处理"
        this.releasePhomeClaim(user ?? '', index)
        this.phomeActive = false
        this.clearBusy()
        if (user) this.mcBot.whisper(user, '传送超时')
      }
    }, 20000)

    debug(`[Teleport] Phome by ${sender} -> ${fullCmd} + ${this.tpahereCommand}`)
    this.mcBot.chat(fullCmd)
    this.mcBot.chat(`${this.tpahereCommand} ${sender}`)
    return { success: true, message: '' }
  }

  private clearPhomeTimeout(): void {
    if (this.phomeTimeout) { clearTimeout(this.phomeTimeout); this.phomeTimeout = null }
  }

  phomeAccepted(): string {
    this.clearPhomeTimeout()
    const user = this.busyUser || ''
    const index = this.busyIndex
    // 释放委托认领（owner 的 phome 没有认领行，release 是空操作）
    this.releasePhomeClaim(user, index)
    this.phomeActive = false
    this.clearBusy()
    this.mcBot.chat('/ts')
    return user
  }

  phomeRejected(): string {
    this.clearPhomeTimeout()
    const user = this.busyUser || ''
    const index = this.busyIndex
    this.releasePhomeClaim(user, index)
    this.phomeActive = false
    this.clearBusy()
    this.mcBot.chat('/ts')
    return user
  }

  getPhomeListText(): string {
    // 点间用双空格分隔，每 6 个点换一行，避免 24 点挤成一行难读
    const items: string[] = []
    for (let i = 0; i < this.waypointList.length; i++) {
      // 主 bot 展示全部点；非主 bot 只列自己拥有的点
      if (!this.isMainBot() && !this._ownedIndices.includes(i)) continue
      items.push(`%${i + 1}[${this.waypointList[i].alias}]`)
    }
    const perLine = 6
    const lines: string[] = []
    for (let k = 0; k < items.length; k += perLine) {
      lines.push(items.slice(k, k + perLine).join(' → '))
    }
    return `传送点:\n${lines.join('\n')}`
  }

  addPhomePoint(alias: string, id: string | undefined, cm_d: string, pos?: number): ServiceResult {
    // 以磁盘最新共享列表为准再修改，防止覆盖其他 bot 刚添加的点
    this.reloadFromConfig()
    const safeId = id || ''
    const existing = this.waypointList.findIndex(w => w.alias === alias)
    if (existing >= 0) {
      // If this bot already owns the existing waypoint, just update it
      if (this._ownedIndices.includes(existing)) {
        this.waypointList[existing].id = safeId
        this.waypointList[existing].cmd = cm_d
        this.rebuildAliasMap()
        this.saveOwnedIndices()
        return { success: true, message: `已更新传送点: %${existing + 1}[${alias}]` }
      }
      // Alias exists but owned by another bot — add as new entry for this bot
    }
    const entry = { id: safeId, alias, cmd: cm_d }
    let idx: number
    if (pos !== undefined && pos >= 0 && pos <= this.waypointList.length) {
      // 插入位置会使之后所有下标 +1，先平移 ownedIndices 再插入
      this._ownedIndices = this._ownedIndices.map(i => i >= pos ? i + 1 : i)
      this.waypointList.splice(pos, 0, entry)
      idx = pos
    } else {
      this.waypointList.push(entry)
      idx = this.waypointList.length - 1
    }
    this._ownedIndices.push(idx)
    this.saveOwnedIndices()
    this.rebuildAliasMap()
    return { success: true, message: `已添加传送点: %${idx + 1}[${alias}]` }
  }

  removePhomePoint(idx: number): ServiceResult {
    this.reloadFromConfig()
    if (idx < 0 || idx >= this.waypointList.length) return { success: false, message: '传送点不存在。' }
    if (!this.isOwned(idx)) return { success: false, message: '不能删除其他 bot 的传送点。' }
    const removed = this.waypointList.splice(idx, 1)[0]
    this._ownedIndices = this._ownedIndices.filter(i => i !== idx).map(i => i > idx ? i - 1 : i)
    this.saveOwnedIndices()
    this.rebuildAliasMap()
    return { success: true, message: `已移除传送点: ${removed.alias}` }
  }

  private rebuildAliasMap(): void {
    this.waypointByAlias = new Map(
      this.waypointList.map(w => [w.alias, { id: w.id, cmd: w.cmd }])
    )
  }

  /** 从磁盘重新加载本 bot 的传送点列表与归属下标（多 bot 共享同一份 waypoints，修改前必须取最新值） */
  private reloadFromConfig(): void {
    if (!this._configPath) return
    const data = this.readConfigFile(this._configPath)
    if (!data) return
    const rawWps = (data.waypoints as Array<{ id?: string; alias?: string; cmd?: string }> | undefined) ?? []
    this.waypointList = rawWps.map(w => ({
      id: w.id || '',
      alias: w.alias || w.id || '',
      cmd: w.cmd || '/phome'
    }))
    this._ownedIndices = ((data.ownedIndices as number[] | undefined) ?? [])
      .filter(i => i >= 0 && i < this.waypointList.length)
    this.rebuildAliasMap()
  }

  private readConfigFile(file: string): Record<string, unknown> | null {
    try {
      const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')
      return JSON.parse(raw) as Record<string, unknown>
    } catch (e) {
      warn('[Teleport] 读取配置失败:', (e as Error).message)
      return null
    }
  }

  private writeConfigFile(file: string, data: Record<string, unknown>): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  /** 其他 bot 的 ownedIndices 按 alias 重映射到共享列表的新下标 */
  private remapOwned(oldIndices: number[], oldWps: WaypointConfig[], newWps: WaypointConfig[]): number[] {
    const next: number[] = []
    for (const i of oldIndices) {
      const alias = oldWps[i]?.alias
      if (!alias) continue
      const idx = newWps.findIndex(w => w.alias === alias)
      if (idx >= 0 && !next.includes(idx)) next.push(idx)
    }
    return next
  }

  private saveOwnedIndices(): void {
    if (!this._configPath) return
    try {
      const dir = path.dirname(this._configPath)
      const files = fs.readdirSync(dir).filter(f => /^teleport.*\.json$/i.test(f))
      const newWps = this.waypointList.map(w => ({ id: w.id, alias: w.alias, cmd: w.cmd }))
      for (const f of files) {
        const full = path.join(dir, f)
        const data = this.readConfigFile(full)
        if (!data) continue
        const rawOldWps = (data.waypoints as Array<{ id?: string; alias?: string; cmd?: string }> | undefined) ?? []
        const oldWps: WaypointConfig[] = rawOldWps.map(w => ({ id: w.id || '', alias: w.alias || w.id || '', cmd: w.cmd || '' }))
        if (full === this._configPath) {
          data.ownedIndices = this._ownedIndices
        } else {
          data.ownedIndices = this.remapOwned((data.ownedIndices as number[] | undefined) ?? [], oldWps, newWps)
        }
        data.waypoints = newWps
        this.writeConfigFile(full, data)
      }
    } catch (err) {
      warn('[Teleport] Failed to save ownedIndices:', (err as Error).message)
    }
  }
}
