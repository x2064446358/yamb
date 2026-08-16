export interface MinecraftConfig {
  host: string
  port: number
  username: string | undefined
  password: string | undefined
  auth: string
  profilesFolder: string
  version: string | false
  checkTimeoutInterval: number
}

export interface AstrbotConfig {
  enabled: boolean
  port: number
  apiKey: string | undefined
}

export interface MessagesConfig {
  emptyCommand?: string
  unknownCommand?: string
  noPermission?: string
  phomeUsage?: string
  phomeError?: string
  lockedBlocked?: string
  tpaBusy?: string
  allBusy?: string
  tpaRejected?: string
  lockAlready?: string
  lockUsage?: string
  lockSuccess?: string
  lockHoverSuccess?: string
  lockHoverFailed?: string
  unlockNotLocked?: string
  unlockSuccess?: string
  addUsage?: string
  addAlready?: string
  addSuccess?: string
  removeUsage?: string
  removeNotFound?: string
  removeSuccess?: string
  statusLines?: string[]
  statusLocked?: string
  statusUnlocked?: string
  statusIdle?: string
  statusRidingPlayer?: string
  statusRidingMinecart?: string
  sayUsage?: string
  saySuccess?: string
  sayError?: string
  forwardUsage?: string
  forwardSuccess?: string
  forwardEmpty?: string
  forwardError?: string
  mountUsage?: string
  mountSuccess?: string
  mountError?: string
  mountAlready?: string
  unmountSuccess?: string
  unmountError?: string
  cartSuccess?: string
  cartError?: string
  invHeader?: string
  invEmpty?: string
  invError?: string
  storeUsage?: string
  storeSuccess?: string
  storeError?: string
  takeUsage?: string
  takeSuccess?: string
  takeError?: string
  dropUsage?: string
  dropSuccess?: string
  dropError?: string
  attackUsage?: string
  attackSuccess?: string
  attackError?: string
  containerAddUsage?: string
  containerAddSuccess?: string
  containerRemoveUsage?: string
  containerRemoveSuccess?: string
  containerRemoveNotFound?: string
  containerListEmpty?: string
  containerListHeader?: string
  containerListEntry?: string
  containerInfoUsage?: string
  containerInfoNotFound?: string
  containerInfoLines?: string[]
  containerNoTarget?: string
  statusLine?: string
  statusLineLocked?: string
  notWhitelisted?: string
  tpaRequestSent?: string
  lockedCannotUnlock?: string
  unknownWaypoint?: string
  lockedForTime?: string
  teleportFailed?: string
  latelanOnly?: string
  mountNoPlayerNear?: string
  cannotApproach?: string
  mounted?: string
  mountFailed?: string
  mountFailedDetail?: string
  unmounted?: string
  stoodUp?: string
  crouched?: string
  alreadyLocked?: string
  botNotReady?: string
  dropAllSuccess?: string
  holdUsage?: string
  holdNotFound?: string
  useComplete?: string
  useFailed?: string
  holdSuccess?: string
  lookUsage?: string
  lookPlayerNotFound?: string
  blacklistAdd?: string
  blacklistAddUsage?: string
  unlockedShort?: string
  transferLockUsage?: string
  notLocked?: string
  transferLockSuccess?: string
  wlListEmpty?: string
  wlListPage?: string
  phomeSaOnly?: string
  phomeSaAddUsage?: string
  phomeSaAlready?: string
  phomeSaAddSuccess?: string
  phomeSaRemoveUsage?: string
  phomeSaNotFound?: string
  phomeSaRemoveSuccess?: string
  phomeSaList?: string
  phomeWlAddUsage?: string
  phomeWlAlready?: string
  phomeWlAddSuccess?: string
  phomeWlRemoveUsage?: string
  phomeWlNotFound?: string
  phomeWlRemoveSuccess?: string
  phomeWlList?: string
  phomePointAddUsage?: string
  phomePointRemoveUsage?: string
  invalidNumber?: string
  enchantNotFound?: string
  jumpDone?: string
  jumpUsage?: string
  execUsage?: string
  execSuccess?: string
  loopStopped?: string
  loopStatusActive?: string
  loopStatusIdle?: string
  loopUsage?: string
  loopStarted?: string
  waterUsage?: string
  waterBucketSuccess?: string
  waterBottleSuccess?: string
  waterNoWater?: string
  waterNoItem?: string
  waterEquipFail?: string
  waterTooFar?: string
  waterNotFilled?: string
  waterUnsupported?: string
  waterFail?: string
  brewUsage?: string
  brewDisabled?: string
  brewRecipeNotFound?: string
  brewBusy?: string
  brewStarted?: string
  brewStatusIdle?: string
  brewStatusRunning?: string
  brewCancelRequested?: string
  brewStopped?: string
  brewNotAllowed?: string
  brewWlAddUsage?: string
  brewWlAlready?: string
  brewWlAddSuccess?: string
  brewWlRemoveUsage?: string
  brewWlNotFound?: string
  brewWlRemoveSuccess?: string
  brewWlList?: string
  brewWlListEmpty?: string
  timerUsage?: string
  timerStarted?: string
  timerReplaced?: string
  timerInvalid?: string
  timerTooLong?: string
  timerDone?: string
  timerCancelUsage?: string
  timerCanceled?: string
  timerCancelNotFound?: string
  timerListEmpty?: string
  timerList?: string
  helpIntro?: string
  helpAdminIntro?: string
  helpAdminHint?: string
  helpBasic?: string[]
  helpAdmin?: string[]
  nodeAddUsage?: string
  nodeAddNoTarget?: string
  nodeAddSuccess?: string
  nodeRemoveUsage?: string
  nodeRemoveSuccess?: string
  nodeRemoveNotFound?: string
  nodeListEmpty?: string
  nodeListHeader?: string
  nodeListEntry?: string
  nodeInfoUsage?: string
  nodeInfoNotFound?: string
  nodeInfoLines?: string[]
  nodeNotInGroup?: string
  phomeRedirect?: string
  phomeDelegated?: string
  /** 无候选可代：同镇全被占/离线，带锁定人信息 */
  phomeBusyNoCandidates?: string
  /** 有候选但超时：提示可重试 */
  phomeBusyTimeout?: string
}

export interface CommandConfig {
  prefix: string
  whisperCommand: string
  allowPublicCommands: boolean
  replyAlwaysWhisper: boolean
  messages: MessagesConfig
}

export interface WaypointConfig {
  id: string
  alias: string
  cmd?: string
}

export interface TeleportConfig {
  databaseFile: string
  tpacceptCommand: string
  tpdenyCommand: string
  tpahereCommand: string
  phomeCommand: string
  waypoints: WaypointConfig[]
  waypointDelayMs?: number
  ownedIndices?: number[]
}

export interface BotBehaviorConfig {
  idleTimeoutMs: number
  idleCheckIntervalMs: number
  homeCommand: string
  afkCommand: string
  afkDelayMs: number
  homeWaitMs: number
  replyDelayMs: number
  interactionDistance: number
  approachDistance: number
  forwardWaitMs: number
  ridingCheckIntervalMs: number
  relockDistance: number
  relockCheckIntervalMs: number
  loopCmdMaxIntervalSec: number
  maxBlacklist: number
  maxPhomeWl: number
  baseCheckIntervalMs: number
  tpaCooldownMs: number
  unlockAllTimeoutSec: number
}

export interface ViewerConfig {
  enabled: boolean
  port: number
  firstPerson: boolean
  viewDistance: number
}

export const AGING_WOOD_TYPES = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'mangrove',
  'cherry',
  'bamboo',
  'any'
] as const

export type AgingWoodType = typeof AGING_WOOD_TYPES[number]

/** 木种中文名 → 英文标识；用于配置可直接写中文 */
export const AGING_WOOD_ZH: Record<string, AgingWoodType> = {
  橡木: 'oak',
  云杉木: 'spruce',
  白桦木: 'birch',
  丛林木: 'jungle',
  金合欢木: 'acacia',
  红树木: 'mangrove',
  樱花木: 'cherry',
  竹: 'bamboo',
  任意: 'any'
}

export interface FermentationIngredient {
  /** 专用容器 BlockNode alias（不是物品 ID） */
  container: string
  /** 每锅数量 */
  count: number
}

export interface BrewRecipe {
  id: string
  fermentation: {
    durationSeconds: number
    ingredients: FermentationIngredient[]
  }
  /** 省略时，发酵产物直接入成品箱 */
  distillation?: {
    /** 蒸馏循环次数；每次按 45 秒（40 秒 + 5 秒冗余）等待 */
    runs: number
  }
  /** 省略时不进行陈化；days 为游戏日，每游戏日等待 20 分钟 */
  aging?: {
    days: number
    wood: AgingWoodType
  }
}

export type BrewWaterMode = 'source' | 'preloaded' | 'bucket-stock'

export interface BrewConfig {
  enabled: boolean
  group: string
  fermenterCount: number
  waterMode: BrewWaterMode
  toolbox: string
  waterSource: string
  waterBucketContainer: string
  emptyBucketContainer: string
  bottleContainer: string
  /** 按顺序使用的混合产物容器 BlockNode alias */
  productContainers: string[]
  /** 暂存箱（混合容器）：开酿前清空背包暂存，酿完拿回；留空表示不启用 */
  stagingContainer: string
  interactionDelayMs: number
  waterRefillDelayMs: number
  recipes: BrewRecipe[]
}

export interface MessageQueueConfig {
  maxSize: number
  delayMs: number
}

export interface BotPhomeConfig {
  name: string
  owned: number
  dataFile: string
}

/** phome_towns.json：小镇 → bot 映射，用于同小镇 bot 在 owner 被锁时代执行 /phome 点 */
export interface PhomeBotTown {
  /** BOT_INDEX，对应 teleport{index}.json 配置文件（index 1 = teleport.json） */
  index: number
  town: string
}

export interface PhomeTownsConfig {
  /** 主 bot：只有它响应 %0 / 私聊 0 的传送点列表 */
  mainBot: string
  bots: Record<string, PhomeBotTown>
}

export interface BotIdentityConfig {
  index: number
  accountName: string
  baseMinX: number
  baseMaxX: number
  baseMinZ: number
  baseMaxZ: number
}

export interface LoopCmdConfig {
  enabled: boolean
  text: string
  intervalSec: number
}

export interface AppConfig {
  minecraft: MinecraftConfig
  astrbot: AstrbotConfig
  adminList: string[]
  command: CommandConfig
  teleport: TeleportConfig
  bot: BotBehaviorConfig
  viewer: ViewerConfig
  brew: BrewConfig
  messageQueue: MessageQueueConfig
  botPhome: BotPhomeConfig
  botIdentity: BotIdentityConfig
  loopCmd: LoopCmdConfig
  phomeTowns: PhomeTownsConfig
}

export interface ServiceResult {
  success: boolean
  message?: string
  code?: 'locked' | 'not_ready' | 'unknown_waypoint'
    | 'bucket' | 'bottle'
    | 'no_water' | 'no_item' | 'equip_fail' | 'too_far' | 'not_filled' | 'unsupported'
    | 'barrel_full'
  lockedBy?: string | null
  /** 额外数据（供模板填充），例如装水的距离/物品名 */
  data?: Record<string, string | number>
}

export interface PlayersResult extends ServiceResult {
  players?: string[]
  count?: number
}

export interface StatusResult extends ServiceResult {
  minecraft?: boolean
  username?: string | null
  uptime?: number
  whitelist_count?: number
}

export interface WhitelistEntry {
  addedBy: string
  addedAt: string
}

export type WhitelistData = Record<string, WhitelistEntry>

export interface QueueTask {
  message: string
  sender: string | null
  timestamp: number
}

export interface QueueStatus {
  size: number
  isProcessing: boolean
  isLocked: boolean
  maxSize: number
}

