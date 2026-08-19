import type TeleportService from './service'
import type CommandMessages from '../commands/messages'
import type { CommandSource } from '../commands/parser'

type Reply = (username: string, message: string, source: CommandSource) => Promise<void>

/** Command-layer handling for phome waypoint listing, execution and delegation. */
export default class PhomeCommands {
  private static readonly DELEGATE_FALLBACK_MS = 2500

  constructor (
    private readonly teleport: TeleportService,
    private readonly messages: CommandMessages,
    private readonly reply: Reply,
    private readonly isPhomeAllowed: (username: string) => boolean
  ) {}

  async handleNumber (username: string, num: number, source: CommandSource): Promise<void> {
    if (num === 0) {
      await this.list(username, source)
      return
    }
    await this.execute(username, num, source)
  }

  async handleAlias (username: string, alias: string, source: CommandSource): Promise<void> {
    const normalizedAlias = alias.trim()
    const index = this.teleport.listWaypoints().findIndex(waypoint => waypoint.alias === normalizedAlias)
    if (index < 0) {
      await this.reply(username, this.messages.text('unknownWaypoint', { alias: normalizedAlias }), source)
      return
    }
    await this.executeIndex(username, index, source)
  }

  private async list (username: string, source: CommandSource): Promise<void> {
    if (this.teleport.isMainBot() || source === 'console') {
      await this.reply(username, this.teleport.getPhomeListText(), source)
      return
    }
    if (source === 'whisper') {
      await this.reply(username, this.messages.text('phomeRedirect', { mainBot: this.teleport.getMainBot() }), source)
    }
  }

  private async execute (username: string, num: number, source: CommandSource): Promise<void> {
    const index = num - 1
    const waypoint = this.teleport.getWaypointByIndex(index)
    if (!waypoint) {
      await this.reply(username, this.messages.text('phomePointNotFound', { point: num }), source)
      return
    }
    await this.executeIndex(username, index, source)
  }

  private async executeIndex (username: string, index: number, source: CommandSource): Promise<void> {
    const waypoint = this.teleport.getWaypointByIndex(index)
    if (!waypoint) return
    const delegatable = this.teleport.isDelegatable(index)

    if (this.teleport.isOwned(index)) {
      if (this.teleport.isLocked()) {
        if (delegatable && source === 'chat') {
          if (!this.isPhomeAllowed(username)) {
            await this.reply(username, this.messages.text('latelanOnly'), source)
            return
          }
          if (!this.teleport.hasDelegateCandidates(index)) {
            await this.reply(username, this.messages.text('phomeBusyNoCandidates', {
              owner: this.teleport.getBotName(),
              lockedBy: this.teleport.getLockedBy() ?? '\u672a\u77e5'
            }), source)
            return
          }
          this.scheduleFallback(username, index, source)
          return
        }
        const lockedBy = this.teleport.getLockedBy()
        const seconds = this.teleport.getLockedTicks() / 20
        const minutes = Math.floor(seconds / 60)
        const remainder = Math.floor(seconds % 60)
        await this.reply(username, this.messages.text('lockedForTime', {
          lockedBy: lockedBy ?? '\u672a\u77e5',
          time: `${minutes}\u5206${remainder}\u79d2`
        }), source)
        return
      }
      if (this.teleport.isCommandBusy()) {
        await this.reply(username, this.messages.text('teleportFailed'), source)
        return
      }
      if (!this.isPhomeAllowed(username)) {
        await this.reply(username, this.messages.text('latelanOnly'), source)
        return
      }
      const result = await this.teleport.executePhome(username, index)
      if (!result.success && result.message) await this.reply(username, result.message, source)
      return
    }

    if (delegatable && source === 'chat' && this.isPhomeAllowed(username) && this.teleport.canDelegateFor(index)) {
      const owner = this.teleport.ownerOf(index)
      if (this.teleport.claimPhomeDelegate(username, index)) {
        const result = await this.teleport.executePhomeDelegated(username, index)
        if (result.success) {
          await this.reply(username, this.messages.text('phomeDelegated', {
            owner: owner ?? '\u540c\u9547bot',
            alias: waypoint.alias
          }), source)
        } else {
          this.teleport.releasePhomeClaim(username, index)
        }
      }
    }
  }

  private scheduleFallback (username: string, index: number, source: CommandSource): void {
    const scheduledAt = Date.now()
    setTimeout(() => {
      if (this.teleport.isDelegateClaimed(username, index, scheduledAt)) return
      this.reply(username, this.messages.text('phomeBusyTimeout'), source).catch(() => {})
    }, PhomeCommands.DELEGATE_FALLBACK_MS)
  }
}
