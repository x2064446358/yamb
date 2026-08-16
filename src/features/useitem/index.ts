import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import { debug } from '../../platform/logger'
import { ensurePathfinder, getEntityVehicle, getPlayerEntity, getVehicle, isRideableEntity, lookAnglesSmart, lookAtSmart, eyeHeightOf } from '../../actions/shared/entity-utils'
import { resolveItemKey, cnName } from '../../actions/inventory'
import { goals } from 'mineflayer-pathfinder'

type GenericPlaceBot = Bot & {
  _genericPlace?: (referenceBlock: unknown, faceVector: Vec3, options: {
    swingArm?: 'right' | 'left'
    showHand?: boolean
    forceLook?: boolean | 'ignore'
  }) => Promise<unknown>
}

function isAirBlock (block: { name?: string } | null | undefined): boolean {
  return !block || block.name === 'air' || block.name === 'void_air' || block.name === 'cave_air'
}

/** 相对放置：方向别名 → 规范名（放置 <上方/下方/前/后/左/右>；前=选定方块朝向 bot 的那面） */
const PLACE_DIRECTION_ALIASES: Record<string, string> = {
  '上方': '上方', '上': '上方', '上面': '上方', '上边': '上方',
  '下方': '下方', '下': '下方', '下面': '下方', '下边': '下方',
  '前': '前面', '前面': '前面', '前方': '前面', '前边': '前面',
  '后': '后面', '后面': '后面', '后方': '后面', '后边': '后面',
  '左': '左面', '左面': '左面', '左方': '左面', '左边': '左面',
  '右': '右面', '右面': '右面', '右方': '右面', '右边': '右面'
}

/**
 * 相对放置：方向 → 单位向量（在选定方块该方向相邻格放置）。
 * 上/下是绝对方向；前/后/左/右以选定方块为基准，前面 = 方块朝向 bot 的面
 * （bot 站在方块南边时，前方 = bot 侧）。axis 是从 bot 指向选定方块的水平量化轴向。
 */
function resolveDirectionVector (axis: Vec3 | null, dirName: string): Vec3 | null {
  if (axis) {
    switch (dirName) {
      case '前面': return axis.scaled(-1)
      case '后面': return axis
      case '左面': return new Vec3(axis.z, 0, -axis.x)
      case '右面': return new Vec3(-axis.z, 0, axis.x)
    }
  }
  switch (dirName) {
    case '上方': return new Vec3(0, 1, 0)
    case '下方': return new Vec3(0, -1, 0)
    default: return null
  }
}

/** 选择方块上离 bot 最近的那个面，返回指向该面的单位向量（右键点击该面） */
function nearestFaceVector (blockPos: Vec3, botPos: Vec3): Vec3 {
  const dx = blockPos.x + 0.5 - botPos.x
  const dy = blockPos.y + 0.5 - botPos.y
  const dz = blockPos.z + 0.5 - botPos.z
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const az = Math.abs(dz)
  if (ax >= ay && ax >= az) return new Vec3(dx > 0 ? -1 : 1, 0, 0) // 东西面
  if (ay >= ax && ay >= az) return new Vec3(0, dy > 0 ? -1 : 1, 0) // 上下
  return new Vec3(0, 0, dz > 0 ? -1 : 1) // 南北面
}

/** 找水方块上"暴露"的面（上方或四周邻接空气的那个面）。玩家舀水通常点顶面；全封闭则退回最近面 */
function findExposedFace (bot: Bot, waterPos: Vec3, botPos: Vec3): Vec3 {
  const isAir = (b: unknown): boolean =>
    !b || (b as { name?: string }).name === 'air' ||
    (b as { name?: string }).name === 'void_air' ||
    (b as { name?: string }).name === 'cave_air'
  if (isAir(bot.blockAt(waterPos.offset(0, 1, 0)))) return new Vec3(0, 1, 0) // 顶面暴露，最常见
  const sides: Vec3[] = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ]
  for (const off of sides) {
    if (isAir(bot.blockAt(waterPos.plus(off)))) return off
  }
  return nearestFaceVector(waterPos, botPos) // 全封闭，退回最近面
}

export default class UseItemModule {
  private mcBot: MinecraftBot
  private active = false
  private infinite = false
  private count = 0
  private interval = 4
  private intervalText = '0.2s'
  private timer = 0
  private isPlace = false
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private actionInProgress = false
  private loopGeneration = 0
  private useCompleteCallback: (() => void) | null = null
  private useFailedCallback: (() => void) | null = null
  /** 校准锁定的角度（真实放置验证过能出朝下活塞）；null=尚未校准 */
  private placeCalibrated: { yaw: number; pitch: number } | null = null
  /** 真实放置扫描：候选角度游标（每次机器推进换一个角度试） */
  private placeSweepIdx = 0
  /** 追踪放置的目标方块名（如 stone_brick_stairs）：持续找它并在其正下方放朝下活塞，用于跟随移动机器 */
  private placeTargetName: string | null = null
  /** 相对放置模式：选定参照方块的位置（当前看向的方块） */
  private relTarget: Vec3 | null = null
  /** 相对放置模式：放置方向单位向量（上方/下方/前/后/左/右） */
  private relDir: Vec3 | null = null
  /** 最近一次 look/看向 的目标坐标；放置 <方向> 优先用它作参照方块，避免射线被中间/透明方块挡而选错 */
  private lookTarget: Vec3 | null = null
  /** 破基岩模式的锁定人（发起 %放置 <方块名> 的人） */
  private breakOwner: string | null = null
  /** 破基岩模式开关回调（active=true 启动、false 停止），用于外部联动锁定 */
  private onBreakChange: ((active: boolean, owner: string | null) => void) | null = null

  constructor(mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  isActive(): boolean { return this.active }

  /** 是否处于"破基岩"追踪放置模式（放置 <方块名> 且正在执行） */
  isBedrockBreak(): boolean {
    return this.active && this.placeTargetName !== null
  }

  /** 外部联动：破基岩模式启动/停止时回调（用于锁定/解锁） */
  setOnBreakChange (fn: (active: boolean, owner: string | null) => void): void {
    this.onBreakChange = fn
  }

  private notifyBreakChange (): void {
    this.onBreakChange?.(this.isBedrockBreak(), this.breakOwner)
  }

  /** 真正把 look 包发出去（force=false），带超时防止卡死；并记录视线实际命中的方块作为放置参照 */
  private sendLook (bot: Bot, yawDeg: number, pitchDeg: number): void {
    try {
      const tp = lookAnglesSmart(bot, yawDeg, pitchDeg, 10)
      Promise.race([
        lookAtSmart(bot, tp, false),
        new Promise(resolve => setTimeout(resolve, 500))
      ]).catch(() => { /* */ })
      // lookAnglesSmart 已同步更新 entity.yaw/pitch，立即用新朝向射线锁定 bot 看向的方块
      this.lookTarget = this.currentLookBlock(bot)?.position ?? tp
    } catch { /* */ }
  }

  look(yawDeg: number, pitchDeg: number): string {
    const bot = this.mcBot.bot
    if (bot) this.sendLook(bot, yawDeg, pitchDeg)
    return `已看向 横${yawDeg}° 纵${pitchDeg}°`
  }

  /** 查询玩家当前朝向角度（横=方位角, 纵=俯仰角），并让 bot 看向同一角度 */
  lookPlayer(playerName: string): string | null {
    const bot = this.mcBot.bot
    if (!bot) return null
    const player = getPlayerEntity(bot, playerName)
    if (!player) return null

    const yawDeg = ((Math.PI - player.yaw) * 180 / Math.PI + 180 + 360) % 360 - 180
    const pitchDeg = -player.pitch * 180 / Math.PI
    this.sendLook(bot, yawDeg, pitchDeg)
    return `玩家 ${playerName} 正在看向 横${yawDeg.toFixed(1)}° 纵${pitchDeg.toFixed(1)}°`
  }

  /** 看向指定坐标 (x, y, z)，并记录该方块作为放置参照 */
  async lookAtCoord (x: number, y: number, z: number): Promise<string> {
    const bot = this.mcBot.bot
    if (!bot) return '机器人未就绪'
    this.lookTarget = new Vec3(x, y, z)
    try {
      await lookAtSmart(bot, new Vec3(x + 0.5, y + 0.5, z + 0.5), false)
    } catch (err) {
      return `看向失败: ${(err as Error).message}`
    }
    return `已看向 ${x}, ${y}, ${z}`
  }

  stop(): string {
    if (!this.active) return '当前未在使用。'
    this.clear()
    return '已停止使用。'
  }

  startUse(countStr: string, onComplete?: () => void, onFailed?: () => void): string {
    this.isPlace = false
    const result = this.start(countStr)
    // start() may clear a previous loop, so bind the new callback afterwards.
    this.useCompleteCallback = this.active && !this.infinite && !this.isPlace
      ? onComplete ?? null
      : null
    this.useFailedCallback = this.active && !this.infinite && !this.isPlace
      ? onFailed ?? null
      : null
    return result
  }

  startPlace(args: string, owner?: string): string {
    const bot = this.mcBot.bot
    const parts = args.trim().split(/\s+/).filter(Boolean)
    const first = parts[0] || ''
    if (first === '停止' || first === 'stop') return this.stop()

    // 新命令以最新为准：先清旧循环，避免 start 内部 clear 清掉刚设置的目标状态
    if (this.active) this.clear()
    this.useCompleteCallback = null
    this.useFailedCallback = null
    if (bot && !bot.heldItem) return '请先用 hold 手持方块。'

    // 相对放置：放置 <上方/下方/前/后/左/右> [次数] [间隔Xs]
    // 以 bot 当前视线（look/看向 选定）的方块为参照，在其指定方向放方块
    const dirName = PLACE_DIRECTION_ALIASES[first]
    if (dirName) {
      if (!bot) return '机器人未就绪'
      // 参照方块：优先用最近 look/看向 记录的方块（精确，不会被中间/透明方块挡住），否则射线兜底
      let ref: { position: Vec3; name: string } | null = null
      const recorded = this.lookTarget ? bot.blockAt(this.lookTarget) : null
      if (recorded && !isAirBlock(recorded)) {
        ref = { position: recorded.position, name: recorded.name }
      }
      if (!ref) ref = this.currentLookBlock(bot)
      if (!ref) return '准星前方没有可点击的方块（请先用 look/看向 对准一个方块）'
      const axis = this.horizAxis(bot, ref.position)
      const dirVec = resolveDirectionVector(axis, dirName)
      if (!dirVec) return '无法判断前后左右（bot 在选定方块正上/正下方），请换个位置，或只用 上方/下方'
      this.isPlace = true
      this.relTarget = ref.position
      this.relDir = dirVec
      this.placeTargetName = null
      this.breakOwner = null
      const res = this.start(parts.slice(1).join(' ') || '1')
      this.notifyBreakChange()
      return `在 ${cnName(ref.name)}${dirName} 放置，${res}`
    }

    // 破基岩追踪：放置 <方块名> [次数] [间隔Xs]
    // 持续找该方块并在其正下方放朝下活塞（跟随移动机器）；计数词不能当方块名
    const key = resolveItemKey(first)
    if (!key || ['无限次', '无限', 'infinite'].includes(first.toLowerCase())) {
      return '用法: 放置 <方块名|方向> [次数/无限] [间隔Xs]'
    }
    this.isPlace = true
    this.placeTargetName = key
    this.breakOwner = owner ?? this.breakOwner
    this.relTarget = null
    this.relDir = null
    const res = this.start(parts.slice(1).join(' ') || '1')
    this.notifyBreakChange()
    return `追踪 ${cnName(this.placeTargetName)}，${res}`
  }

  private start(countStr: string): string {
    const parsed = this.parseCountAndInterval(countStr)
    if (!parsed) return '格式: <次数/无限次/停止> [间隔Xs]'

    if (parsed.countStr === '停止' || parsed.countStr === 'stop') return this.stop()

    // 新命令以最新为准：先打断任何正在进行的循环再重新开始
    // （否则 放置 1 无法中断之前 放置 无限次 的循环，会表现为"一直放置"）
    // 注意 clear() 会把 isPlace 复位，先保留当前模式（放置/使用）
    const mode = this.isPlace
    if (this.active) this.clear()
    this.isPlace = mode

    this.interval = parsed.interval
    this.intervalText = parsed.intervalText
    this.timer = 0

    if (parsed.countStr === '无限次' || parsed.countStr === '无限' || parsed.countStr === 'infinite') {
      this.active = true
      this.infinite = true
      this.startLoop()
      return `开始无限${this.isPlace ? '放置' : '使用'} 间隔${this.intervalText}`
    }

    const count = parseInt(parsed.countStr, 10)
    if (isNaN(count) || count <= 0) return '格式: <次数/无限次/停止> [间隔Xs]'

    this.active = true
    this.infinite = false
    this.count = Math.min(count, 1000)
    this.startLoop()
    return `开始${this.isPlace ? '放置' : '使用'} ${this.count} 次 间隔${this.intervalText}`
  }

  interrupt(reason: string): void {
    if (this.active) {
      console.log(`[UseItem] Interrupted: ${reason}`)
      this.clear()
    }
  }

  /**
   * 用瓶/桶右键水方块装水：瓶 → 水瓶，桶 → 水桶。
   * @param choice '瓶' | '桶'；留空时按 手持物品 → 背包有桶 → 背包有瓶 的顺序自动选择
   */
  async fillWater (choice: string): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪' }
    }

    // 新装水命令打断任何正在进行的 use/place 循环，避免抢物品
    if (this.active) this.clear()

    // 1. 决定用哪个物品
    let target: string
    const held = bot.heldItem?.name
    if (choice === '瓶' || choice === 'bottle') {
      target = 'glass_bottle'
    } else if (choice === '桶' || choice === 'bucket') {
      target = 'bucket'
    } else if (held === 'glass_bottle' || held === 'bucket') {
      target = held
    } else {
      const names = new Set(bot.inventory.items().map(i => i.name))
      if (names.has('bucket')) target = 'bucket'
      else if (names.has('glass_bottle')) target = 'glass_bottle'
      else return { success: false, code: 'no_item' }
    }

    // 2. 找最近的可见水
    debug(`[Water] 协议版本=${bot.version}, 目标=${target}`)
    const water = bot.findBlock({
      matching: b => b?.name === 'water' || b?.name === 'flowing_water',
      maxDistance: 10
    })
    if (!water) return { success: false, code: 'no_water' }
    debug(`[Water] 找到 ${water.name} @ ${water.position.x},${water.position.y},${water.position.z}`)

    // 3. 装备目标物品
    const item = bot.inventory.items().find(i => i.name === target)
    if (!item) return { success: false, code: 'no_item' }
    try {
      await bot.equip(item, 'hand')
    } catch (err) {
      return { success: false, code: 'equip_fail', data: { item: target }, message: (err as Error).message }
    }

    // 4. 走近水：右键需要 ≤4.5 格，尽量贴到水边 1 格内（带超时防卡死）
    const pfBot = ensurePathfinder(bot)
    const waterCenter = new Vec3(water.position.x + 0.5, water.position.y, water.position.z + 0.5)
    if (bot.entity.position.distanceTo(waterCenter) > 1.5) {
      try {
        const gotoP = pfBot.pathfinder.goto(new goals.GoalNear(waterCenter.x, waterCenter.y, waterCenter.z, 1))
        gotoP.catch(() => { /* 吞掉后续路径停止错误 */ })
        await Promise.race([
          gotoP,
          new Promise((_, reject) => setTimeout(() => reject(new Error('寻路超时')), 8_000))
        ])
        await sleep(200)
      } catch {
        // 不调 pathfinder.stop()，避免停止标记导致后续 goto 连环 PathStopped
      }
    }

    // 5. 点"暴露的面"（优先顶面，像真人舀水），并校验距离
    const faceVec = findExposedFace(bot, water.position, bot.entity.position)
    const clickPoint = water.position.offset(
      0.5 + faceVec.x * 0.5,
      0.5 + faceVec.y * 0.5,
      0.5 + faceVec.z * 0.5
    )
    const reach = bot.entity.position.distanceTo(clickPoint)
    if (reach > 4.5) {
      debug(`[Water] 距离水 ${reach.toFixed(1)} 格太远，放弃`)
      return { success: false, code: 'too_far', data: { distance: reach.toFixed(1) } }
    }
    debug(`[Water] 点击面=${faceVec}, 上方=${bot.blockAt(water.position.offset(0, 1, 0))?.name ?? '无'}, 距离=${reach.toFixed(2)}格, 手持=${bot.heldItem?.name ?? '空'}`)

    // 6. 右键。1.21.9+ 交互机制改为"use_item + 朝向射线"，先看准水再按"右键"。
    await lookAtSmart(bot, clickPoint)
    await sleep(100)
    let after: string | undefined

    // 方式A：use_item（带玩家朝向 rotation，新版服务器靠它判定目标水）
    if (typeof bot.activateItem === 'function') {
      try {
        bot.activateItem()
        debug('[Water] 已发送 use_item (方式A)')
      } catch (err) {
        debug('[Water] use_item 异常:', (err as Error).message)
      }
      await sleep(600)
      after = bot.heldItem?.name
      const filledA = target === 'bucket' ? after === 'water_bucket' : after === 'potion'
      if (filledA) {
        debug(`[Water] use_item 装水成功, 手持=${after}`)
        return { success: true, code: target === 'bucket' ? 'bucket' : 'bottle' }
      }
    }

    // 方式B：block_place 直接指向水方块（旧机制兜底）
    const placeBot = bot as GenericPlaceBot
    if (typeof placeBot._genericPlace === 'function') {
      try {
        await placeBot._genericPlace(water, faceVec, { swingArm: 'right' })
        debug('[Water] 已发送 block_place (方式B)')
      } catch (err) {
        debug('[Water] block_place 异常:', (err as Error).message)
      }
      await sleep(700)
      after = bot.heldItem?.name
      const filledB = target === 'bucket' ? after === 'water_bucket' : after === 'potion'
      if (filledB) {
        debug(`[Water] block_place 装水成功, 手持=${after}`)
        return { success: true, code: target === 'bucket' ? 'bucket' : 'bottle' }
      }
    }

    debug(`[Water] 两种方式均未装上, 手持=${after ?? '空'}`)
    return {
      success: false,
      code: 'not_filled',
      data: { item: after || '空', version: bot.version, distance: reach.toFixed(1) }
    }
  }

  private parseCountAndInterval(input: string): { countStr: string; interval: number; intervalText: string } | null {
    let str = input.trim()
    let interval = 4
    let intervalText = '0.2s'

    const intervalMatch = str.match(/间隔\s*((?:\d+(?:\.\d+)?(?:h|m|s|小时|分钟|秒))+)/i)
    if (intervalMatch) {
      const sec = this.parseIntervalSeconds(intervalMatch[1])
      if (sec == null || sec <= 0) return null
      interval = Math.round(sec * 20)
      intervalText = intervalMatch[1].toLowerCase()
      str = str.replace(intervalMatch[0], '').trim()
    }

    if (!str) return null
    return { countStr: str, interval, intervalText }
  }

  /** 解析组合时长：1h30m、90m、20s，也支持 小时/分钟/秒。 */
  private parseIntervalSeconds (input: string): number | null {
    const units: Record<string, number> = { h: 3600, m: 60, s: 1, 小时: 3600, 分钟: 60, 秒: 1 }
    const pattern = /(\d+(?:\.\d+)?)(小时|分钟|秒|h|m|s)/gi
    let total = 0
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(input)) !== null) {
      if (match.index !== cursor) return null
      total += Number(match[1]) * units[match[2].toLowerCase()]
      cursor = pattern.lastIndex
    }
    return cursor === input.length && total > 0 ? total : null
  }

  private startLoop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    // interval is already expressed in game ticks. The old loop waited this
    // full duration and then counted the same number of ticks again, so
    // "间隔20s" actually fired after roughly 8,000 seconds.
    const ms = Math.max(50, this.interval * 50)
    const generation = ++this.loopGeneration
    this.intervalHandle = setInterval(() => { void this.runScheduledAction(generation) }, ms)
  }

  private async runScheduledAction (generation: number): Promise<void> {
    if (!this.active || generation !== this.loopGeneration || this.actionInProgress) return
    this.actionInProgress = true
    try {
      const confirmed = await this.doAction()
      if (!this.active || generation !== this.loopGeneration) return
      if (!confirmed) {
        debug('[UseItem] 未检测到物品使用成功')
        // Finite commands must not turn one requested use into endless retries.
        // Infinite mode intentionally keeps retrying at the configured interval.
        if (!this.infinite) {
          const onFailed = this.isPlace ? null : this.useFailedCallback
          this.clear()
          onFailed?.()
        }
        return
      }
      if (!this.infinite) {
        this.count--
        if (this.count <= 0) {
          const onComplete = this.isPlace ? null : this.useCompleteCallback
          this.clear()
          onComplete?.()
        }
      }
    } finally {
      this.actionInProgress = false
    }
  }

  private clear(): void {
    this.loopGeneration++
    this.useCompleteCallback = null
    this.useFailedCallback = null
    if (!this.isPlace) {
      try { this.mcBot.bot?.deactivateItem() } catch { /* Best-effort release of a held right-click. */ }
    }
    this.active = false
    this.infinite = false
    this.isPlace = false
    this.count = 0
    this.timer = 0
    this.placeTargetName = null
    this.relTarget = null
    this.relDir = null
    this.placeCalibrated = null
    this.placeSweepIdx = 0
    if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null }
    this.notifyBreakChange()
  }

  /** 短等待某位置出现 blockUpdate（确认放置生效），超时返回 false；超时/触发都正确移除监听器防泄漏 */
  private waitForBlockUpdate (bot: Bot, pos: Vec3, ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const key = `blockUpdate:${pos}`
      const b = bot as unknown as {
        on: (e: string, f: () => void) => void
        off: (e: string, f: () => void) => void
      }
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        b.off(key, handler)
        clearTimeout(timer)
        resolve(ok)
      }
      const handler = (): void => finish(true)
      const timer = setTimeout(() => finish(false), ms)
      b.on(key, handler)
    })
  }

  /** 生成候选角度列表（围绕朝向底面中心） */
  private sweepCandidates (bot: Bot, target: Vec3): Array<{ yaw: number; pitch: number }> {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const delta = target.offset(0.5, 0, 0.5).minus(eye)
    const aimYaw = Math.atan2(-delta.x, -delta.z) * 180 / Math.PI
    const g = Math.hypot(delta.x, delta.z)
    const aimPitch = -Math.atan2(delta.y, g) * 180 / Math.PI
    const list: Array<{ yaw: number; pitch: number }> = []
    for (const dy of [-14, -8, -4, -2, 0, 2, 4, 8, 14]) {
      for (const dp of [-30, -20, -14, -9, -5, -2, 0, 4, 9, 15]) {
        list.push({ yaw: aimYaw + dy, pitch: aimPitch + dp })
      }
    }
    return list
  }

  /**
   * bot 骑乘时 bot.entity.position 不更新（服务端位置由载具控制）。
   * 取实际位置：优先 bot.entity.vehicle，其次找"载着 bot 的实体"（passengers 含 bot）。
   * 若多辆都载着 bot，按位置连续性取离上一帧实际位置最近的那辆（机器平滑移动，不会选错）。
   */
  private lastActualPos: Vec3 | null = null

  private currentPos (bot: Bot): Vec3 {
    const v = getVehicle(bot) ?? getEntityVehicle(bot)
    if (v?.position) {
      this.lastActualPos = v.position
      return v.position
    }

    const candidates: Vec3[] = []
    const botId = bot.entity.id
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id] as { position?: Vec3; passengers?: Array<{ id?: number; username?: string }> }
      if (e.position && e.passengers && e.passengers.some(p => p.id === botId || p.username === bot.username)) {
        candidates.push(e.position)
      }
    }
    if (candidates.length > 0) {
      let best = candidates[0]
      if (this.lastActualPos) {
        let bestD = Infinity
        for (const c of candidates) {
          const d = this.lastActualPos.distanceTo(c)
          if (d < bestD) { bestD = d; best = c }
        }
      }
      this.lastActualPos = best
      return best
    }

    let nearest: Vec3 | null = null
    let min = Infinity
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id]
      if (e && e.position && isRideableEntity(e)) {
        const d = bot.entity.position.distanceTo(e.position)
        if (d < min) { min = d; nearest = e.position }
      }
    }
    const result = nearest ?? bot.entity.position
    this.lastActualPos = result
    return result
  }

  /**
   * 追踪放置：锁定第一块楼梯，真实放置扫描角度（每次机器推进换一个角度），
   * 校准出能出"朝下活塞"的角度后锁定复用。
   */
  private async placeTracked (bot: Bot): Promise<void> {
    const name = this.placeTargetName
    if (!name) return
    const searchPoint = this.currentPos(bot)
    // 锁定第一块（最近的）石砖楼梯，搜索半径与放置距离限制一致
    const target = bot.findBlock({
      matching: (b: { name: string }) => b.name === name,
      maxDistance: 10,
      point: searchPoint
    })
    if (!target) {
      console.warn(`[UseItem] 附近 10 格内没找到 ${cnName(name)}`)
      return
    }
    // 放置距离限制：10 格（kades 若支持更长交互距离）
    const reach = 10
    const dist = searchPoint.distanceTo(target.position)
    if (dist > reach) {
      return
    }
    const down = new Vec3(0, -1, 0)
    const dest = target.position.plus(down)
    // 下方为空才放，避免机器自身已放活塞时重复放置导致故障
    if (!isAirBlock(bot.blockAt(dest))) {
      return
    }

    // 选择本次角度：已校准则用锁定的，否则按游标取下一个候选
    let angle: { yaw: number; pitch: number }
    if (this.placeCalibrated) {
      angle = this.placeCalibrated
    } else {
      const candidates = this.sweepCandidates(bot, target.position)
      angle = candidates[this.placeSweepIdx % candidates.length]
      this.placeSweepIdx++
    }

    // 瞄准并真正发 look 包（force=false 让物理循环发出去；骑乘时直写）
    const tp = lookAnglesSmart(bot, angle.yaw, angle.pitch)
    await lookAtSmart(bot, tp, false)
    await sleep(60)
    // forceLook:'ignore' 保留扫描角度，避免 placeBlock 内部重新瞄向底面中心覆盖掉
    let confirmed = false
    const gpb = bot as GenericPlaceBot
    if (typeof gpb._genericPlace === 'function') {
      await gpb._genericPlace(target, down, { forceLook: 'ignore', swingArm: 'right' })
      confirmed = await this.waitForBlockUpdate(bot, dest, 800)
    } else {
      try {
        await Promise.race([
          bot.placeBlock(target, down),
          new Promise((_, reject) => setTimeout(() => reject(new Error('确认超时')), 800))
        ])
        confirmed = true
      } catch { /* 未确认 */ }
    }
    await sleep(120)
    const placed = bot.blockAt(dest)
    const facing = placed && typeof placed.getProperties === 'function' ? placed.getProperties().facing : undefined
    if (confirmed && placed && placed.name === 'piston' && facing === 'down') {
      // 校准成功：锁定该角度
      if (!this.placeCalibrated) {
        this.placeCalibrated = angle
        debug(`[UseItem] 已校准锁定朝下角度 横${angle.yaw.toFixed(1)}° 纵${angle.pitch.toFixed(1)}°`)
      }
    }
  }

  /** 按模式分发放置：追踪（破基岩）或相对（放置 <方向>） */
  private async placeOnce (bot: Bot): Promise<void> {
    if (this.placeTargetName) {
      await this.placeTracked(bot)
      return
    }
    if (this.relTarget && this.relDir) {
      await this.placeRelative(bot)
    }
  }

  /** 相对放置：在选定参照方块（当前看向）的指定方向相邻格放方块 */
  private async placeRelative (bot: Bot): Promise<void> {
    if (!this.relTarget || !this.relDir) return
    const target = bot.blockAt(this.relTarget)
    if (!target) return
    const dest = this.relTarget.plus(this.relDir)
    // 目标位置已有方块则跳过（避免重复放置顶掉已有方块）
    if (!isAirBlock(bot.blockAt(dest))) return
    const gpb = bot as unknown as GenericPlaceBot
    if (typeof gpb._genericPlace === 'function') {
      await gpb._genericPlace(target, this.relDir, { forceLook: 'ignore', swingArm: 'right' })
    } else {
      await bot.placeBlock(target, this.relDir)
    }
  }

  /**
   * bot → 选定方块的水平量化轴向（前后左右的基准，指向方块）。
   * 取水平分量最大的轴并取整到 ±X/±Z；bot 在方块正上/正下方（水平距离≈0）时返回 null。
   */
  private horizAxis (bot: Bot, targetPos: Vec3): Vec3 | null {
    const toTarget = targetPos.offset(0.5, 0, 0.5).minus(this.currentPos(bot))
    const ax = Math.abs(toTarget.x)
    const az = Math.abs(toTarget.z)
    if (Math.max(ax, az) < 0.3) return null
    if (ax > az) return new Vec3(Math.sign(toTarget.x), 0, 0)
    return new Vec3(0, 0, Math.sign(toTarget.z))
  }

  /** 用 bot 当前朝向做射线，返回视线命中的方块（look/看向 选定的参照方块） */
  private currentLookBlock (bot: Bot): { position: Vec3; name: string } | null {
    const csPitch = Math.cos(bot.entity.pitch)
    const eye = this.currentPos(bot).offset(0, eyeHeightOf(bot), 0)
    const dir = new Vec3(
      -Math.sin(bot.entity.yaw) * csPitch,
      Math.sin(bot.entity.pitch),
      -Math.cos(bot.entity.yaw) * csPitch
    )
    return bot.world.raycast(eye, dir, 10) as { position: Vec3; name: string } | null
  }

  private async doAction(): Promise<boolean> {
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady) return false
    try {
      // 持续使用/放置期间续高位视距保持（15s 窗口），循环不断视距不掉；停止后自动回落
      this.mcBot.requestHighView()
      if (this.isPlace) {
        await this.placeOnce(bot)
        return true
      } else {
        return await this.useHeldItemAndConfirm(bot)
      }
    } catch {
      return false
    }
  }

  /**
   * 只把服务器已同步的物品变化认作一次使用成功。这样满食物、冷却中或
   * 服务器拒绝交互时不会消耗命令次数。
   */
  private async useHeldItemAndConfirm (bot: Bot): Promise<boolean> {
    const before = bot.heldItem
    if (!before) return false
    const beforeFingerprint = this.itemFingerprint(before)
    const beforeTotal = bot.inventory.items()
      .filter(item => item.name === before.name)
      .reduce((total, item) => total + item.count, 0)

    bot.activateItem()
    try {
      const deadline = Date.now() + 2_500 // 食物、药水等需要完整使用动画后才会扣除
      while (Date.now() < deadline) {
        await sleep(100)
        const after = bot.heldItem
        const afterTotal = bot.inventory.items()
          .filter(item => item.name === before.name)
          .reduce((total, item) => total + item.count, 0)
        if (afterTotal < beforeTotal || this.itemFingerprint(after) !== beforeFingerprint) return true
      }
      return false
    } finally {
      // Do not leave bows, food, or other hold-to-use items in a pressed state.
      try { bot.deactivateItem() } catch { /* */ }
    }
  }

  private itemFingerprint (item: Bot['heldItem']): string {
    if (!item) return 'empty'
    const componentItem = item as typeof item & { componentMap?: Map<unknown, unknown> }
    let extra = ''
    try {
      extra = JSON.stringify({ nbt: item.nbt, components: componentItem.componentMap ? [...componentItem.componentMap] : null })
    } catch { /* An unstringifiable component is still covered by name/count/durability. */ }
    return [item.name, item.count, item.metadata, item.durabilityUsed, extra].join('|')
  }
}
