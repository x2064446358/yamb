import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { AgingWoodType } from '../../types'
import type { BlockNodeType } from '../container/registry'

const STORAGE_CONTAINER_BLOCKS = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'shulker_box',
  'ender_chest',
  'hopper',
  'dispenser',
  'dropper',
  'crafter'
])

const FERMENTER_BLOCKS = new Set([
  'cauldron',
  'water_cauldron',
  'lava_cauldron',
  'powder_snow_cauldron'
])

const PLANK_WOOD_TYPES = new Set([
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'mangrove',
  'cherry',
  'bamboo'
])

export function classifyBlockNode (blockName: string): BlockNodeType | null {
  const name = blockName.replace(/^minecraft:/, '')

  if (name === 'water') return 'Water'
  if (name === 'brewing_stand') return 'Distillery'
  if (name.endsWith('_planks')) return 'Aging'
  if (FERMENTER_BLOCKS.has(name)) return 'Fermenter'
  if (STORAGE_CONTAINER_BLOCKS.has(name) || name.endsWith('_shulker_box')) {
    return 'Container'
  }
  return null
}

export function getAgingWoodType (blockName: string): AgingWoodType | null {
  const name = blockName.replace(/^minecraft:/, '')
  if (!name.endsWith('_planks')) return null
  const wood = name.slice(0, -'_planks'.length)
  return PLANK_WOOD_TYPES.has(wood) ? wood as AgingWoodType : null
}

export function getTargetNodeBlock (bot: Bot, maxDistance = 5) {
  const block = bot.blockAtCursor(maxDistance)
  if (!block) return null
  const blockType = classifyBlockNode(block.name)
  if (!blockType) return null
  return { block, blockType }
}

export function getNodeBlockAt (bot: Bot, x: number, y: number, z: number) {
  const block = bot.blockAt(new Vec3(x, y, z))
  if (!block) return null

  const blockType = classifyBlockNode(block.name)
  if (!blockType) return null

  return { block, blockType }
}

export function normalizeMinecraftId (value: string): string {
  return value.includes(':') ? value : `minecraft:${value}`
}
