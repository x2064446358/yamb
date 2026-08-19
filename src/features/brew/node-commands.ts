import type MinecraftBot from '../../platform/minecraft-bot'
import type InventoryActions from '../../actions/inventory'
import { cnName, normalizeItemKey } from '../../actions/inventory'
import type ContainerRegistry from '../container/registry'
import { getNodeBlockAt } from './block-node-utils'
import type CommandMessages from '../commands/messages'
import type BrewModule from './index'

type CommandSource = 'chat' | 'whisper' | 'console'
type Reply = (username: string, message: string, source: CommandSource) => Promise<void>

/** Brewing node command adapter. Persistence remains owned by ContainerRegistry. */
export default class BrewNodeCommands {
  constructor (
    private readonly mcBot: MinecraftBot,
    private readonly inventoryActions: InventoryActions,
    private readonly registry: ContainerRegistry,
    private readonly brew: BrewModule,
    private readonly messages: CommandMessages,
    private readonly isAdmin: (username: string) => boolean,
    private readonly reply: Reply,
    private readonly interactionDistance: number,
    private readonly approachDistance: number
  ) {}

  async handle (username: string, parts: string[], source: CommandSource): Promise<void> {
    const sub = (parts.shift() || '').toLowerCase()
    if (sub === 'reg' || sub === '\u767b\u8bb0' || sub === '\u6ce8\u518c') return this.register(username, parts, source)
    if (sub === 'list' || sub === '\u5217\u8868') return this.list(username, parts, source)
    if (sub === 'info' || sub === '\u8be6\u60c5') return this.info(username, parts[0], source)
    if (sub === 'remove' || sub === '\u5220\u9664') return this.remove(username, parts[0], source)
    await this.reply(username, [
      'node \u767b\u8bb0 <\u522b\u540d> <x> <y> <z> [-\u6df7\u5408] [-\u533a\u57df \u533a\u57df]',
      '      node \u5217\u8868 [\u533a\u57df]',
      '      node \u8be6\u60c5 <\u522b\u540d>',
      '      node \u5220\u9664 <\u522b\u540d>'
    ].join('\n'), source)
  }

  private async register (username: string, parts: string[], source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) return this.reply(username, this.messages.text('noPermission'), source)
    const [alias, xRaw, yRaw, zRaw, ...options] = parts
    if (!alias || !/^-?\d+$/.test(xRaw ?? '') || !/^-?\d+$/.test(yRaw ?? '') || !/^-?\d+$/.test(zRaw ?? '')) {
      return this.reply(username, this.messages.text('nodeAddUsage'), source)
    }

    let mixed = false
    let group: string | undefined
    for (let i = 0; i < options.length; i++) {
      const option = options[i].toLowerCase()
      if (option === '-m' || option === '-mixed' || option === '-\u6df7\u5408') mixed = true
      else if (option === '-g' || option === '-group' || option === '--group' || option === '-\u533a\u57df') {
        group = options[++i]
        if (!group) return this.reply(username, this.messages.text('nodeAddUsage'), source)
      } else return this.reply(username, this.messages.text('nodeAddUsage'), source)
    }

    const bot = this.mcBot.bot
    if (!bot) return this.reply(username, this.messages.text('botNotReady'), source)
    const x = Number(xRaw); const y = Number(yRaw); const z = Number(zRaw)
    const target = getNodeBlockAt(bot, x, y, z)
    if (!target) return this.reply(username, this.messages.text('nodeAddNoTarget'), source)
    if (target.blockType !== 'Container' && mixed) return this.reply(username, this.messages.text('nodeAddUsage'), source)

    let isDedicated: boolean | null = null
    let itemId: string | null = null
    if (target.blockType === 'Container') {
      isDedicated = !mixed
      if (isDedicated) {
        try {
          const approach = await this.inventoryActions.approachBlock(x, y, z, this.interactionDistance, this.approachDistance)
          if (!approach.success) return this.reply(username, approach.message || '\u65e0\u6cd5\u63a5\u8fd1\u5bb9\u5668', source)
          const chest = await bot.openContainer(target.block)
          try {
            const first = chest.slots[0]
            if (!first) return this.reply(username, '\u4e13\u7528\u5bb9\u5668\u7b2c\u4e00\u683c\u6ca1\u6709\u7269\u54c1\uff0c\u65e0\u6cd5\u7ed1\u5b9a', source)
            itemId = normalizeItemKey(first.name)
          } finally { chest.close() }
        } catch (error) {
          return this.reply(username, `\u767b\u8bb0\u5bb9\u5668\u5931\u8d25: ${(error as Error).message}`, source)
        }
      }
    }

    const resolvedGroup = (group ?? this.brew.getGroup()).trim()
    this.registry.add({
      alias, type: target.block.name, blockType: target.blockType, x, y, z,
      dimension: bot.game?.dimension || 'overworld', isDedicated, itemId,
      nodeGroup: resolvedGroup, addedBy: username
    })
    const bind = target.blockType === 'Container'
      ? (itemId ? ` | \u7ed1\u5b9a ${cnName(itemId)}` : (mixed ? '' : ' | \u7a7a\u5bb9\u5668'))
      : ''
    return this.reply(username, this.messages.text('nodeAddSuccess', {
      alias, type: target.blockType, group: resolvedGroup, bind, x, y, z
    }), source)
  }

  private async list (username: string, parts: string[], source: CommandSource): Promise<void> {
    const group = (parts[0] ?? '').trim() || this.brew.getGroup()
    const nodes = this.registry.list(group)
    if (nodes.length === 0) return this.reply(username, this.messages.text('nodeListEmpty', { group }), source)
    const lines = [
      this.messages.text('nodeListHeader', { count: nodes.length, group }),
      ...nodes.map(node => this.messages.text('nodeListEntry', {
        alias: node.alias, type: node.blockType ?? node.type,
        x: node.x, y: node.y, z: node.z,
        item: node.itemId ? ` [${cnName(node.itemId)}]` : ''
      }))
    ]
    return this.reply(username, lines.join('\n'), source)
  }

  private async info (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!alias) return this.reply(username, this.messages.text('nodeInfoUsage'), source)
    const node = this.registry.get(alias)
    if (!node) return this.reply(username, this.messages.text('nodeInfoNotFound', { alias }), source)
    const lines = this.messages.lines('nodeInfoLines', {
      alias: node.alias, type: node.blockType ?? node.type, block: node.type,
      x: node.x, y: node.y, z: node.z, dimension: node.dimension,
      group: node.nodeGroup || '-', item: node.itemId ? cnName(node.itemId) : '-',
      addedBy: node.addedBy, date: node.addedAt.slice(0, 10)
    })
    return this.reply(username, lines.join('\n'), source)
  }

  private async remove (username: string, alias: string | undefined, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) return this.reply(username, this.messages.text('noPermission'), source)
    if (!alias) return this.reply(username, this.messages.text('nodeRemoveUsage'), source)
    if (!this.registry.remove(alias)) return this.reply(username, this.messages.text('nodeRemoveNotFound', { alias }), source)
    return this.reply(username, this.messages.text('nodeRemoveSuccess', { alias }), source)
  }
}
