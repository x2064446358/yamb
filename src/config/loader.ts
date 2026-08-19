import fs from 'fs'
import path from 'path'
import { AGING_WOOD_TYPES, AGING_WOOD_ZH } from '../types'
import type {
  AppConfig,
  MessagesConfig,
  AgingWoodType,
  BrewRecipe,
  FermentationIngredient,
  BrewWaterMode,
  PhomeTownsConfig
} from '../types'
import { debug } from '../platform/logger'

const PROJECT_ROOT = path.join(__dirname, '..', '..')
const GAME_CONFIG_DIR = path.join(PROJECT_ROOT, 'config', 'game')
const RECIPES_CONFIG_DIR = path.join(PROJECT_ROOT, 'config', 'recipes')

function envBool (value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  return value === 'true' || value === '1'
}

function envInt (value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue
  return parseInt(value, 10)
}

function stripJsonComments (text: string): string {
  let result = ''
  let i = 0
  let inString = false
  let escape = false

  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]

    if (inString) {
      result += char
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      i++
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      i++
      continue
    }

    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }

    result += char
    i++
  }

  return result
}

function readJson<T> (filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[Config] File not found: ${filePath}`)
      return null
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(stripJsonComments(raw)) as T
  } catch (err) {
    console.warn(`[Config] Failed to read ${filePath}:`, (err as Error).message)
    return null
  }
}

function resolvePath (relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  return path.join(PROJECT_ROOT, relativePath)
}

function parseAdminList (value: string | undefined): string[] {
  if (!value?.trim()) return []
  return value.split(',').map(name => name.trim()).filter(Boolean)
}
function loadMessagesConfig (): MessagesConfig {
  const messagesPath = path.join(GAME_CONFIG_DIR, 'messages.json')
  const messages = readJson<MessagesConfig>(messagesPath)
  if (!messages) {
    console.error('[Config] Error: config/game/messages.json is required')
    process.exit(1)
  }
  return messages
}

function loadEnvConfig (): Pick<AppConfig, 'minecraft' | 'astrbot' | 'messageQueue' | 'adminList'> {
  const mcVersion = process.env.MC_VERSION
  const password = process.env.MC_PASSWORD?.trim()
  return {
    minecraft: {
      host: process.env.MC_HOST || 'mc.zenoxs.cn',
      port: envInt(process.env.MC_PORT, 25565),
      username: process.env.MC_USERNAME,
      password: password || undefined,
      auth: process.env.MC_AUTH || 'microsoft',
      profilesFolder: resolvePath(process.env.MC_PROFILES_FOLDER || './mc-tokens'),
      version: !mcVersion || mcVersion === 'false' ? false : mcVersion,
      checkTimeoutInterval: envInt(process.env.MC_CHECK_TIMEOUT, 60000)
    },
    astrbot: {
      enabled: envBool(process.env.ASTRBOT_ENABLED, false),
      port: envInt(process.env.API_PORT, 15100),
      apiKey: process.env.API_KEY
    },
    messageQueue: {
      maxSize: envInt(process.env.QUEUE_MAX_SIZE, 100),
      delayMs: envInt(process.env.QUEUE_DELAY_MS, 1000)
    },
    adminList: parseAdminList(process.env.MC_ADMIN_LIST)
  }
}

interface RawWaypoint {
  id: string
  alias: string
  cmd?: string
  owner?: string
}

function normalizeWaypoints (raw: unknown): RawWaypoint[] {
  if (!Array.isArray(raw)) return []

  const waypoints: RawWaypoint[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      waypoints.push({ id: item, alias: item })
      continue
    }
    if (item && typeof item === 'object') {
      const w = item as Record<string, unknown>
      const alias = String(w.alias || '').trim()
      const cmd = String(w.cmd || '').trim()
      if (!alias) continue
      const id = String(w.id || '').trim() || alias
      const owner = String(w.owner || '').trim()
      waypoints.push({ id, alias, cmd: cmd || undefined, owner: owner || undefined })
    }
  }
  return waypoints
}

function parseDurationSeconds (raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string') return Number.NaN

  const value = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)

  const units: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400
  }
  const pattern = /(\d+(?:\.\d+)?)([smhd])/g
  let total = 0
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) != null) {
    if (match.index !== consumed) return Number.NaN
    total += Number(match[1]) * units[match[2]]
    consumed = pattern.lastIndex
  }
  return consumed === value.length && consumed > 0 ? total : Number.NaN
}

function parseAgingWood (raw: unknown): AgingWoodType | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if ((AGING_WOOD_TYPES as readonly string[]).includes(value)) {
    return value as AgingWoodType
  }
  const zh = AGING_WOOD_ZH[String(raw ?? '').trim()]
  return zh ?? null
}

function parseAging (
  raw: unknown
): BrewRecipe['aging'] | null | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'number' || typeof raw === 'string') {
    const days = Number(raw)
    if (!Number.isInteger(days) || days <= 0) return null
    return { days, wood: 'any' }
  }
  if (typeof raw !== 'object') return null
  const entry = raw as { days?: unknown, wood?: unknown }
  const days = Number(entry.days)
  const wood = parseAgingWood(entry.wood ?? 'any')
  if (!Number.isInteger(days) || days <= 0 || !wood) return null
  return { days, wood }
}

function parseIngredients (raw: unknown): FermentationIngredient[] {
  if (Array.isArray(raw)) {
    return raw
      .map(item => {
        const entry = item as { container?: unknown, count?: unknown } | null
        return {
          container: String(entry?.container ?? '').trim(),
          count: Number(entry?.count)
        }
      })
      .filter(item => item.container && Number.isInteger(item.count) && item.count > 0)
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .map(([container, count]) => ({
        container: container.trim(),
        count: Number(count)
      }))
      .filter(item => item.container && Number.isInteger(item.count) && item.count > 0)
  }
  return []
}

/** 从 config/recipes/*.json 加载配方；配方 id 默认为文件名 */
export function loadBrewRecipes (): BrewRecipe[] {
  if (!fs.existsSync(RECIPES_CONFIG_DIR)) return []

  const files = fs.readdirSync(RECIPES_CONFIG_DIR)
    .filter(name => name.endsWith('.json'))
    .sort()
  const recipes: BrewRecipe[] = []

  for (const fileName of files) {
    const filePath = path.join(RECIPES_CONFIG_DIR, fileName)
    const raw = readJson<Record<string, unknown>>(filePath)
    if (!raw) continue

    const defaultId = path.basename(fileName).replace(/\.json$/i, '')
    const id = String(raw.id ?? defaultId).trim()
    const fermentationRaw = raw.fermentation as { duration?: unknown, ingredients?: unknown } | undefined
    const durationSeconds = parseDurationSeconds(fermentationRaw?.duration)
    const ingredients = parseIngredients(fermentationRaw?.ingredients)
    const distillationRuns = raw.distillation == null
      ? null
      : Number(
          typeof raw.distillation === 'object'
            ? (raw.distillation as { runs?: unknown }).runs
            : raw.distillation
        )
    const aging = parseAging(raw.aging)

    if (
      !id ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds < 0 ||
      ingredients.length === 0 ||
      (distillationRuns != null && (!Number.isInteger(distillationRuns) || distillationRuns <= 0)) ||
      aging === null
    ) {
      console.warn(`[Config] Invalid brew recipe: ${filePath}`)
      continue
    }
    if (recipes.some(recipe => recipe.id === id)) {
      console.warn(`[Config] Duplicate brew recipe id "${id}": ${filePath}`)
      continue
    }

    recipes.push({
      id,
      fermentation: { durationSeconds, ingredients },
      ...(distillationRuns != null ? { distillation: { runs: distillationRuns } } : {}),
      ...(aging !== undefined ? { aging } : {})
    })
  }

  return recipes
}

function parseWaterMode (raw: unknown): BrewWaterMode {
  const value = String(raw ?? '').trim().toLowerCase()
  return value === 'source' || value === 'preloaded' || value === 'bucket-stock'
    ? value
    : 'bucket-stock'
}

function loadFeatureConfig (): Pick<AppConfig, 'command' | 'teleport' | 'bot' | 'viewer' | 'brew' | 'botPhome' | 'botIdentity' | 'loopCmd' | 'phomeTowns'> {
  const commandPath = path.join(GAME_CONFIG_DIR, 'command.json')
  // Phome points are shared by all bot processes; ownership lives on each waypoint.
  const teleportConfigFile = 'teleport.json'
  const teleportPath = path.join(GAME_CONFIG_DIR, teleportConfigFile)
  const botPath = path.join(GAME_CONFIG_DIR, 'bot.json')
  const viewerPath = path.join(GAME_CONFIG_DIR, 'viewer.json')
  const brewPath = path.join(GAME_CONFIG_DIR, 'brew.json')

  const commandConfig = readJson<Partial<AppConfig['command']>>(commandPath) ?? {}
  const teleportConfig = readJson<Partial<AppConfig['teleport']>>(teleportPath) ?? {}
  const botConfig = readJson<Partial<AppConfig['bot']>>(botPath) ?? {}
  const viewerConfig = readJson<Partial<AppConfig['viewer']>>(viewerPath) ?? {}
  const brewConfig = (readJson<Partial<AppConfig['brew']> & { productContainer?: string }>(brewPath) ?? {})
  const phomeTowns = readJson<PhomeTownsConfig>(path.join(GAME_CONFIG_DIR, 'phome_towns.json'))
  const messages = loadMessagesConfig()

  debug(`[Config] Game config dir: ${GAME_CONFIG_DIR}`)
  debug(`[Config] command.json -> prefix="${commandConfig.prefix ?? '(default #ybot)'}"`)

  const prefix = commandConfig.prefix || '#ybot'

  // Also read raw JSON to get cmd field on waypoints
  let rawTeleportJson: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(teleportPath, 'utf-8')
    rawTeleportJson = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
  } catch { /* */ }
  const rawWaypoints = (rawTeleportJson.waypoints as unknown) ?? teleportConfig.waypoints

  return {
    command: {
      prefix,
      whisperCommand: commandConfig.whisperCommand || '/msg',
      allowPublicCommands: commandConfig.allowPublicCommands ?? false,
      replyAlwaysWhisper: commandConfig.replyAlwaysWhisper ?? true,
      messages
    },
    teleport: {
      databaseFile: process.env.MC_DB_FILE || teleportConfig.databaseFile || './data/md/mchatbot.db',
      tpacceptCommand: teleportConfig.tpacceptCommand || '/tpaccept',
      tpdenyCommand: (teleportConfig as any).tpdenyCommand || '/tpdeny',
      tpahereCommand: teleportConfig.tpahereCommand || '/tpahere',
      phomeCommand: teleportConfig.phomeCommand || '/phome',
      waypoints: normalizeWaypoints(rawWaypoints),
      waypointDelayMs: teleportConfig.waypointDelayMs ?? 3000,
    },
    bot: {
      idleTimeoutMs: botConfig.idleTimeoutMs ?? 90000,
      idleCheckIntervalMs: botConfig.idleCheckIntervalMs ?? 10000,
      homeCommand: botConfig.homeCommand || '/home',
      afkCommand: botConfig.afkCommand || '/afk',
      afkDelayMs: botConfig.afkDelayMs ?? 500,
      homeWaitMs: botConfig.homeWaitMs ?? 3000,
      interactionDistance: botConfig.interactionDistance ?? 3,
      approachDistance: botConfig.approachDistance ?? 10,
      forwardWaitMs: botConfig.forwardWaitMs ?? 2000,
      ridingCheckIntervalMs: botConfig.ridingCheckIntervalMs ?? 1500,
      relockDistance: botConfig.relockDistance ?? 6,
      relockCheckIntervalMs: botConfig.relockCheckIntervalMs ?? 1000,
      loopCmdMaxIntervalSec: botConfig.loopCmdMaxIntervalSec ?? 3600,
      maxBlacklist: botConfig.maxBlacklist ?? 50,
      maxPhomeWl: botConfig.maxPhomeWl ?? 30,
      baseCheckIntervalMs: botConfig.baseCheckIntervalMs ?? 250,
      tpaCooldownMs: botConfig.tpaCooldownMs ?? 5000,
      unlockAllTimeoutSec: botConfig.unlockAllTimeoutSec ?? 60
    },
    viewer: {
      enabled: viewerConfig.enabled ?? false,
      port: viewerConfig.port ?? 3007,
      firstPerson: viewerConfig.firstPerson ?? false,
      viewDistance: viewerConfig.viewDistance ?? 6
    },
    brew: {
      enabled: brewConfig.enabled ?? false,
      group: String(brewConfig.group ?? 'brew_main').trim(),
      fermenterCount: Number(brewConfig.fermenterCount ?? 9),
      waterMode: parseWaterMode(brewConfig.waterMode),
      toolbox: String(brewConfig.toolbox ?? 'tools').trim(),
      waterSource: String(brewConfig.waterSource ?? 'water').trim(),
      waterBucketContainer: String(brewConfig.waterBucketContainer ?? 'water_buckets').trim(),
      emptyBucketContainer: String(brewConfig.emptyBucketContainer ?? 'empty_buckets').trim(),
      bottleContainer: String(brewConfig.bottleContainer ?? 'bottle').trim(),
      productContainers: Array.isArray(brewConfig.productContainers) && brewConfig.productContainers.length > 0
        ? brewConfig.productContainers.map(String)
        : [String(brewConfig.productContainer ?? 'products').trim()],
      stagingContainer: String(brewConfig.stagingContainer ?? '').trim(),
      interactionDelayMs: Number(brewConfig.interactionDelayMs ?? 300),
      waterRefillDelayMs: Number(brewConfig.waterRefillDelayMs ?? 750),
      recipes: loadBrewRecipes()
    },
    botPhome: {
      name: process.env.BOT_NAME || (botConfig as Record<string, unknown>).botName as string || 'WLLBot',
      owned: envInt(process.env.BOT_PHOME_OWNED, 6),
      dataFile: (botConfig as Record<string, unknown>).phomeDataFile as string || 'phome_data.txt'
    },
    botIdentity: {
      index: envInt(process.env.BOT_INDEX, 1),
      accountName: process.env.MC_USERNAME || '',
      baseMinX: envInt(process.env.BOT_BASE_MIN_X, 0),
      baseMaxX: envInt(process.env.BOT_BASE_MAX_X, 0),
      baseMinZ: envInt(process.env.BOT_BASE_MIN_Z, 0),
      baseMaxZ: envInt(process.env.BOT_BASE_MAX_Z, 0)
    },
    loopCmd: {
      enabled: false,
      text: '',
      intervalSec: 60
    },
    phomeTowns: phomeTowns ?? { mainBot: '', bots: {} }
  }
}

export function loadConfig (): AppConfig {
  return { ...loadEnvConfig(), ...loadFeatureConfig() }
}

export function validateConfig (config: AppConfig): void {
  if (!config.minecraft.username) {
    console.error('[Config] Error: MC_USERNAME is required in .env')
    process.exit(1)
  }

  if (config.astrbot.enabled && !config.astrbot.apiKey) {
    console.error('[Config] Error: API_KEY is required in .env when ASTRBOT_ENABLED=true')
    process.exit(1)
  }
}

export function resolveDataPath (relativePath: string): string {
  return path.join(PROJECT_ROOT, relativePath)
}

export { PROJECT_ROOT, GAME_CONFIG_DIR }
