import type MinecraftBot from '../../platform/minecraft-bot'
import type Whitelist from '../../permissions/whitelist'
import type TeleportService from './service'
import type CommandMessages from '../commands/messages'
import type StandbyManager from '../standby/manager'
import { parseIncomingTeleportRequest } from './tpa-parser'

export default class TeleportIncomingHandler {
  private teleportService: TeleportService
  private whitelist: Whitelist
  private mcBot: MinecraftBot
  private messages: CommandMessages
  private standby: StandbyManager
  private adminList: Set<string>
  private _lastAccept?: { key: string; time: number }
  private _lastLockNotify?: { key: string; time: number }

  constructor (
    teleportService: TeleportService,
    whitelist: Whitelist,
    mcBot: MinecraftBot,
    messages: CommandMessages,
    standby: StandbyManager,
    adminList: string[]
  ) {
    this.teleportService = teleportService
    this.whitelist = whitelist
    this.mcBot = mcBot
    this.messages = messages
    this.standby = standby
    this.adminList = new Set(adminList)
  }

  private isAdmin(playerName: string): boolean {
    return this.adminList.has(playerName)
  }

  handle (text: string): boolean {
    const request = parseIncomingTeleportRequest(text)
    if (!request) return false

    if (!this.whitelist.isAllowed(request.playerName)) return false

    this.standby.touch()

    const isLockedPlayer = this.teleportService.isLocked() &&
      this.teleportService.getLockedBy()?.toLowerCase() === request.playerName.toLowerCase()
    const isAdmin = this.isAdmin(request.playerName)

    if (!isAdmin && !this.teleportService.canAcceptRequest(request.type, isLockedPlayer ? request.playerName : undefined)) {
      void this.teleportService.denyRequest(request.playerName)
      if (this.teleportService.isLocked()) {
        this.notifyLocked(request.playerName)
      }
      return true
    }

    const dedupeKey = `${request.type}:${request.playerName}`
    const now = Date.now()
    if (this._lastAccept?.key === dedupeKey && now - this._lastAccept.time < 3000) {
      return true
    }
    this._lastAccept = { key: dedupeKey, time: now }

    void this.teleportService.acceptRequest(request.playerName, request.type)
    return true
  }

  private notifyLocked (playerName: string): void {
    const lockedBy = this.teleportService.getLockedBy() || '未知'
    const dedupeKey = `lock:${playerName}:${lockedBy}`
    const now = Date.now()
    if (this._lastLockNotify?.key === dedupeKey && now - this._lastLockNotify.time < 5000) {
      return
    }
    this._lastLockNotify = { key: dedupeKey, time: now }

    const message = this.messages.text('lockedBlocked', { lockedBy })
    this.mcBot.whisper(playerName, `#d9afd9${message}`)
    console.log(`[Teleport] 锁定拒绝 -> 通知 ${playerName} (锁定者: ${lockedBy})`)
  }
}
