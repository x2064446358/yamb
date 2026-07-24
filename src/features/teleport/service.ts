import type { ServiceResult, TeleportConfig, WaypointConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type { DatabaseSync } from 'node:sqlite'
import { jumpAndHover } from '../../actions/shared/entity-utils'

export default class TeleportService {
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
  private phomeTimeout: ReturnType<typeof setTimeout> | null = null
  private ownedStart: number
  private ownedEnd: number

  constructor (mcBot: MinecraftBot, config: TeleportConfig) {
    this.mcBot = mcBot
    this.tpacceptCommand = config.tpacceptCommand
    this.tpdenyCommand = config.tpdenyCommand
    this.tpahereCommand = config.tpahereCommand
    this.phomeCommand = config.phomeCommand
    this.ownedStart = config.ownedStart ?? 0
    this.ownedEnd = config.ownedEnd ?? 15
    const waypoints = config.waypoints || []
    this.waypointList = waypoints.map(w => ({
      id: w.id,
      alias: w.alias || w.id,
      cmd: w.cmd || '/phome'
    }))
    this.waypointByAlias = new Map(
      this.waypointList.map(w => [w.alias, { id: w.id, cmd: w.cmd }])
    )
    this.waypointDelayMs = config.waypointDelayMs ?? 3000
    this.startLockTimer()
  }

  private restoreLockState(db: DatabaseSync): void {
    try {
      db.exec("CREATE TABLE IF NOT EXISTS lock_state (bot_name TEXT PRIMARY KEY, locked_by TEXT, locked_note TEXT, locked_ticks INTEGER)")
      const row = db.prepare('SELECT locked_by, locked_note, locked_ticks FROM lock_state WHERE bot_name = ?').get(this._botName) as { locked_by: string; locked_note: string | null; locked_ticks: number } | undefined
      if (row?.locked_by) {
        this.locked = true
        this.lockedBy = row.locked_by
        this.lockedNote = row.locked_note || null
        this.lockedTicks = row.locked_ticks || 0
        console.log(`[Teleport] Restored lock: ${this.lockedBy}${this.lockedNote ? ` (${this.lockedNote})` : ''}`)
      }
    } catch (err) {
      console.warn('[Teleport] Failed to restore lock state:', (err as Error).message)
    }
  }

  private saveLockState(): void {
    try {
      if (!this._db) return
      this._db.exec("CREATE TABLE IF NOT EXISTS lock_state (bot_name TEXT PRIMARY KEY, locked_by TEXT, locked_note TEXT, locked_ticks INTEGER)")
      if (this.locked && this.lockedBy) {
        this._db.prepare('INSERT OR REPLACE INTO lock_state (bot_name, locked_by, locked_note, locked_ticks) VALUES (?, ?, ?, ?)').run(this._botName, this.lockedBy, this.lockedNote, this.lockedTicks)
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
    this.restoreLockState(db)
  }

  getStatusText(): string {
    if (this.locked) {
      const note = this.lockedNote ? `:${this.lockedNote}` : ''
      return `锁定(${this.lockedBy}${note})`
    }
    return '空闲'
  }

  isOwned(idx: number): boolean {
    return idx >= this.ownedStart && idx <= this.ownedEnd
  }

  // === Lock ===

  transferLock (newOwner: string): boolean {
    if (!this.locked) return false
    const old = this.lockedBy
    this.lockedBy = newOwner
    this.lockedTicks = 0
    this.saveLockState()
    console.log(`[Teleport] Lock transferred: ${old} -> ${newOwner}`)
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
    console.log(`[Teleport] Locked by ${by}${note ? ` (${note})` : ''}${this.hoverLocked ? ' (hover)' : ''}`)
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
    console.log(`[Teleport] Unlocked${wasHover ? ' (resume physics)' : ''}`)
    return { wasHover }
  }

  private startLockTimer(): void {
    if (this.lockTimer) return
    this.lockTimer = setInterval(() => {
      if (this.locked) this.lockedTicks++
    }, 50)
  }

  stop(): void {
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = null }
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
  }

  // === TPA ===

  canAcceptRequest(type: 'tpa' | 'tpahere', playerName?: string): boolean {
    if (!this.locked) return true
    if (playerName && this.lockedBy?.toLowerCase() === playerName.toLowerCase()) return true
    return false
  }

  canUseWaypoint(): boolean {
    return !this.locked
  }

  async acceptRequest(playerName: string, type: 'tpa' | 'tpahere'): Promise<ServiceResult> {
    if (!this.mcBot.isReady) return { success: false, message: '机器人未就绪', code: 'not_ready' }
    try {
      this.mcBot.chat(`${this.tpacceptCommand} ${playerName}`)
      console.log(`[Teleport] Auto-accepted ${type} from ${playerName}`)
      return { success: true }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  }

  async denyRequest(playerName: string): Promise<void> {
    if (!this.mcBot.isReady) return
    try {
      this.mcBot.chat(`${this.tpdenyCommand} ${playerName}`)
      console.log(`[Teleport] Denied request from ${playerName}`)
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

    this.clearPhomeTimeout()
    this.phomeTimeout = setTimeout(() => {
      if (this.phomeActive) {
        const user = this.busyUser
        console.log('[Teleport] Phome timeout, sending /ts')
        this.mcBot.chat('/ts')
        this.phomeActive = false
        this.clearBusy()
        if (user) this.mcBot.whisper(user, '#d9afd9传送超时')
      }
    }, 20000)

    console.log(`[Teleport] Phome by ${sender} -> ${fullCmd} + ${this.tpahereCommand}`)
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
    this.phomeActive = false
    this.clearBusy()
    this.mcBot.chat('/ts')
    return user
  }

  phomeRejected(): string {
    this.clearPhomeTimeout()
    const user = this.busyUser || ''
    this.phomeActive = false
    this.clearBusy()
    this.mcBot.chat('/ts')
    return user
  }

  getPhomeListText(): string {
    let text = '传送点:'
    for (let i = 0; i < this.waypointList.length; i++) {
      text += ` %${i + 1}[${this.waypointList[i].alias}]`
    }
    return text
  }

  addPhomePoint(name: string, cm_d: string, pos?: number): ServiceResult {
    const existing = this.waypointList.findIndex(w => w.id === name)
    if (existing >= 0) {
      this.waypointList[existing].cmd = cm_d
      this.rebuildAliasMap()
      return { success: true, message: `已更新传送点: %${existing + 1}[${name}]` }
    }
    const entry = { id: name, alias: name, cmd: cm_d }
    if (pos !== undefined && pos >= 0 && pos <= this.waypointList.length) {
      this.waypointList.splice(pos, 0, entry)
    } else {
      this.waypointList.push(entry)
    }
    this.ownedEnd++
    this.rebuildAliasMap()
    const idx = this.waypointList.indexOf(entry)
    return { success: true, message: `已添加传送点: %${idx + 1}[${name}]` }
  }

  removePhomePoint(idx: number): ServiceResult {
    if (idx < 0 || idx >= this.waypointList.length) return { success: false, message: '传送点不存在。' }
    if (!this.isOwned(idx)) return { success: false, message: '不能删除其他 bot 的传送点。' }
    const removed = this.waypointList.splice(idx, 1)[0]
    this.ownedEnd--
    this.rebuildAliasMap()
    return { success: true, message: `已移除传送点: ${removed.alias}` }
  }

  private rebuildAliasMap(): void {
    this.waypointByAlias = new Map(
      this.waypointList.map(w => [w.alias, { id: w.id, cmd: w.cmd }])
    )
  }
}
