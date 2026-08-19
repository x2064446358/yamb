import type MinecraftBot from '../../platform/minecraft-bot'
import type InventoryActions from '../../actions/inventory'
import { findMatchingItems, itemDisplayName } from '../../actions/inventory'
import type ContainerRegistry from '../container/registry'
import type CommandMessages from '../commands/messages'

type CommandSource = 'chat' | 'whisper' | 'console'
type Reply = (username: string, message: string, source: CommandSource) => Promise<void>

/** Command adapter for inventory inspection and registered-container transfers. */
export default class InventoryCommandModule {
  constructor (
    private readonly mcBot: MinecraftBot,
    private readonly inventoryActions: InventoryActions,
    private readonly containerRegistry: ContainerRegistry,
    private readonly messages: CommandMessages,
    private readonly isAdmin: (username: string) => boolean,
    private readonly reply: Reply,
    private readonly interactionDistance: number,
    private readonly approachDistance: number
  ) {}

  async inventory (username: string, source: CommandSource): Promise<void> {
    if (!this.isAdmin(username)) {
      await this.reply(username, this.messages.text('noPermission'), source)
      return
    }
    const result = this.inventoryActions.listInventory()
    if (!result.success) {
      await this.reply(username, this.messages.text('invError', { message: result.message || '\u5931\u8d25' }), source)
      return
    }
    if (!result.lines?.length) {
      await this.reply(username, this.messages.text('invEmpty'), source)
      return
    }
    await this.reply(username, [
      this.messages.text('invHeader', { count: result.lines.length }),
      ...result.lines
    ].join('\n'), source)
  }

  async store (username: string, parts: string[], source: CommandSource): Promise<void> {
    const [alias, itemQuery, countRaw] = parts
    if (!alias || !itemQuery) {
      await this.reply(username, this.messages.text('storeUsage'), source)
      return
    }
    const record = this.containerRegistry.get(alias)
    if (!record) {
      await this.reply(username, this.messages.text('containerInfoNotFound', { alias }), source)
      return
    }
    const count = countRaw ? parseInt(countRaw, 10) : undefined
    const result = await this.inventoryActions.storeInContainer(
      record.x, record.y, record.z, itemQuery,
      Number.isFinite(count) ? count : undefined,
      this.interactionDistance, this.approachDistance
    )
    await this.reply(username, this.messages.text(result.success ? 'storeSuccess' : 'storeError', {
      message: result.message || (result.success ? '\u5df2\u5b58\u5165' : '\u5b58\u5165\u5931\u8d25')
    }), source)
  }

  async take (username: string, parts: string[], source: CommandSource): Promise<void> {
    const [alias, itemQuery, countRaw] = parts
    if (!alias || !itemQuery) {
      await this.reply(username, this.messages.text('takeUsage'), source)
      return
    }
    const record = this.containerRegistry.get(alias)
    if (!record) {
      await this.reply(username, this.messages.text('containerInfoNotFound', { alias }), source)
      return
    }
    const count = countRaw ? parseInt(countRaw, 10) : undefined
    const result = await this.inventoryActions.takeFromContainer(
      record.x, record.y, record.z, itemQuery,
      Number.isFinite(count) ? count : undefined,
      this.interactionDistance, this.approachDistance
    )
    await this.reply(username, this.messages.text(result.success ? 'takeSuccess' : 'takeError', {
      message: result.message || (result.success ? '\u5df2\u53d6\u51fa' : '\u53d6\u51fa\u5931\u8d25')
    }), source)
  }

  async drop (username: string, parts: string[], source: CommandSource): Promise<void> {
    const last = parts.at(-1)
    const count = last && /^\d+$/.test(last) ? parseInt(parts.pop() as string, 10) : undefined
    const itemQuery = parts.join(' ')
    if (!itemQuery) {
      await this.reply(username, this.messages.text('dropUsage'), source)
      return
    }
    const result = await this.inventoryActions.dropItem(itemQuery, Number.isFinite(count) ? count : undefined)
    await this.reply(username, this.messages.text(result.success ? 'dropSuccess' : 'dropError', {
      message: result.message || (result.success ? '\u5df2\u4e22\u5f03' : '\u4e22\u5f03\u5931\u8d25')
    }), source)
  }

  async dropAll (username: string, source: CommandSource): Promise<void> {
    const bot = this.mcBot.bot
    if (!bot) {
      await this.reply(username, this.messages.text('botNotReady'), source)
      return
    }
    const items = bot.inventory.items()
    for (const item of items) {
      try { await bot.tossStack(item) } catch { /* Continue dropping the remaining stacks. */ }
    }
    await this.reply(username, this.messages.text('dropAllSuccess', { count: items.length }), source)
  }

  async hold (username: string, itemName: string | undefined, source: CommandSource): Promise<void> {
    if (!itemName) {
      await this.reply(username, this.messages.text('holdUsage'), source)
      return
    }
    const bot = this.mcBot.bot
    if (!bot) return
    const matches = findMatchingItems(bot.inventory.items(), itemName)
    if (matches.length === 0) {
      await this.reply(username, this.messages.text('holdNotFound', { item: itemName }), source)
      return
    }
    await bot.equip(matches[0], 'hand')
    await this.reply(username, this.messages.text('holdSuccess', { item: itemDisplayName(matches[0]) }), source)
  }
}
