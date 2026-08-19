import type MinecraftBot from '../../platform/minecraft-bot'
import type ContainerRegistry from './registry'
import { getTargetContainerBlock } from './utils'
import type CommandMessages from '../commands/messages'
import type { CommandSource } from '../commands/parser'

type Reply = (username: string, message: string, source: CommandSource) => Promise<void>

/** Command adapter for the generic container registry. */
export default class ContainerCommands {
  constructor (
    private readonly mcBot: MinecraftBot,
    private readonly registry: ContainerRegistry,
    private readonly messages: CommandMessages,
    private readonly isAdmin: (username: string) => boolean,
    private readonly reply: Reply
  ) {}

  async handle (username: string, parts: string[], source: CommandSource): Promise<void> {
    const sub = (parts.shift() || '').toLowerCase()
    switch (sub) {
      case 'add': await this.add(username, parts[0], source); return
      case 'remove': await this.remove(username, parts[0], source); return
      case 'list': await this.list(username, source); return
      case 'info': await this.info(username, parts[0], source); return
      default:
        await this.reply(username, [
          this.messages.text('containerAddUsage'),
          this.messages.text('containerRemoveUsage'),
          this.messages.text('containerInfoUsage'),
          'container list - \u5217\u51fa\u5bb9\u5668'
        ].join('\n'), source)
    }
  }

  private async add (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) return this.reply(username, this.messages.text('noPermission'), source)
    if (!alias) return this.reply(username, this.messages.text('containerAddUsage'), source)
    const bot = this.mcBot.bot
    if (!bot) return this.reply(username, this.messages.text('containerNoTarget'), source)
    const target = getTargetContainerBlock(bot)
    if (!target) return this.reply(username, this.messages.text('containerNoTarget'), source)
    const pos = target.block.position
    this.registry.add({
      alias, type: target.type, x: pos.x, y: pos.y, z: pos.z,
      dimension: bot.game?.dimension || 'overworld', addedBy: username
    })
    return this.reply(username, this.messages.text('containerAddSuccess', {
      alias, type: target.type, x: pos.x, y: pos.y, z: pos.z
    }), source)
  }

  private async remove (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) return this.reply(username, this.messages.text('noPermission'), source)
    if (!alias) return this.reply(username, this.messages.text('containerRemoveUsage'), source)
    if (!this.registry.remove(alias)) return this.reply(username, this.messages.text('containerRemoveNotFound', { alias }), source)
    return this.reply(username, this.messages.text('containerRemoveSuccess', { alias }), source)
  }

  private async list (username: string, source: CommandSource): Promise<void> {
    const containers = this.registry.list()
    if (containers.length === 0) return this.reply(username, this.messages.text('containerListEmpty'), source)
    const lines = [
      this.messages.text('containerListHeader', { count: containers.length }),
      ...containers.map(container => this.messages.text('containerListEntry', {
        alias: container.alias, type: container.type,
        x: container.x, y: container.y, z: container.z
      }))
    ]
    return this.reply(username, lines.join('\n'), source)
  }

  private async info (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!alias) return this.reply(username, this.messages.text('containerInfoUsage'), source)
    const container = this.registry.get(alias)
    if (!container) return this.reply(username, this.messages.text('containerInfoNotFound', { alias }), source)
    const lines = this.messages.lines('containerInfoLines', {
      alias: container.alias, type: container.type,
      x: container.x, y: container.y, z: container.z,
      dimension: container.dimension, addedBy: container.addedBy,
      date: container.addedAt.slice(0, 10)
    })
    return this.reply(username, lines.join('\n'), source)
  }
}
