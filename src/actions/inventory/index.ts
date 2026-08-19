import { Vec3 } from 'vec3'
import type { Item } from 'prismarine-item'
import type { Block } from 'prismarine-block'
import type { Bot } from 'mineflayer'
import type { Window } from 'prismarine-windows'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { ensurePathfinder, escapeStuck, gotoWithEscape } from '../shared/entity-utils'
import { debug } from '../../platform/logger'
import { goals } from 'mineflayer-pathfinder'
import { sleep } from '../../platform/sleep'
import { readFileSync } from 'fs'
import { join } from 'path'

// 加载中文物品名映射
let itemNameMap: Record<string, string> = {}
try {
  const p = join(__dirname, '..', '..', '..', 'config', 'game', 'item-names.json')
  itemNameMap = JSON.parse(readFileSync(p, 'utf-8'))
} catch { /* */ }

export function cnName (id: string): string {
  return itemNameMap[id] || normalizeItemKey(id)
}

export function normalizeItemKey (name: string): string {
  return name.toLowerCase().replace(/^minecraft:/, '').trim()
}

// Vanilla's potion registry order. 1.20.5+ sends this numeric id in the
// potion_contents item component instead of the old Potion NBT string.
const vanillaPotionIds = [
  'empty', 'water', 'mundane', 'thick', 'awkward',
  'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
  'leaping', 'long_leaping', 'strong_leaping', 'fire_resistance', 'long_fire_resistance',
  'swiftness', 'long_swiftness', 'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master',
  'water_breathing', 'long_water_breathing', 'healing', 'strong_healing',
  'harming', 'strong_harming', 'poison', 'long_poison', 'strong_poison',
  'regeneration', 'long_regeneration', 'strong_regeneration', 'strength', 'long_strength', 'strong_strength',
  'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'weaving', 'wind_charged', 'oozing', 'infested'
]

const potionDurations: Record<string, { normal: number, long?: number, strong?: number }> = {
  night_vision: { normal: 180, long: 480 }, invisibility: { normal: 180, long: 480 },
  leaping: { normal: 180, long: 480, strong: 90 }, fire_resistance: { normal: 180, long: 480 },
  swiftness: { normal: 180, long: 480, strong: 90 }, slowness: { normal: 90, long: 240, strong: 20 },
  turtle_master: { normal: 20, long: 40, strong: 20 }, water_breathing: { normal: 180, long: 480 },
  poison: { normal: 45, long: 90, strong: 22 }, regeneration: { normal: 45, long: 90, strong: 22 },
  strength: { normal: 180, long: 480, strong: 90 }, weakness: { normal: 90, long: 240 },
  slow_falling: { normal: 90, long: 240 }
}

type ComponentItem = Item & { componentMap?: Map<string, { data?: unknown }> }

function componentData (item: Item, type: string): unknown {
  return (item as ComponentItem).componentMap?.get(type)?.data
}

function primitiveValue (value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value?: unknown }).value
  }
  return value
}

function potionIdOf (item: Item): string | undefined {
  const legacyPotion = primitiveValue(
    (item.nbt as { value?: { Potion?: { value?: unknown } } } | null)?.value?.Potion
  )
  if (typeof legacyPotion === 'string') return normalizeItemKey(legacyPotion)

  const component = componentData(item, 'potion_contents') as {
    potionId?: unknown
    potion?: unknown
  } | undefined
  if (!component) return undefined
  const potion = primitiveValue(component.potion)
  const potionId = primitiveValue(component.potionId)
  if (typeof potion === 'string') return normalizeItemKey(potion)
  if (typeof potionId === 'number') return vanillaPotionIds[potionId]
  return undefined
}

function ominousBottleLevelText (item: Item): string | undefined {
  const amplifier = primitiveValue(componentData(item, 'ominous_bottle_amplifier'))
  if (typeof amplifier !== 'number' || amplifier < 0 || amplifier > 4) return undefined
  return ['I级', 'II级', 'III级', 'IV级', 'V级'][amplifier]
}

function potionDurationText (itemId: string, potionId: string): string | undefined {
  const variant = potionId.startsWith('long_') ? 'long' : potionId.startsWith('strong_') ? 'strong' : 'normal'
  const effect = potionId.replace(/^(long|strong)_/, '')
  const baseSeconds = potionDurations[effect]?.[variant]
  if (!baseSeconds) return undefined

  // Minecraft shortens effects based on how the item is delivered.
  const multiplier = itemId === 'splash_potion' ? 0.75
    : itemId === 'lingering_potion' ? 0.25
      : itemId === 'tipped_arrow' ? 0.125
        : 1
  const seconds = Math.floor(baseSeconds * multiplier)
  if (!seconds) return undefined
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}分钟` : `${minutes}分${remainder}秒`
}

function potionLevelText (potionId: string): string | undefined {
  const strong = potionId.startsWith('strong_')
  const effect = potionId.replace(/^(long|strong)_/, '')
  if (effect === 'slowness') return strong ? 'IV级' : 'I级'
  if (effect === 'turtle_master') return strong ? 'VI级' : 'IV级'
  if (['leaping', 'swiftness', 'healing', 'harming', 'poison', 'regeneration', 'strength'].includes(effect)) {
    return strong ? 'II级' : 'I级'
  }
  return undefined
}

/** Display the potion effect stored in item NBT/components, rather than just "potion". */
export function itemDisplayName (item: Item): string {
  const itemId = normalizeItemKey(item.name)
  if (itemId === 'ominous_bottle') {
    const level = ominousBottleLevelText(item)
    return level ? `${cnName(itemId)}（${level}）` : cnName(itemId)
  }
  const potionId = potionIdOf(item)
  if (!potionId || !['potion', 'splash_potion', 'lingering_potion', 'tipped_arrow'].includes(itemId)) {
    return cnName(itemId)
  }
  const effect = potionId.replace(/^(long|strong)_/, '')
  const effectName = cnName(`${itemId}.effect.${effect}`)
  const level = potionLevelText(potionId)
  const duration = potionDurationText(itemId, potionId)
  const details = [level, duration].filter((value): value is string => value != null)
  return details.length > 0 ? `${effectName}（${details.join('，')}）` : effectName
}

function normalizedItemSearchText (text: string): string {
  const levelAliases: Record<string, string> = {
    一: 'i', 二: 'ii', 三: 'iii', 四: 'iv', 五: 'v',
    '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv', '5': 'v'
  }
  return text.toLowerCase()
    .replace(/[\s()（）]/g, '')
    .replace(/([一二三四五1-5])级/g, (_, level: string) => `${levelAliases[level]}级`)
}

// 反向映射：中文名 → 英文ID
const cnToId: Record<string, string> = {}
for (const [id, name] of Object.entries(itemNameMap)) {
  cnToId[name] = id
}

/** 把查询词解析成规范英文 ID（支持中文名 → 英文ID，也支持直接英文ID） */
export function resolveItemKey (query: string): string {
  const q = query.trim()
  const fromCn = cnToId[q]
  if (fromCn) return fromCn
  return normalizeItemKey(q)
}

export function findExactMatchingItems (items: Item[], query: string): Item[] {
  const key = normalizeItemKey(query)
  return items.filter(item => normalizeItemKey(item.name) === key)
}

export function findMatchingItems (items: Item[], query: string): Item[] {
  // 先查是否是中文名→转英文ID→精确匹配
  const idFromCn = cnToId[query]
  if (idFromCn) {
    const exact = items.filter(i => normalizeItemKey(i.name) === idFromCn)
    if (exact.length > 0) return exact
  }
  // 英文/ID 匹配
  const key = normalizeItemKey(query)
  const exact = items.filter(i => normalizeItemKey(i.name) === key)
  if (exact.length > 0) return exact
  // 模糊匹配：同时搜英文ID、中文名和药水 NBT/组件中的效果及时长。
  const searchKey = normalizedItemSearchText(query)
  return items.filter(i => {
    const id = normalizeItemKey(i.name)
    const potionId = potionIdOf(i)
    return id.includes(key) ||
      normalizedItemSearchText(cnName(id)).includes(searchKey) ||
      normalizedItemSearchText(itemDisplayName(i)).includes(searchKey) ||
      (potionId != null && potionId.includes(key))
  })
}

export function formatItemList (items: Item[]): string[] {
  const merged = new Map<string, number>()
  for (const item of items) {
    const cn = itemDisplayName(item)
    merged.set(cn, (merged.get(cn) ?? 0) + item.count)
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh'))
    .map(([name, count]) => `${name} x${count}`)
}

export default class InventoryActions {
  private mcBot: MinecraftBot

  constructor (mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  listInventory (): ServiceResult & { lines?: string[] } {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const items = bot.inventory.items()
    if (items.length === 0) {
      return { success: true, message: '背包为空', lines: [] }
    }

    return { success: true, message: 'ok', lines: formatItemList(items) }
  }

  async dropItem (itemQuery: string, count?: number): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const matches = findMatchingItems(bot.inventory.items(), itemQuery)
    if (matches.length === 0) {
      return { success: false, message: `背包中没有 ${itemQuery}` }
    }

    let remaining = count != null && count > 0 ? count : -1
    let dropped = 0

    try {
      for (const item of matches) {
        if (remaining === 0) break
        const take = remaining > 0 ? Math.min(remaining, item.count) : item.count
        // toss(type, metadata) cannot distinguish potion stacks with different NBT.
        if (take === item.count) await bot.tossStack(item)
        else await bot.toss(item.type, item.metadata ?? null, take)
        dropped += take
        if (remaining > 0) remaining -= take
      }
      debug(`[Inventory] 丢弃 ${matches[0].name} x${dropped}`)
      return { success: true, message: `已丢弃 ${itemDisplayName(matches[0])} x${dropped}` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  }

  async approachBlock (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!bot) return { success: false, message: '机器人未就绪' }

    const target = new Vec3(x + 0.5, y + 0.5, z + 0.5)
    const distance = bot.entity.position.distanceTo(target)
    // approachDistance 仅作为配置兼容项保留；已登记的容器不设搜索半径，
    // 距离较远时统一先寻路到交互距离，再检查可见面并打开容器。
    void approachDistance
    if (distance > interactionDistance) {
      const result = await gotoWithEscape(bot, target, interactionDistance)
      if (!result.success) return result
    }

    // 到达后确认能看到工作方块；被墙/其他方块挡住时调整到能看见面的位置
    return this.ensureBlockFaceVisible(x, y, z)
  }

  /** 保证工作方块至少有一个面可见（能右键/打开），必要时小幅移动摆位 */
  private async ensureBlockFaceVisible (x: number, y: number, z: number): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!bot) return { success: false, message: '机器人未就绪' }

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '工作方块不可见' }

    const pfBot = ensurePathfinder(bot)
    const goal = new goals.GoalLookAtBlock(
      new Vec3(x, y, z),
      bot.world,
      { reach: 4.5, entityHeight: bot.entity.height ?? 1.6 }
    )

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const gotoP = pfBot.pathfinder.goto(goal)
        gotoP.catch(() => { /* handled below */ })
        await Promise.race([
          gotoP,
          new Promise((_, reject) => setTimeout(() => reject(new Error('摆位超时')), 4_000))
        ])
        await sleep(100)
        return { success: true }
      } catch {
        try { pfBot.pathfinder.stop() } catch { /* ignore */ }
        bot.clearControlStates()
        if (attempt === 2) break
        await escapeStuck(bot, 2)
        await sleep(250)
      }
    }

    return { success: false, message: '无法找到可交互的方块面' }
  }

  async storeInContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number | undefined,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach

    const matches = findMatchingItems(bot.inventory.items(), itemQuery)
    if (matches.length === 0) {
      return { success: false, message: `背包中没有 ${itemQuery}` }
    }

    const item = matches[0]
    const moveCount = count != null && count > 0
      ? Math.min(count, item.count)
      : item.count

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return { success: false, message: '容器方块不可见' }
    }

    try {
      const chest = await bot.openContainer(block)
      await chest.deposit(item.type, item.metadata ?? null, moveCount)
      chest.close()
      debug(`[Container] 存入 ${item.name} x${moveCount} @ ${x},${y},${z}`)
      return { success: true, message: `已存入 ${cnName(normalizeItemKey(item.name))} x${moveCount}` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async takeFromContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number | undefined,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return { success: false, message: '容器方块不可见' }
    }

    try {
      const chest = await bot.openContainer(block)
      const containerItems = chest.containerItems()
      const matches = findMatchingItems(containerItems, itemQuery)
      if (matches.length === 0) {
        chest.close()
        return { success: false, message: `容器中没有 ${itemQuery}` }
      }

      const item = matches[0]
      const totalInContainer = containerItems
        .filter(i => i.type === item.type && (i.metadata ?? null) === (item.metadata ?? null))
        .reduce((sum, i) => sum + i.count, 0)
      const moveCount = count != null && count > 0
        ? Math.min(count, totalInContainer)
        : totalInContainer

      await chest.withdraw(item.type, item.metadata ?? null, moveCount)
      chest.close()
      debug(`[Container] 取出 ${item.name} x${moveCount} @ ${x},${y},${z}`)
      return { success: true, message: `已取出 ${cnName(normalizeItemKey(item.name))} x${moveCount}` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async countInContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    try {
      const container = await this.openContainer(block)
      try {
        const count = findExactMatchingItems(container.containerItems(), itemQuery)
          .reduce((sum, item) => sum + item.count, 0)
        return { success: true, count }
      } finally {
        container.close()
        await sleep(150)
      }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async takeExactFromContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!Number.isInteger(count) || count <= 0) {
      return { success: false, message: `无效数量: ${count}` }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    try {
      const container = await this.openContainer(block)
      try {
        const containerItems = container.containerItems()
        const matches = findExactMatchingItems(containerItems, itemQuery)
        const total = matches.reduce((sum, item) => sum + item.count, 0)
        if (total < count || matches.length === 0) {
          return { success: false, message: `容器中 ${itemQuery} 不足 (${total}/${count})` }
        }
        const item = matches[0]
        await container.withdraw(item.type, item.metadata ?? null, count)
        return { success: true, message: `已取出 ${normalizeItemKey(item.name)} x${count}` }
      } finally {
        container.close()
        await sleep(150)
      }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async storeFilteredInContainer (
    x: number,
    y: number,
    z: number,
    filter: (item: Item) => boolean,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart <= 0) {
        throw new Error('容器未打开有效的窗口')
      }

      // 直接按窗口槽位搬运（单遍、无快照），避免背包状态未同步导致重复存入/漏存
      let moved = 0
      for (let slot = window.inventoryStart; slot < window.slots.length; slot++) {
        const item = window.slots[slot]
        if (!item || !filter(item)) continue
        const target = this.findEmptyContainerSlot(window)
        if (target < 0) break
        const count = item.count
        await bot.moveSlotItem(slot, target)
        moved += count
      }

      return { success: true, count: moved, message: `已存入 ${moved} 个物品` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  /** 把容器里所有物品全部取出到背包（暂存箱取回用） */
  async withdrawAllFromContainer (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) return { success: false, message: '容器方块不可见' }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart <= 0) {
        throw new Error('容器未打开有效的窗口')
      }

      let moved = 0
      for (let sourceSlot = 0; sourceSlot < window.inventoryStart; sourceSlot++) {
        const item = window.slots[sourceSlot]
        if (!item) continue
        const targetSlot = this.findEmptyWindowInventorySlot(window)
        if (targetSlot < 0) throw new Error('背包空间不足，无法取出暂存物品')
        const count = item.count
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (window.slots[sourceSlot]) {
          throw new Error(`取出容器槽位 ${sourceSlot} 后仍非空`)
        }
        moved += count
      }

      return { success: true, count: moved, message: `已取回 ${moved} 个物品` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async loadBrewingStand (
    x: number,
    y: number,
    z: number,
    filter: (item: Item) => boolean,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number, loadedAt?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || block.name !== 'brewing_stand') {
      return { success: false, message: '蒸馏方块不可见或不是酿造台' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart !== 5) {
        throw new Error(`酿造台窗口结构异常: inventoryStart=${window.inventoryStart}`)
      }

      // Java 版酿造台：0..2 为药水槽，3 为原料槽，4 为燃料槽。
      for (let slot = 0; slot < 3; slot++) {
        if (window.slots[slot]) throw new Error(`药水槽 ${slot + 1} 已被占用`)
      }

      let moved = 0
      let loadedAt = 0
      for (let targetSlot = 0; targetSlot < 3; targetSlot++) {
        const sourceSlot = this.findWindowInventorySlot(window, filter)
        if (sourceSlot < 0) throw new Error(`可用发酵产物不足 (${moved}/3)`)
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (!window.slots[targetSlot] || !filter(window.slots[targetSlot]!)) {
          throw new Error(`放入药水槽 ${targetSlot + 1} 后未确认到产物`)
        }
        moved++
        loadedAt = Date.now()
      }
      return {
        success: true,
        count: moved,
        loadedAt,
        message: `已放入 ${moved} 瓶发酵产物`
      }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async unloadBrewingStand (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || block.name !== 'brewing_stand') {
      return { success: false, message: '蒸馏方块不可见或不是酿造台' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart !== 5) {
        throw new Error(`酿造台窗口结构异常: inventoryStart=${window.inventoryStart}`)
      }

      let moved = 0
      for (let sourceSlot = 0; sourceSlot < 3; sourceSlot++) {
        if (!window.slots[sourceSlot]) throw new Error(`药水槽 ${sourceSlot + 1} 为空`)
        const targetSlot = this.findEmptyWindowInventorySlot(window)
        if (targetSlot < 0) throw new Error('背包空间不足，无法取出蒸馏产物')
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (window.slots[sourceSlot]) {
          throw new Error(`取出药水槽 ${sourceSlot + 1} 后槽位仍非空`)
        }
        moved++
      }
      return { success: true, count: moved, message: `已取出 ${moved} 瓶蒸馏产物` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async depositPotionsToAgingBarrel (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const before = bot.inventory.items()
      .filter(item => normalizeItemKey(item.name).includes('potion'))
      .reduce((sum, item) => sum + item.count, 0)
    if (before === 0) return { success: false, message: '背包中没有可陈化的酒品' }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || !block.name.endsWith('_planks')) {
      return { success: false, message: '陈化节点不可见或不是木板' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart <= 0) {
        throw new Error('酒桶未打开有效的容器界面')
      }

      // 只使用完全空的酒桶：新旧酒陈酿时长不同，混装会干扰计时。
      // 桶内残留任何物品（含上一批未收取的酒品）都不放入，交由调用方换下一个酒桶。
      const filledSlots = window.inventoryStart - this.countEmptyContainerSlots(window)
      if (filledSlots > 0) {
        return {
          success: false,
          code: 'barrel_full',
          message: `酒桶非空（残留 ${filledSlots} 格物品），换下一个空桶`
        }
      }

      // 空桶也需足以容纳整批酒品；药水不可堆叠，一瓶占一格。
      if (window.inventoryStart < before) {
        return {
          success: false,
          code: 'barrel_full',
          message: `酒桶容量不足 (${window.inventoryStart}/${before})`
        }
      }

      let moved = 0
      while (true) {
        const sourceSlot = this.findWindowInventorySlot(
          window,
          item => normalizeItemKey(item.name).includes('potion')
        )
        if (sourceSlot < 0) break
        const item = window.slots[sourceSlot]
        if (!item) break

        const emptyTarget = this.findEmptyContainerSlot(window)
        if (emptyTarget < 0) {
          if (moved === 0) throw new Error('酒桶没有空位')
          break
        }

        const count = item.count
        await bot.moveSlotItem(sourceSlot, emptyTarget)
        if (!window.slots[emptyTarget]) {
          throw new Error('放入酒桶后未确认到酒品')
        }
        moved += count
      }

      if (moved === 0) throw new Error('未能将酒品放入酒桶')
      return { success: true, count: moved, message: `已放入酒桶 ${moved} 瓶` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  async withdrawPotionsFromAgingBarrel (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult & { count?: number }> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || !block.name.endsWith('_planks')) {
      return { success: false, message: '陈化节点不可见或不是木板' }
    }

    let window: Window | null = null
    try {
      window = await this.openBlockWindow(block)
      if (window.inventoryStart <= 0) {
        throw new Error('酒桶未打开有效的容器界面')
      }

      let moved = 0
      for (let sourceSlot = 0; sourceSlot < window.inventoryStart; sourceSlot++) {
        const item = window.slots[sourceSlot]
        if (!item || !normalizeItemKey(item.name).includes('potion')) continue
        const targetSlot = this.findEmptyWindowInventorySlot(window)
        if (targetSlot < 0) throw new Error('背包空间不足，无法取出陈化产物')
        const count = item.count
        await bot.moveSlotItem(sourceSlot, targetSlot)
        if (window.slots[sourceSlot]) {
          throw new Error(`取出酒桶槽位 ${sourceSlot} 后仍非空`)
        }
        moved += count
      }

      if (moved === 0) {
        // 桶内没有酒品（可能已被人工提前收取），返回 count=0 供调用方区分，不作为失败重试。
        return { success: true, count: 0, message: '酒桶中没有酒品' }
      }
      return { success: true, count: moved, message: `已取出陈化产物 ${moved} 瓶` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    } finally {
      if (window) {
        try { bot.closeWindow(window) } catch { /* ignore */ }
        await sleep(150)
      }
    }
  }

  private findEmptyContainerSlot (window: Window): number {
    for (let slot = 0; slot < window.inventoryStart; slot++) {
      if (!window.slots[slot]) return slot
    }
    return -1
  }

  private countEmptyContainerSlots (window: Window): number {
    let count = 0
    for (let slot = 0; slot < window.inventoryStart; slot++) {
      if (!window.slots[slot]) count++
    }
    return count
  }

  private findWindowInventorySlot (window: Window, filter: (item: Item) => boolean): number {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      const item = window.slots[slot]
      if (item && filter(item)) return slot
    }
    return -1
  }

  private findEmptyWindowInventorySlot (window: Window): number {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      if (!window.slots[slot]) return slot
    }
    return -1
  }

  /**
   * 连续开关容器时服务端可能尚未处理上一个 close，导致 windowOpen 超时。
   * 开启前清理残留窗口，并对失败做一次短暂退避重试。
   */
  private async openContainer (
    block: Block
  ): Promise<Awaited<ReturnType<Bot['openContainer']>>> {
    const bot = this.mcBot.bot
    if (!bot) throw new Error('机器人未就绪')

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
        await sleep(250)
      }
      try {
        return await bot.openContainer(block)
      } catch (err) {
        lastError = err as Error
        try {
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        } catch { /* ignore */ }
        if (attempt === 0) await sleep(750)
      }
    }
    throw lastError ?? new Error('打开容器失败')
  }

  private async openBlockWindow (block: Block): Promise<Window> {
    const bot = this.mcBot.bot
    if (!bot) throw new Error('机器人未就绪')

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
        await sleep(250)
      }
      try {
        return await bot.openBlock(block)
      } catch (err) {
        lastError = err as Error
        try {
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        } catch { /* ignore */ }
        if (attempt === 0) await sleep(750)
      }
    }
    throw lastError ?? new Error('打开方块窗口失败')
  }
}
