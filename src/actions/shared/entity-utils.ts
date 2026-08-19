import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder'
import type { ServiceResult } from '../../types'
import { sleep } from '../../platform/sleep'
import { debug } from '../../platform/logger'

type Entity = NonNullable<Bot['entities'][string]>

export type BotWithPathfinder = Bot & {
  _mchatbotPathfinderReady?: boolean
  pathfinder: {
    setMovements: (movements: Movements) => void
    goto: (goal: goals.GoalNear | goals.GoalLookAtBlock | goals.GoalBlock) => Promise<void>
    stop: () => void
  }
}

type EntityWithVehicle = Entity & { vehicle?: Entity | null; passengers?: Entity[] }

type EntityWithEyeHeight = Entity & { eyeHeight: number }

export type BotWithVehicle = Bot & { vehicle?: Entity | null }

export function ensurePathfinder (bot: Bot): BotWithPathfinder {
  const b = bot as BotWithPathfinder
  if (!b._mchatbotPathfinderReady) {
    bot.loadPlugin(pathfinder)
    const movements = new Movements(bot)
    // 在玩家基地内寻路：不挖方块、不搭柱子，绕障碍走，避免破坏建筑/卡在挖掘
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = true
    movements.allowSprinting = true
    movements.canOpenDoors = true
    b.pathfinder.setMovements(movements)
    b._mchatbotPathfinderReady = true
  }
  return b
}

export function entityDistance (bot: Bot, entity: Entity): number {
  return bot.entity.position.distanceTo(entity.position)
}

export function entityLookPoint (entity: Entity) {
  return entity.position.offset(0, entity.height * 0.85, 0)
}

export function getPlayerEntity (bot: Bot, playerName: string): Entity | null {
  const entity = bot.players[playerName]?.entity
  if (entity) return entity

  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id]
    if (e.type === 'player' && e.username === playerName) return e
  }
  return null
}

export function getVehicle (bot: Bot): Entity | null {
  return (bot as BotWithVehicle).vehicle ?? null
}

export function getEntityVehicle (bot: Bot): Entity | null {
  return (bot.entity as EntityWithVehicle).vehicle ?? null
}

/**
 * 骑乘时 mineflayer 会把内部 shouldUsePhysics 置 false，物理循环不再发送 look 包，
 * bot.look()/lookAt() 只更新本地朝向、服务端视角不变。此函数直接向服务端写 look 包绕开该限制。
 */
export function lookAtMounted (bot: Bot, point: Vec3): Promise<void> {
  const eye = (bot.entity as EntityWithEyeHeight).eyeHeight ?? bot.entity.height * 0.9
  const delta = point.minus(bot.entity.position.offset(0, eye, 0))
  const yaw = Math.atan2(-delta.x, -delta.z)
  const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
  const pitch = Math.atan2(delta.y, groundDistance)

  bot.entity.yaw = yaw
  bot.entity.pitch = pitch

  bot._client.write('look', {
    yaw: Math.fround((Math.PI - yaw) * (180 / Math.PI)),
    pitch: Math.fround(-pitch * (180 / Math.PI)),
    onGround: bot.entity.onGround,
    flags: { onGround: bot.entity.onGround, hasHorizontalCollision: undefined }
  })
  return Promise.resolve()
}

/** 朝向统一入口：骑乘时直写 look 包，否则走标准 bot.lookAt */
export function lookAtSmart (bot: Bot, point: Vec3, force = true): Promise<void> {
  if (getVehicle(bot) || getEntityVehicle(bot)) {
    return lookAtMounted(bot, point)
  }
  return bot.lookAt(point, force)
}

/** bot 眼睛高度（mineflayer 类型未声明 eyeHeight，运行时存在） */
export function eyeHeightOf (bot: Bot): number {
  return (bot.entity as EntityWithEyeHeight).eyeHeight ?? bot.entity.height * 0.9
}

/**
 * 按角度看向（F3 风格：横 = 方位角 yaw，纵 = 俯仰角 pitch）。
 * 换算成目标点后走 lookAtSmart（骑乘时直写 look 包），并返回该目标点供 place 复用。
 */
export function lookAnglesSmart (bot: Bot, yawDeg: number, pitchDeg: number, distance = 4): Vec3 {
  const yaw = Math.PI - (yawDeg * Math.PI) / 180
  const pitch = (-pitchDeg * Math.PI) / 180
  const eye = bot.entity.position.offset(0, eyeHeightOf(bot), 0)
  const dir = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  )
  const target = eye.plus(dir.scaled(distance))
  void lookAtSmart(bot, target)
  return target
}

export function clearVehicleState (bot: Bot): void {
  ;(bot as BotWithVehicle).vehicle = null
  if (bot.entity) {
    (bot.entity as { vehicle?: Entity | null }).vehicle = null
  }
}

const NON_RIDEABLE_MINECARTS = [
  'chest_minecart', 'furnace_minecart', 'hopper_minecart',
  'tnt_minecart', 'command_block_minecart', 'spawner_minecart'
]

export function isMinecartEntity (entity: Entity): boolean {
  const name = String(entity.name || entity.displayName || '').toLowerCase()
  if (NON_RIDEABLE_MINECARTS.includes(name)) return false
  return name.includes('minecart')
}

/** 可骑乘实体：基础矿车 / 船 / 马(驴/骡) / 猪 —— 排除漏斗矿车、箱子矿车等不能坐的 */
export function isRideableEntity (entity: Entity): boolean {
  const name = String(entity.name || entity.displayName || '').toLowerCase()
  if (NON_RIDEABLE_MINECARTS.includes(name)) return false
  if (name.includes('minecart')) return true
  if (name.includes('boat')) return true
  if (name.includes('horse') || name === 'donkey' || name === 'mule') return true
  if (name === 'pig') return true
  return false
}

export function isAreaEffectCloudEntity (entity: Entity): boolean {
  return String(entity.name || entity.displayName || '').toLowerCase().includes('area_effect_cloud')
}

/** 是否正坐在插件用的 area_effect_cloud 坐骑上（与云水平重合） */
export function isOnPluginCloudSeat (bot: Bot): boolean {
  const vehicle = getVehicle(bot) ?? getEntityVehicle(bot)
  if (!vehicle || !isAreaEffectCloudEntity(vehicle)) return false
  const horizontal = Math.hypot(
    bot.entity.position.x - vehicle.position.x,
    bot.entity.position.z - vehicle.position.z
  )
  return horizontal < 0.75
}

/** 是否仍挂在"有效载具"上（忽略未对齐的残留 AEC 引用） */
export function hasActiveVehicle (bot: Bot): boolean {
  const vehicle = getVehicle(bot) ?? getEntityVehicle(bot)
  if (!vehicle) return false
  if (isAreaEffectCloudEntity(vehicle)) return isOnPluginCloudSeat(bot)
  return true
}

export function isMountedOnPlayer (bot: Bot, playerName: string): boolean {
  const player = getPlayerEntity(bot, playerName)
  if (!player) return false

  const horizontal = Math.hypot(
    bot.entity.position.x - player.position.x,
    bot.entity.position.z - player.position.z
  )
  const dy = bot.entity.position.y - player.position.y
  const physicallyRiding = horizontal < 1.8 && dy >= -0.5 && dy <= 2.5

  if (physicallyRiding) return true

  const vehicle = getVehicle(bot) ?? getEntityVehicle(bot)
  if (!vehicle) return false

  const onPlayer = vehicle === player || vehicle.username === playerName
  if (!onPlayer) return false

  return horizontal < 2.5 && dy >= -1 && dy <= 3
}

export function isMountedOnMinecart (bot: Bot): boolean {
  const vehicle = getVehicle(bot) ?? getEntityVehicle(bot)
  if (!vehicle || !isMinecartEntity(vehicle)) return false
  // 骑乘移动中的矿车时，mineflayer 可能不再同步 bot.entity 的坐标；
  // 不能再用 bot 与矿车的距离判断，否则矿车离开原坐标后会被误判为已下车。
  return true
}

/** 是否正骑乘任意可骑乘实体（矿车/船/马/猪） */
export function isMountedOnVehicle (bot: Bot): boolean {
  const vehicle = getVehicle(bot) ?? getEntityVehicle(bot)
  if (!vehicle || !isRideableEntity(vehicle)) return false
  return true
}

/** 离开插件 AEC 坐骑：以潜行为主（bot.dismount 对此类载具常报 not mounted） */
export async function leavePluginSeat (bot: Bot): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    bot.setControlState('sneak', true)
    await sleep(attempt <= 2 ? 450 : 650)

    try {
      bot.dismount()
    } catch {
      // 插件云座下 mineflayer 常抛 dismount: not mounted，忽略即可
    }

    bot.setControlState('sneak', false)
    bot.clearControlStates()
    clearVehicleState(bot)
    await sleep(250)

    if (!hasActiveVehicle(bot) && !isOnPluginCloudSeat(bot)) {
      debug(`[Riding] 已离开云座 (第 ${attempt} 次潜行)`)
      resumeBotPhysics(bot)
      return true
    }
  }

  clearVehicleState(bot)
  resumeBotPhysics(bot)
  return !hasActiveVehicle(bot) && !isOnPluginCloudSeat(bot)
}

export async function performDismount (
  bot: Bot,
  isStillMounted?: () => boolean
): Promise<boolean> {
  const leftSeat = await leavePluginSeat(bot)
  const stillMounted = isStillMounted?.() ?? false

  await waitForNaturalLanding(bot)

  if (leftSeat && !stillMounted) return true
  if (!hasActiveVehicle(bot) && !(isStillMounted?.() ?? false)) return true
  return false
}

/**
 * Mineflayer 在 mount 时会把内部 shouldUsePhysics 设为 false，
 * 但 dismount 后不会自动恢复（只有服务端传送包才会）。
 * 触发一次相对位移为 0 的内部 position 处理以恢复物理；不主动改坐标。
 */
export function resumeBotPhysics (bot: Bot): void {
  bot.physicsEnabled = true
  clearVehicleState(bot)

  try {
    bot._client.emit('position', {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      flags: { x: true, y: true, z: true, yaw: true, pitch: true },
      teleportId: 0
    })
    debug('[Physics] 已恢复物理结算')
  } catch (err) {
    console.warn('[Physics] 恢复物理失败:', (err as Error).message)
  }
}

/** 关闭物理模拟：停止本地重力，位置由 bot 维持（可悬空） */
export function suspendBotPhysics (bot: Bot): void {
  bot.clearControlStates()
  if (bot.entity.velocity) {
    bot.entity.velocity.set(0, 0, 0)
  }
  bot.physicsEnabled = false
  debug('[Physics] 已关闭物理结算（悬空）')
}

/**
 * 跳起后关闭物理，实现悬空。
 * @param riseMs 起跳后等待上升的时间再冻结
 */
export async function jumpAndHover (bot: Bot, riseMs = 250): Promise<boolean> {
  resumeBotPhysics(bot)
  bot.clearControlStates()

  bot.setControlState('jump', true)
  await sleep(80)
  bot.setControlState('jump', false)

  for (let i = 0; i < 20; i++) {
    await sleep(50)
    if (!bot.entity.onGround) break
  }

  if (bot.entity.onGround) {
    console.warn('[Physics] 未能离地，取消悬空')
    return false
  }

  await sleep(riseMs)
  suspendBotPhysics(bot)
  return true
}

/** 恢复物理并等待自然落地（不强制改写坐标包） */
export async function waitForNaturalLanding (bot: Bot, timeoutMs = 3000): Promise<boolean> {
  bot.clearControlStates()
  clearVehicleState(bot)
  resumeBotPhysics(bot)

  if (bot.entity.onGround) return true

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (bot.entity.onGround) return true
    const block = bot.blockAt(bot.entity.position, false)
    if (block == null) {
      console.warn('[Settle] 当前位置 chunk 未加载，等待地形...')
    }
    await sleep(50)
  }

  console.warn(
    `[Settle] 等待自然落地超时 y=${bot.entity.position.y.toFixed(2)}` +
    ` onGround=${bot.entity.onGround} physicsEnabled=${bot.physicsEnabled}`
  )
  return bot.entity.onGround
}

export async function settleOnGround (bot: Bot): Promise<void> {
  bot.clearControlStates()

  for (let i = 0; i < 15; i++) {
    await sleep(100)
    if (bot.entity.onGround) return
  }

  const pos = bot.entity.position
  const feetX = Math.floor(pos.x)
  const feetZ = Math.floor(pos.z)
  let standY: number | null = null

  for (let y = Math.floor(pos.y); y >= Math.floor(pos.y) - 8; y--) {
    const block = bot.blockAt(new Vec3(feetX, y, feetZ))
    if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
      standY = y + 1
      break
    }
  }

  if (standY != null) {
    const pfBot = ensurePathfinder(bot)
    try {
      await pfBot.pathfinder.goto(new goals.GoalNear(feetX + 0.5, standY, feetZ + 0.5, 0.8))
      await sleep(300)
    } catch {
      pfBot.pathfinder.stop()
    }
  }

  bot.clearControlStates()
  for (let i = 0; i < 8; i++) {
    if (bot.entity.onGround) return
    bot.setControlState('forward', true)
    await sleep(120)
    bot.setControlState('forward', false)
    await sleep(120)
  }
  bot.clearControlStates()
}

function isInWater (bot: Bot): boolean {
  try {
    const entity = bot.entity as { isInWater?: boolean }
    if (entity.isInWater) return true
    const feet = bot.blockAt(bot.entity.position)
    if (feet && (feet.name === 'water' || feet.name === 'flowing_water')) return true
    // 头部方块也判断：游泳时脚可能不在水里但头在水里
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0))
    return !!head && (head.name === 'water' || head.name === 'flowing_water')
  } catch {
    return false
  }
}

/**
 * 卡在水里：长按空格(跳跃=上浮) + 长按一个方向游，像真人一样持续按住
 * 直到头/脚离开水域，再逐方向换向尝试靠岸。
 */
export async function escapeFromWater (bot: Bot): Promise<boolean> {
  const start = bot.entity.position.clone()
  const dirs: Array<'forward' | 'right' | 'back' | 'left'> = ['forward', 'right', 'back', 'left']
  const HOLD_MS = 1_500
  const CHECK_MS = 200

  for (let i = 0; i < 8; i++) {
    if (!isInWater(bot)) return true

    const dir = dirs[i % dirs.length]
    // 持续按住：空格上浮 + 方向键移动，长按不松开（水中长按空格=上浮）
    bot.setControlState('jump', true)
    bot.setControlState(dir, true)

    const deadline = Date.now() + HOLD_MS
    while (Date.now() < deadline) {
      await sleep(CHECK_MS)
      if (!isInWater(bot)) {
        bot.clearControlStates()
        return true
      }
      // 游动中已远离出发点，视为挣脱成功
      if (bot.entity.position.distanceTo(start) > 2.5) {
        bot.clearControlStates()
        return true
      }
    }

    // 换方向前短暂停顿，让 bot 稳定
    bot.clearControlStates()
    await sleep(150)
  }
  bot.clearControlStates()
  return !isInWater(bot)
}

/**
 * 挣脱卡位（如卡进炼药锅/墙角）：跳跃 + 前进/后/左右交替，检测位置是否移动。
 * 返回是否成功移动。
 */
export async function escapeStuck (bot: Bot, attempts = 4): Promise<boolean> {
  if (isInWater(bot)) return escapeFromWater(bot)

  const start = bot.entity.position.clone()
  const dirs: Array<'forward' | 'right' | 'back' | 'left'> = ['forward', 'right', 'back', 'left']
  // 跳跃 + 前进（含对角线方向组合），先挣脱再判断
  for (let i = 0; i < attempts * 2; i++) {
    bot.setControlState('jump', true)
    const dir = dirs[i % dirs.length]
    bot.setControlState(dir, true)
    // 对角线：同时按前+侧
    if (i % 2 === 1 && dir !== 'back') {
      bot.setControlState(dir === 'forward' ? 'right' : 'forward', true)
    }
    await sleep(600)
    bot.clearControlStates()
    await sleep(250)
    if (bot.entity.position.distanceTo(start) > 0.8) return true
  }
  return false
}

/**
 * 寻路到目标：带进度监控（位置持续不动判定卡住）与超时。
 * 失败/卡住时先停止路径、再挣脱卡位/出水，然后重新寻路（最多 4 轮）。
 * 返回是否已在 interactionDistance 内。
 */
export async function gotoWithEscape (
  bot: Bot,
  target: Vec3,
  interactionDistance: number
): Promise<ServiceResult> {
  const pfBot = ensurePathfinder(bot)
  const goal = new goals.GoalNear(
    target.x,
    target.y,
    target.z,
    Math.max(1, interactionDistance - 0.5)
  )
  const near = (): boolean =>
    bot.entity.position.distanceTo(target) <= interactionDistance + 0.5

  // 超时按距离估算：基础 6s + 每格 0.8s，上限 30s
  const dist = bot.entity.position.distanceTo(target)
  const GOTO_TIMEOUT_MS = Math.min(30_000, Math.max(8_000, 6_000 + dist * 800))
  // 位置持续不动超过该时长视为卡住
  const STUCK_MS = 4_000
  const MOVE_EPS = 0.25

  for (let attempt = 0; attempt < 4; attempt++) {
    if (near()) return { success: true }

    // 卡在水里先出水
    if (isInWater(bot)) {
      await escapeFromWater(bot)
      await sleep(200)
      if (near()) return { success: true }
    }

    let lastPos = bot.entity.position.clone()
    let lastMoveAt = Date.now()
    let gotoDone = false

    try {
      const gotoP = pfBot.pathfinder.goto(goal)
      // 停止/超时后 goto 会以 PathStopped/GoalChanged 结束，立即记下，避免空等
      gotoP.then(() => { gotoDone = true }).catch(() => { gotoDone = true })

      // 进度监控：位置持续不动或到超时即中止等待
      const deadline = Date.now() + GOTO_TIMEOUT_MS
      while (!gotoDone && Date.now() < deadline) {
        if (near()) { gotoDone = true; break }
        await sleep(400)
        const pos = bot.entity.position
        if (pos.distanceTo(lastPos) > MOVE_EPS) {
          lastPos = pos.clone()
          lastMoveAt = Date.now()
        } else if (Date.now() - lastMoveAt > STUCK_MS) {
          gotoDone = true
        }
      }

      await sleep(150)
      if (near()) return { success: true }
    } catch {
      await sleep(200)
      if (near()) return { success: true }
    }

    // 先停掉旧路径，避免挣脱/出水时与控制状态冲突
    try { pfBot.pathfinder.stop() } catch { /* ignore */ }
    bot.clearControlStates()
    await sleep(300)
    if (near()) return { success: true }

    // 卡在水里：先出水再继续
    if (isInWater(bot)) {
      await escapeFromWater(bot)
      await sleep(200)
      if (near()) return { success: true }
      continue
    }

    const escaped = await escapeStuck(bot)
    await sleep(300)
    if (near()) return { success: true }
    if (!escaped && attempt === 3) {
      return { success: false, message: '无法接近目标: 位置被卡住，挣脱失败' }
    }
  }
  if (near()) return { success: true }
  return { success: false, message: '无法接近目标: 多次尝试失败' }
}

export async function approachEntity (
  bot: Bot,
  entity: Entity,
  interactionDistance: number,
  approachDistance: number
): Promise<ServiceResult> {
  const distance = entityDistance(bot, entity)
  if (distance > approachDistance) {
    return {
      success: false,
      message: `目标超过 ${approachDistance} 格 (当前 ${distance.toFixed(1)} 格)`
    }
  }

  if (distance <= interactionDistance) {
    return { success: true }
  }

  return gotoWithEscape(bot, entity.position, interactionDistance)
}

export function findNearestEntity (
  bot: Bot,
  predicate: (entity: Entity) => boolean,
  maxDistance: number
): Entity | null {
  let nearest: Entity | null = null
  let nearestDistance = maxDistance

  for (const id of Object.keys(bot.entities)) {
    const entity = bot.entities[id]
    if (entity === bot.entity) continue
    if (!predicate(entity)) continue

    const distance = entityDistance(bot, entity)
    if (distance <= nearestDistance) {
      nearest = entity
      nearestDistance = distance
    }
  }

  return nearest
}
