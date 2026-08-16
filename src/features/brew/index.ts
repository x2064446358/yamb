import { Vec3 } from 'vec3'
import type { Entity } from 'prismarine-entity'
import type { DatabaseSync } from 'node:sqlite'
import type { AgingWoodType, BrewConfig, BrewRecipe, ServiceResult } from '../../types'
import { AGING_WOOD_ZH } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type UseItemModule from '../useitem'
import type ContainerRegistry from '../container/registry'
import type { ContainerRecord } from '../container/registry'
import type InventoryActions from '../../actions/inventory'
import { findExactMatchingItems, normalizeItemKey } from '../../actions/inventory'
import { sleep } from '../../platform/sleep'
import { loadBrewRecipes } from '../../config/loader'
import { approachEntity, ensurePathfinder, entityLookPoint, lookAtSmart } from '../../actions/shared/entity-utils'
import { getAgingWoodType } from './block-node-utils'
import { debug, warn } from '../../platform/logger'

/** 一个游戏日按 20 分钟现实时间计时 */
const AGING_MS_PER_DAY = 20 * 60 * 1000
const AGING_REMIND_10_MS = 10 * 60 * 1000
const AGING_REMIND_5_MS = 5 * 60 * 1000
const AGING_TICK_MS = 15_000
/** 自动挤奶搜索半径 */
const MILK_SEARCH_DISTANCE = 12
/** 陈化酒桶允许的接近距离（酒桶可能离酿酒区较远） */
const AGING_BARREL_APPROACH = 30
/** 酿酒各节点/容器允许的接近距离（原料箱/炼药锅/工具箱等可能较分散） */
const BREW_APPROACH = 30

interface AgingTask {
  id: string
  recipeId: string
  owner: string
  barrel: ContainerRecord
  finishAt: number
  reminded10: boolean
  reminded5: boolean
  pendingAwayNotified: boolean
  phase: 'aging' | 'pending-collect'
  collecting: boolean
}

function formatRemaining (finishAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.ceil((finishAt - now) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`
}

function woodLabel (wood: AgingWoodType): string {
  const zh = Object.keys(AGING_WOOD_ZH).find(key => AGING_WOOD_ZH[key] === wood)
  return zh ?? wood
}

export default class BrewModule {
  private readonly mcBot: MinecraftBot
  private readonly config: BrewConfig
  private readonly containerRegistry: ContainerRegistry
  private readonly inventoryActions: InventoryActions
  private readonly useItemModule: UseItemModule
  private readonly interactionDistance: number
  private readonly approachDistance: number
  private readonly db: DatabaseSync
  /** 本 bot 的 BOT_INDEX：酿酒任务按它归属，共享库多 bot 时只有归属 bot 恢复/提醒/收取 */
  private readonly botIndex: number
  private isLockedProvider: () => boolean = () => false
  private lockAgingFn: ((by: string) => void) | null = null
  private unlockAgingFn: (() => void) | null = null
  private agingLockStillMine: () => boolean = () => true
  private isLockedByAging = false
  /** 是否进入陈化（暂存物品要等陈化完成才取回） */
  private agingDeferred = false
  private cancelRequested = false
  private taskRunning = false
  private report: ((message: string) => Promise<void>) | null = null
  private errors = 0
  private currentOwner: string | null = null
  private phase: string | null = null
  private recipeId: string | null = null
  private finishAt = 0
  private distillationRuns: number | null = null
  private distillationStartedAt = 0
  private readonly agingTasks = new Map<string, AgingTask>()
  private agingTimer: ReturnType<typeof setInterval> | null = null

  constructor (
    mcBot: MinecraftBot,
    config: BrewConfig,
    containerRegistry: ContainerRegistry,
    inventoryActions: InventoryActions,
    useItemModule: UseItemModule,
    interactionDistance: number,
    approachDistance: number,
    db: DatabaseSync,
    botIndex: number
  ) {
    this.mcBot = mcBot
    this.config = config
    this.containerRegistry = containerRegistry
    this.inventoryActions = inventoryActions
    this.useItemModule = useItemModule
    this.interactionDistance = interactionDistance
    this.approachDistance = approachDistance
    this.db = db
    this.botIndex = botIndex
  }

  /** 酿酒期间禁止回家待命/其他命令时使用 */
  setIsLockedProvider (fn: () => boolean): void {
    this.isLockedProvider = fn
  }

  /** 陈化期间锁定 bot（与主酿酒一致）：lock 锁给发起者，unlock 解锁，isMine 判断锁是否还是陈化开的那把 */
  setAgingLockActions (
    lock: (by: string) => void,
    unlock: () => void,
    isMine: () => boolean
  ): void {
    this.lockAgingFn = lock
    this.unlockAgingFn = unlock
    this.agingLockStillMine = isMine
  }

  register (): void {
    if (!this.config.enabled) {
      debug('[Brew] Module disabled')
      return
    }
    debug(`[Brew] Module ready: ${this.config.recipes.length} recipe(s)`)
  }

  getGroup (): string {
    return this.config.group
  }

  isRunning (): boolean {
    return this.taskRunning
  }

  async start (
    recipeId: string,
    report: (message: string) => Promise<void>,
    owner: string
  ): Promise<ServiceResult> {
    if (!this.config.enabled) {
      return { success: false, message: '酿酒模块未启用' }
    }
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!Number.isInteger(this.config.fermenterCount) || this.config.fermenterCount <= 0) {
      return { success: false, message: 'fermenterCount 必须是正整数' }
    }
    if (this.taskRunning) {
      return { success: false, message: '上一酿酒任务仍在停止或清理中' }
    }
    if (this.isLockedProvider()) {
      return { success: false, message: 'bot 当前处于锁定状态' }
    }

    const recipe = this.config.recipes.find(item => item.id === recipeId)
    if (!recipe) {
      return { success: false, message: `配方不存在: ${recipeId}` }
    }

    this.cancelRequested = false
    this.taskRunning = true
    this.errors = 0
    this.report = report
    this.currentOwner = owner
    this.phase = 'checking'
    this.recipeId = recipe.id
    this.finishAt = 0
    void this.runFermentation(recipe)
    return { success: true, message: `已开始发酵 ${recipe.id}` }
  }

  status (): {
    running: boolean
    recipe?: string
    phase?: string
    finishAt?: number
    detail?: string
    aging?: string[]
  } {
    const aging = this.formatAgingStatusLines()
    if (!this.taskRunning) {
      return aging.length > 0
        ? { running: false, aging }
        : { running: false }
    }
    return {
      running: true,
      recipe: this.recipeId ?? undefined,
      phase: this.phase ?? undefined,
      finishAt: this.finishAt || undefined,
      detail: this.formatBrewingStatus(),
      aging
    }
  }

  formatAgingStatusLines (now = Date.now()): string[] {
    return [...this.agingTasks.values()]
      .sort((a, b) => a.finishAt - b.finishAt)
      .map(task => {
        const when = new Date(task.finishAt).toLocaleTimeString()
        if (task.phase === 'pending-collect') {
          return `陈化 ${task.recipeId} @ ${task.barrel.alias} 待收取`
        }
        const remaining = Math.max(0, Math.ceil((task.finishAt - now) / 1000))
        const minutes = Math.floor(remaining / 60)
        const seconds = remaining % 60
        const left = minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`
        return `陈化 ${task.recipeId} @ ${task.barrel.alias} 剩余 ${left} (~${when})`
      })
  }

  private formatBrewingStatus (): string {
    if (
      this.phase === 'distillery-loading' ||
      this.phase === 'distilling' ||
      this.phase === 'distillery-unloading'
    ) {
      const total = this.distillationRuns ?? 0
      if (total > 0) {
        const completed = this.phase === 'distillery-loading'
          ? 0
          : this.phase === 'distillery-unloading'
            ? total
            : Math.min(
                total,
                Math.max(0, Math.floor((Date.now() - this.distillationStartedAt) / 45000))
              )
        return `蒸馏 ${completed}/${total} 次`
      }
    }

    if (
      this.phase === 'fermenting' ||
      this.phase === 'waiting' ||
      this.phase === 'bottling'
    ) {
      return `发酵中 剩余 ${formatRemaining(this.finishAt)}`
    }

    return '酿酒中'
  }

  reloadRecipes (): ServiceResult & { count?: number } {
    const recipes = loadBrewRecipes()
    if (recipes.length === 0) {
      return {
        success: false,
        message: '未加载到有效配方，已保留当前配方'
      }
    }
    this.config.recipes = recipes
    debug(`[Brew] Reloaded ${recipes.length} recipe(s)`)
    return {
      success: true,
      count: recipes.length,
      message: `已重新加载 ${recipes.length} 个酿酒配方`
    }
  }

  cancel (): boolean {
    if (!this.taskRunning) return false
    this.cancelRequested = true
    return true
  }

  async stop (): Promise<boolean> {
    if (!this.taskRunning) return false
    this.cancelRequested = true
    const bot = this.mcBot.bot
    if (bot) {
      try { ensurePathfinder(bot).pathfinder.stop() } catch { /* ignore */ }
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
      try { bot.deactivateItem() } catch { /* ignore */ }
      bot.clearControlStates()
    }
    return true
  }

  dispose (): void {
    if (this.agingTimer) {
      clearInterval(this.agingTimer)
      this.agingTimer = null
    }
  }

  // ===== 酿酒任务持久化（掉线重连恢复） =====

  private saveAgingTask (task: AgingTask): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO brew_tasks
        (id, kind, recipe_id, owner, barrel_alias, barrel_x, barrel_y, barrel_z, barrel_dim, finish_at, phase, reminded_10, reminded_5, pending_away, bot_index)
        VALUES (?, 'aging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.recipeId,
        task.owner,
        task.barrel.alias,
        task.barrel.x,
        task.barrel.y,
        task.barrel.z,
        task.barrel.dimension,
        task.finishAt,
        task.phase,
        task.reminded10 ? 1 : 0,
        task.reminded5 ? 1 : 0,
        task.pendingAwayNotified ? 1 : 0,
        this.botIndex
      )
    } catch { /* 持久化失败不阻断流程 */ }
  }

  private deleteAgingTask (id: string): void {
    try {
      this.db.prepare("DELETE FROM brew_tasks WHERE id = ? AND kind = 'aging' AND bot_index = ?").run(id, this.botIndex)
    } catch { /* ignore */ }
  }

  private saveFermentTask (recipeId: string, finishAt: number): void {
    try {
      this.db.prepare("DELETE FROM brew_tasks WHERE kind = 'ferment' AND bot_index = ?").run(this.botIndex)
      this.db.prepare(`
        INSERT OR REPLACE INTO brew_tasks (id, kind, recipe_id, owner, finish_at, bot_index)
        VALUES ('ferment', 'ferment', ?, ?, ?, ?)
      `).run(recipeId, this.currentOwner || 'unknown', finishAt, this.botIndex)
    } catch { /* 持久化失败不阻断流程 */ }
  }

  private clearFermentTask (): void {
    try {
      this.db.prepare("DELETE FROM brew_tasks WHERE kind = 'ferment' AND bot_index = ?").run(this.botIndex)
    } catch { /* ignore */ }
  }

  /** 掉线重连后恢复：陈化任务直接恢复，发酵中的任务续跑（等待发酵完成→装瓶→蒸馏→入库） */
  async restorePersisted (): Promise<void> {
    if (this.taskRunning) return
    let rows: Array<Record<string, unknown>>
    try {
      rows = this.db.prepare('SELECT * FROM brew_tasks').all() as Array<Record<string, unknown>>
    } catch {
      return
    }

    // 共享库多 bot 共享：任务必须归属创建它的 bot，只有归属 bot 才恢复/提醒/收取。
    // 旧数据 bot_index 为 NULL，用单条原子 UPDATE 认领——同时只有一方 changes>0，杜绝多个 bot 接管同一任务。
    const adoptOrSkip = (row: Record<string, unknown>): boolean => {
      const id = String(row.id ?? '')
      if (row.bot_index == null) {
        const result = this.db.prepare(
          'UPDATE brew_tasks SET bot_index = ? WHERE id = ? AND bot_index IS NULL'
        ).run(this.botIndex, id)
        return (result.changes ?? 0) > 0
      }
      return Number(row.bot_index) === this.botIndex
    }

    const fermentRow = rows.find(r => r.kind === 'ferment' && adoptOrSkip(r))
    if (fermentRow) {
      const recipeId = String(fermentRow.recipe_id ?? '')
      const owner = String(fermentRow.owner ?? 'unknown')
      const finishAt = Number(fermentRow.finish_at)
      const recipe = this.config.recipes.find(item => item.id === recipeId)
      if (recipe && Number.isFinite(finishAt)) {
        this.taskRunning = true
        void this.resumeFermentation(recipe, finishAt, owner)
      } else {
        this.clearFermentTask()
      }
    }

    for (const row of rows) {
      if (row.kind !== 'aging') continue
      if (!adoptOrSkip(row)) continue
      const alias = String(row.barrel_alias ?? '')
      const barrel = this.containerRegistry.get(alias)
      if (!barrel || barrel.blockType !== 'Aging') {
        this.deleteAgingTask(String(row.id))
        continue
      }
      const task: AgingTask = {
        id: String(row.id),
        recipeId: String(row.recipe_id ?? ''),
        owner: String(row.owner ?? 'unknown'),
        barrel,
        finishAt: Number(row.finish_at),
        reminded10: Number(row.reminded_10) === 1,
        reminded5: Number(row.reminded_5) === 1,
        pendingAwayNotified: Number(row.pending_away) === 1,
        phase: row.phase === 'pending-collect' ? 'pending-collect' : 'aging',
        collecting: false
      }
      if (!Number.isFinite(task.finishAt)) {
        this.deleteAgingTask(task.id)
        continue
      }
      this.agingTasks.set(task.id, task)
    }
    if (this.agingTasks.size > 0) {
      this.ensureAgingTimer()
      debug(`[Brew] 恢复 ${this.agingTasks.size} 个陈化任务`)
    }
  }

  /** 掉线恢复：等发酵完成→装瓶→蒸馏→陈化/入库 */
  private async resumeFermentation (recipe: BrewRecipe, finishAt: number, owner: string): Promise<void> {
    this.currentOwner = owner
    this.recipeId = recipe.id
    this.agingDeferred = false
    try {
      const remainingSeconds = Math.max(0, Math.ceil((finishAt - Date.now()) / 1000))
      await this.whisperOwner(`掉线后恢复酿酒 ${recipe.id}，剩余发酵时间约 ${remainingSeconds} 秒`)

      while (Date.now() < finishAt) {
        this.assertNotCancelled()
        await sleep(Math.min(1000, finishAt - Date.now()))
      }
      this.assertNotCancelled()

      const fermenters = this.resolveFermenters()
      const bottles = this.requireBottleContainer()
      const bottleId = bottles.itemId!
      const need = fermenters.length * 3
      await this.ensureBottlesForResume(bottleId, need)

      this.phase = 'bottling'
      for (const fermenter of fermenters) {
        this.assertNotCancelled()
        for (let i = 0; i < 3; i++) {
          await this.attempt(`${fermenter.alias} 装瓶 (${i + 1}/3)`, async () => {
            await this.interactWithItem(fermenter, 'minecraft:glass_bottle')
          })
        }
      }

      if (recipe.distillation) {
        await this.distillProducts(recipe)
      }

      if (recipe.aging) {
        await this.beginAging(recipe)
      } else {
        this.phase = 'storing'
        this.recipeId = recipe.id
        await this.storeAllPotions()
        await this.whisperOwner(`酿酒 ${recipe.id} 已完成（掉线恢复）`)
      }
    } catch (err) {
      const cancelled = err instanceof BrewCancelledError
      const message = cancelled
        ? '酿酒任务已取消'
        : `酿酒任务停止: ${(err as Error).message}`
      warn(`[Brew] ${message}`)
      await this.whisperOwner(message)
    } finally {
      this.currentOwner = null
      this.phase = null
      this.recipeId = null
      this.finishAt = 0
      this.taskRunning = false
      this.clearFermentTask()
      // 进入陈化的配方：暂存物品等陈化完成、产物入库后再取回
      if (!this.agingDeferred) await this.restoreStagedInventory()
    }
  }

  private async ensureBottlesForResume (bottleId: string, need: number): Promise<void> {
    if (this.inventoryCount(bottleId) >= need) return
    const bottles = this.requireBottleContainer()
    const result = await this.inventoryActions.takeExactFromContainer(
      bottles.x,
      bottles.y,
      bottles.z,
      bottleId,
      need - this.inventoryCount(bottleId),
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!result.success) throw new Error(result.message || '拿取玻璃瓶失败')
  }

  private async whisperOwner (message: string): Promise<void> {
    debug(`[Brew] ${message}`)
    if (!this.currentOwner) return
    try {
      this.mcBot.whisper(this.currentOwner, message)
    } catch (err) {
      warn('[Brew] 私聊失败:', (err as Error).message)
    }
  }

  // ===== 背包暂存（开酿前清空，酿完拿回） =====

  private stagingAlias (): string {
    return this.config.stagingContainer.trim()
  }

  /** 开酿前：把背包所有物品存入暂存箱 */
  private async stageInventory (): Promise<void> {
    const alias = this.stagingAlias()
    if (!alias) return
    const bot = this.mcBot.bot
    if (!bot || bot.inventory.items().length === 0) return

    const node = this.requireNode(alias, 'Container', true)
    await this.attempt(`暂存背包物品到 ${alias}`, async () => {
      const result = await this.inventoryActions.storeFilteredInContainer(
        node.x,
        node.y,
        node.z,
        () => true,
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '暂存失败')
    })

    // 关窗后背包状态可能未同步完，稍等再复查，避免误判"背包还有物品"
    await sleep(400)
    const remaining = bot.inventory.items().length
    if (remaining > 0) {
      await sleep(500)
      const remaining2 = bot.inventory.items().length
      if (remaining2 > 0) {
        throw new Error(`暂存箱 ${alias} 空间不足，背包剩余 ${remaining2} 格物品`)
      }
    }
    await this.reportSafe(`背包物品已暂存到 ${alias}，开始酿酒`)
  }

  /** 酿完后：把暂存箱物品全部取回背包 */
  private async restoreStagedInventory (): Promise<void> {
    const alias = this.stagingAlias()
    if (!alias) return
    try {
      const node = this.requireNode(alias, 'Container', true)
      await this.attempt(`从暂存箱 ${alias} 取回物品`, async () => {
        const result = await this.inventoryActions.withdrawAllFromContainer(
          node.x,
          node.y,
          node.z,
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success) throw new Error(result.message || '取回失败')
      })
    } catch { /* 取回失败不影响主流程 */ }
  }

  private async runFermentation (recipe: BrewRecipe): Promise<void> {
    let hasCollectedProducts = false
    this.agingDeferred = false
    try {
      // 开酿前清空背包到暂存箱，酿完取回
      await this.stageInventory()
      const fermenters = this.resolveFermenters()
      await this.ensureFermentersFull(fermenters)
      this.assertNotCancelled()

      const ingredients = await this.checkSupplies(recipe)
      await this.takeSupplies(ingredients, fermenters.length)
      this.assertNotCancelled()

      let finishAt = 0
      const startedAtByFermenter = await this.addIngredients(fermenters, ingredients, lastStartedAt => {
        finishAt = lastStartedAt + recipe.fermentation.durationSeconds * 1000
        this.phase = 'fermenting'
        this.recipeId = recipe.id
        this.finishAt = finishAt
      })
      await this.returnBuckets()
      // 发酵开始后持久化，掉线重连可续跑
      this.saveFermentTask(recipe.id, finishAt)

      // 状态倒计时固定以最后一锅（最晚完成）为准。
      this.phase = 'waiting'
      this.recipeId = recipe.id
      this.finishAt = finishAt
      const remainingSeconds = Math.max(0, Math.ceil((finishAt - Date.now()) / 1000))
      await this.reportSafe(`原料投入完成，最后一锅剩余发酵时间约 ${remainingSeconds} 秒`)
      await this.bottleProductsWhenReady(
        fermenters,
        startedAtByFermenter,
        recipe.fermentation.durationSeconds,
        recipe.id,
        () => { hasCollectedProducts = true }
      )

      if (recipe.distillation) {
        await this.distillProducts(recipe)
      }

      if (recipe.aging) {
        await this.beginAging(recipe)
      } else {
        this.phase = 'storing'
        this.recipeId = recipe.id
        this.finishAt = finishAt
        await this.storeAllPotions()
        await this.reportSafe(
          this.errors > 0
            ? `酿酒 ${recipe.id} 已完成，但发生 ${this.errors} 个错误`
            : `酿酒 ${recipe.id} 已完成`
        )
      }
    } catch (err) {
      const cancelled = err instanceof BrewCancelledError
      const message = cancelled
        ? '酿酒任务已取消'
        : `酿酒任务停止: ${(err as Error).message}`
      warn(`[Brew] ${message}`)
      await this.reportSafe(message)
      if (!cancelled && hasCollectedProducts) {
        await this.reportSafe('检测到异常中止，尝试将背包中的半成品存入产物箱')
        try {
          await this.storeAllPotions()
        } catch (storeError) {
          const storeMessage = `异常回收失败: ${(storeError as Error).message}`
          warn(`[Brew] ${storeMessage}`)
          await this.reportSafe(storeMessage)
        }
      }
    } finally {
      this.report = null
      this.currentOwner = null
      this.cancelRequested = false
      this.phase = null
      this.recipeId = null
      this.finishAt = 0
      this.taskRunning = false
      this.clearFermentTask()
      // 进入陈化的配方：暂存物品等陈化完成、产物入库后再取回
      if (!this.agingDeferred) await this.restoreStagedInventory()
    }
  }

  private currentDimension (): string {
    const raw = this.mcBot.bot?.game?.dimension
    if (raw == null) return 'overworld'
    return String(raw).replace(/^minecraft:/, '')
  }

  private sameDimension (dimension: string): boolean {
    return String(dimension).replace(/^minecraft:/, '') === this.currentDimension()
  }

  private resolveFermenters (): ContainerRecord[] {
    const fermenters = this.containerRegistry.list(this.config.group)
      .filter(node => node.blockType === 'Fermenter' && this.sameDimension(node.dimension))

    if (fermenters.length < this.config.fermenterCount) {
      throw new Error(
        `区域 ${this.config.group} 的发酵方块不足 ` +
        `(${fermenters.length}/${this.config.fermenterCount})`
      )
    }
    return fermenters.slice(0, this.config.fermenterCount)
  }

  private resolveDistilleries (): ContainerRecord[] {
    const distilleries = this.containerRegistry.list(this.config.group)
      .filter(node => node.blockType === 'Distillery' && this.sameDimension(node.dimension))

    if (distilleries.length < this.config.fermenterCount) {
      throw new Error(
        `区域 ${this.config.group} 的蒸馏方块不足 ` +
        `(${distilleries.length}/${this.config.fermenterCount})`
      )
    }
    return distilleries.slice(0, this.config.fermenterCount)
  }

  private async ensureFermentersFull (fermenters: ContainerRecord[]): Promise<void> {
    const empty: ContainerRecord[] = []
    for (const fermenter of fermenters) {
      this.assertNotCancelled()
      const full = await this.attempt(
        `检查炼药锅 ${fermenter.alias}`,
        async () => this.isFermenterFull(fermenter)
      )
      if (full !== true) empty.push(fermenter)
    }

    switch (this.config.waterMode) {
      case 'source':
        await this.fillFromWaterSource(empty)
        break
      case 'preloaded':
        break
      case 'bucket-stock':
        await this.fillFromBucketStock(empty)
        break
      default:
        throw new Error(`未知加水模式: ${String(this.config.waterMode)}`)
    }

    await this.verifyAllFermentersFull(fermenters)
  }

  private async fillFromWaterSource (empty: ContainerRecord[]): Promise<void> {
    if (empty.length === 0) return
    const setup = await this.attempt('准备加水工具', async () => {
      const toolbox = this.requireNode(this.config.toolbox, 'Container', true)
      await this.ensureOneBucket(toolbox)
      return true
    })
    if (!setup) return

    for (const fermenter of empty) {
      this.assertNotCancelled()
      await this.attempt(`为 ${fermenter.alias} 加水`, async () => {
        await this.ensureWaterBucket()
        await this.interactWithItem(fermenter, 'minecraft:water_bucket')
        // 水桶已由服务端转换为空桶即可确认交互成功。
        // 方块状态包可能比背包包更晚到达，不能立即用缓存判定未满。
      })
    }
    await this.returnBuckets()
  }

  private async fillFromBucketStock (empty: ContainerRecord[]): Promise<void> {
    if (empty.length === 0) return

    const waterBuckets = this.requireDedicatedContainer(
      this.config.waterBucketContainer,
      'water_bucket'
    )
    const emptyBuckets = this.requireDedicatedContainer(
      this.config.emptyBucketContainer,
      'bucket'
    )
    // bucket-stock 按整批炼药锅数量领取；未使用的水桶稍后归还。
    const batchBucketCount = this.config.fermenterCount
    await this.assertContainerAmount(waterBuckets, waterBuckets.itemId!, batchBucketCount)

    await this.attempt('领取预装水桶', async () => {
      const result = await this.inventoryActions.takeExactFromContainer(
        waterBuckets.x,
        waterBuckets.y,
        waterBuckets.z,
        waterBuckets.itemId!,
        batchBucketCount,
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '领取预装水桶失败')
    })

    for (const fermenter of empty) {
      this.assertNotCancelled()
      await this.attempt(`为 ${fermenter.alias} 加水`, async () => {
        await this.interactWithItem(fermenter, 'minecraft:water_bucket')
      })
    }

    await this.attempt('存放空桶', async () => {
      const result = await this.inventoryActions.storeFilteredInContainer(
        emptyBuckets.x,
        emptyBuckets.y,
        emptyBuckets.z,
        item => normalizeItemKey(item.name) === 'bucket',
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '存放空桶失败')
    })

    // 若某锅倒水失败，将尚未使用的水桶归还原容器。
    await this.attempt('归还未使用水桶', async () => {
      const result = await this.inventoryActions.storeFilteredInContainer(
        waterBuckets.x,
        waterBuckets.y,
        waterBuckets.z,
        item => normalizeItemKey(item.name) === 'water_bucket',
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '归还水桶失败')
    })
  }

  private async verifyAllFermentersFull (fermenters: ContainerRecord[]): Promise<void> {
    const unfilled: string[] = []
    for (const fermenter of fermenters) {
      this.assertNotCancelled()
      const full = await this.attempt(
        `复查炼药锅 ${fermenter.alias}`,
        async () => this.waitForFermenterFull(fermenter)
      )
      if (full !== true) unfilled.push(fermenter.alias)
    }
    if (unfilled.length > 0) {
      throw new Error(`以下炼药锅未满水: ${unfilled.join(', ')}`)
    }
  }

  private async checkSupplies (
    recipe: BrewRecipe
  ): Promise<Array<{ node: ContainerRecord, itemId: string, perFermenter: number }>> {
    const plans: Array<{ node: ContainerRecord, itemId: string, perFermenter: number }> = []

    for (const ingredient of recipe.fermentation.ingredients) {
      const node = this.requireNode(ingredient.container, 'Container', false)
      if (!node.isDedicated || !node.itemId) {
        throw new Error(`原料容器 ${node.alias} 必须是专用容器`)
      }
      const required = ingredient.count * this.config.fermenterCount

      // 奶桶不足时自动就近找牛挤奶补足
      if (normalizeItemKey(node.itemId) === 'milk_bucket') {
        await this.ensureMilkBuckets(node, required)
      } else {
        await this.assertContainerAmount(node, node.itemId, required)
      }

      plans.push({
        node,
        itemId: node.itemId,
        perFermenter: ingredient.count
      })
    }

    const bottles = this.requireBottleContainer()
    const bottleId = bottles.itemId!
    await this.assertContainerAmount(
      bottles,
      bottleId,
      this.config.fermenterCount * 3
    )
    return plans
  }

  private async takeSupplies (
    ingredients: Array<{ node: ContainerRecord, itemId: string, perFermenter: number }>,
    fermenterCount: number
  ): Promise<void> {
    for (const ingredient of ingredients) {
      this.assertNotCancelled()
      await this.attempt(`拿取 ${ingredient.itemId}`, async () => {
        const result = await this.inventoryActions.takeExactFromContainer(
          ingredient.node.x,
          ingredient.node.y,
          ingredient.node.z,
          ingredient.itemId,
          ingredient.perFermenter * fermenterCount,
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success) throw new Error(result.message || '拿取失败')
      })
    }

    const bottles = this.requireBottleContainer()
    const bottleId = bottles.itemId!
    await this.attempt('拿取玻璃瓶', async () => {
      const result = await this.inventoryActions.takeExactFromContainer(
        bottles.x,
        bottles.y,
        bottles.z,
        bottleId,
        fermenterCount * 3,
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '拿取玻璃瓶失败')
    })
  }

  private async addIngredients (
    fermenters: ContainerRecord[],
    ingredients: Array<{ node: ContainerRecord, itemId: string, perFermenter: number }>,
    onAllFermentersReady: (lastStartedAt: number) => void
  ): Promise<Map<string, number>> {
    const startedAtByFermenter = new Map<string, number>()
    let lastStartedAt = 0

    // 逐锅投完所有原料后再开始该锅计时，避免早投料的锅过早装瓶。
    for (const fermenter of fermenters) {
      let anySucceeded = false
      for (const ingredient of ingredients) {
        for (let i = 0; i < ingredient.perFermenter; i++) {
          this.assertNotCancelled()
          let succeeded = false
          await this.attempt(
            `${fermenter.alias} 投入 ${ingredient.itemId} (${i + 1}/${ingredient.perFermenter})`,
            async () => {
              await this.interactWithItem(fermenter, ingredient.itemId)
              succeeded = true
            }
          )
          if (succeeded) anySucceeded = true
        }
      }

      const startedAt = Date.now()
      if (!anySucceeded) {
        debug(`[Brew] ${fermenter.alias} 未确认成功投料，仍按投料结束时刻计时`)
      }
      startedAtByFermenter.set(fermenter.alias, startedAt)
      lastStartedAt = startedAt
    }

    // 全部锅投完后以最后一锅的计时起点刷新状态，倒计时固定为最后一锅。
    onAllFermentersReady(lastStartedAt || Date.now())
    return startedAtByFermenter
  }

  private async bottleProductsWhenReady (
    fermenters: ContainerRecord[],
    startedAtByFermenter: Map<string, number>,
    durationSeconds: number,
    recipeId: string,
    onProductCollected: () => void
  ): Promise<void> {
    const schedule = fermenters
      .map(fermenter => ({
        fermenter,
        finishAt: (startedAtByFermenter.get(fermenter.alias) ?? Date.now()) +
          durationSeconds * 1000
      }))
      .sort((a, b) => a.finishAt - b.finishAt)

    // 装瓶阶段的倒计时同样固定为最后一锅（最晚完成）的时间。
    const lastFinishAt = schedule.reduce((max, entry) => Math.max(max, entry.finishAt), 0)

    for (const entry of schedule) {
      this.phase = 'waiting'
      this.recipeId = recipeId
      this.finishAt = lastFinishAt
      await this.waitUntil(entry.finishAt)
      this.phase = 'bottling'
      this.recipeId = recipeId
      this.finishAt = lastFinishAt

      for (let i = 0; i < 3; i++) {
        this.assertNotCancelled()
        let succeeded = false
        await this.attempt(
          `${entry.fermenter.alias} 装瓶 (${i + 1}/3)`,
          async () => {
            await this.interactWithItem(entry.fermenter, 'minecraft:glass_bottle')
            succeeded = true
          }
        )
        if (succeeded) onProductCollected()
      }
    }
  }

  private async distillProducts (recipe: BrewRecipe): Promise<void> {
    const runs = recipe.distillation?.runs
    if (!runs) return

    const distilleries = this.resolveDistilleries()
    const required = distilleries.length * 3
    const available = this.inventoryPotionCount()
    if (available < required) {
      throw new Error(`发酵产物不足，无法蒸馏 (${available}/${required})`)
    }

    this.phase = 'distillery-loading'
    this.recipeId = recipe.id
    this.finishAt = 0
    this.distillationRuns = runs
    this.distillationStartedAt = 0
    await this.reportSafe(`开始装载 ${distilleries.length} 个蒸馏方块`)

    let firstStandLoadedAt = 0
    for (const distillery of distilleries) {
      this.assertNotCancelled()
      const result = await this.inventoryActions.loadBrewingStand(
        distillery.x,
        distillery.y,
        distillery.z,
        item => normalizeItemKey(item.name).includes('potion'),
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success || result.count !== 3 || !result.loadedAt) {
        throw new Error(
          `装载蒸馏方块 ${distillery.alias} 失败: ${result.message || '未装满三个药水槽'}`
        )
      }
      if (firstStandLoadedAt === 0) firstStandLoadedAt = result.loadedAt
    }

    // 从第一台的第三瓶放入成功开始计时；完成后按相同顺序从第一台取出。
    // 装载和取出采用同一顺序，可让各台的实际蒸馏时长尽量一致。
    const finishAt = firstStandLoadedAt + runs * 45 * 1000
    this.phase = 'distilling'
    this.recipeId = recipe.id
    this.finishAt = finishAt
    this.distillationRuns = runs
    this.distillationStartedAt = firstStandLoadedAt
    await this.reportSafe(`蒸馏已开始，共 ${runs} 次，预计等待 ${runs * 45} 秒`)
    await this.waitUntil(finishAt)

    this.phase = 'distillery-unloading'
    this.recipeId = recipe.id
    this.finishAt = finishAt
    this.distillationRuns = runs
    this.distillationStartedAt = firstStandLoadedAt
    for (const distillery of distilleries) {
      this.assertNotCancelled()
      await this.attempt(`取出 ${distillery.alias} 蒸馏产物`, async () => {
        const result = await this.inventoryActions.unloadBrewingStand(
          distillery.x,
          distillery.y,
          distillery.z,
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success || result.count !== 3) {
          throw new Error(result.message || '未能取出三个药水槽')
        }
      })
    }
  }

  private async beginAging (recipe: BrewRecipe): Promise<void> {
    const aging = recipe.aging
    if (!aging) return

    this.phase = 'storing'
    this.recipeId = recipe.id
    this.finishAt = 0

    const barrels = this.resolveFreeAgingBarrels(aging.wood)
    if (barrels.length === 0) {
      await this.reportSafe(
        `没有可用的 ${woodLabel(aging.wood)} 酒桶，酒品将存入成品箱`
      )
      await this.skipAging(recipe.id)
      return
    }

    // 逐个尝试：酒桶内可能残留上一批未收取的酒品导致空位不足，放不下的桶换下一个。
    let barrel: ContainerRecord | null = null
    let deposit: ServiceResult & { count?: number } | null = null
    for (const candidate of barrels) {
      this.assertNotCancelled()
      const attempt = await this.inventoryActions.depositPotionsToAgingBarrel(
        candidate.x,
        candidate.y,
        candidate.z,
        this.configDistance('interaction'),
        AGING_BARREL_APPROACH
      )
      if (attempt.success) {
        barrel = candidate
        deposit = attempt
        break
      }
      if (attempt.code !== 'barrel_full') {
        throw new Error(`放入酒桶 ${candidate.alias} 失败: ${attempt.message || '未知错误'}`)
      }
      await this.reportSafe(`酒桶 ${candidate.alias} 放不下，尝试下一个酒桶`)
    }

    if (!barrel || !deposit) {
      // 所有酒桶都放不下整批酒品，退回成品箱入库，避免背包滞留酒品。
      await this.reportSafe(
        `没有可用的 ${woodLabel(aging.wood)} 酒桶，酒品将存入成品箱`
      )
      await this.skipAging(recipe.id)
      return
    }

    // 陈化期间锁定 bot（与主酿酒一致），防止被待命系统/其他玩家移动，保证到点能自动收取
    if (!this.isLockedProvider() && this.lockAgingFn && this.currentOwner) {
      this.lockAgingFn(this.currentOwner)
      this.isLockedByAging = true
    }
    this.agingDeferred = true

    const finishAt = Date.now() + aging.days * AGING_MS_PER_DAY
    const task: AgingTask = {
      id: `${recipe.id}:${barrel.alias}:${finishAt}`,
      recipeId: recipe.id,
      owner: this.currentOwner || 'unknown',
      barrel,
      finishAt,
      reminded10: false,
      reminded5: false,
      pendingAwayNotified: false,
      phase: 'aging',
      collecting: false
    }
    this.agingTasks.set(task.id, task)
    this.saveAgingTask(task)
    this.ensureAgingTimer()

    const when = new Date(finishAt).toLocaleTimeString()
    await this.reportSafe(
      `已将 ${deposit.count ?? 0} 瓶放入酒桶 ${barrel.alias}，陈化 ${aging.days} 游戏日，预计 ${when} 完成`
    )
  }

  /** 陈化跳过（酒桶全满/无可用酒桶）：整批存入成品箱 */
  private async skipAging (recipeId: string): Promise<void> {
    await this.storeAllPotions()
    await this.reportSafe(
      this.errors > 0
        ? `酿酒 ${recipeId} 已结束（陈化跳过），但发生 ${this.errors} 个错误`
        : `酿酒 ${recipeId} 已结束（陈化跳过，已入库）`
    )
  }

  private resolveFreeAgingBarrels (wood: AgingWoodType): ContainerRecord[] {
    const bot = this.mcBot.bot
    const occupied = new Set([...this.agingTasks.values()].map(task => task.barrel.alias))

    const candidates: ContainerRecord[] = []
    for (const node of this.containerRegistry.list(this.config.group)) {
      if (node.blockType !== 'Aging') continue
      if (!this.sameDimension(node.dimension)) continue
      if (occupied.has(node.alias)) continue

      const block = bot?.blockAt(new Vec3(node.x, node.y, node.z))
      if (!block) continue
      const blockWood = getAgingWoodType(block.name)
      if (!blockWood) continue
      if (wood !== 'any' && blockWood !== wood) continue
      candidates.push(node)
    }
    return candidates
  }

  private ensureAgingTimer (): void {
    if (this.agingTimer) return
    this.agingTimer = setInterval(() => {
      void this.tickAgingTasks()
    }, AGING_TICK_MS)
  }

  private async tickAgingTasks (): Promise<void> {
    if (this.agingTasks.size === 0) {
      if (this.agingTimer) {
        clearInterval(this.agingTimer)
        this.agingTimer = null
      }
      return
    }

    const now = Date.now()
    for (const task of [...this.agingTasks.values()]) {
      if (task.collecting) continue

      if (task.phase === 'aging') {
        const remaining = task.finishAt - now
        if (!task.reminded10 && remaining <= AGING_REMIND_10_MS) {
          task.reminded10 = true
          const near = this.isNearAgingBarrel(task.barrel)
          await this.notifyAgingOwner(
            task,
            near
              ? `陈化 ${task.recipeId} @ ${task.barrel.alias} 约 10 分钟后完成（当前在酒庄附近）`
              : `陈化 ${task.recipeId} @ ${task.barrel.alias} 约 10 分钟后完成（当前不在酒庄附近）`
          )
          if (near) task.reminded5 = true
        }
        if (!task.reminded5 && remaining <= AGING_REMIND_5_MS) {
          task.reminded5 = true
          if (!this.isNearAgingBarrel(task.barrel)) {
            await this.notifyAgingOwner(
              task,
              `陈化 ${task.recipeId} @ ${task.barrel.alias} 约 5 分钟后完成，请确保 bot 回到酒庄`
            )
          }
        }
        if (remaining > 0) continue
        task.phase = 'pending-collect'
      }

      if (task.phase === 'pending-collect') {
        await this.tryCollectAging(task)
      }
    }
  }

  private isNearAgingBarrel (barrel: ContainerRecord): boolean {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) return false
    const block = bot.blockAt(new Vec3(barrel.x, barrel.y, barrel.z))
    if (!block) return false
    const distance = bot.entity.position.distanceTo(
      new Vec3(barrel.x + 0.5, barrel.y + 0.5, barrel.z + 0.5)
    )
    return distance <= AGING_BARREL_APPROACH
  }

  private canCollectAging (): boolean {
    return this.mcBot.isReady &&
      !!this.mcBot.bot &&
      !this.taskRunning
  }

  /** 陈化任务结束（成功收取或确认无货）后，若是陈化开的那把锁就自动解锁 */
  private unlockAfterAgingIfMine (): void {
    if (this.agingLockStillMine() && this.unlockAgingFn) {
      this.unlockAgingFn()
      this.isLockedByAging = false
    }
  }

  private async tryCollectAging (task: AgingTask): Promise<void> {
    if (!this.canCollectAging()) return
    if (!this.isNearAgingBarrel(task.barrel)) {
      if (!task.pendingAwayNotified) {
        task.pendingAwayNotified = true
        await this.notifyAgingOwner(
          task,
          `陈化 ${task.recipeId} @ ${task.barrel.alias} 已完成，但 bot 不在酒庄附近，稍后重试收取`
        )
      }
      return
    }

    task.collecting = true
    try {
      const withdraw = await this.inventoryActions.withdrawPotionsFromAgingBarrel(
        task.barrel.x,
        task.barrel.y,
        task.barrel.z,
        this.configDistance('interaction'),
        AGING_BARREL_APPROACH
      )
      if (!withdraw.success) {
        await this.notifyAgingOwner(
          task,
          `收取陈化 ${task.recipeId} @ ${task.barrel.alias} 失败: ${withdraw.message || '未知错误'}，稍后重试`
        )
        return
      }

      // 桶内没有成品（可能已被人工提前收取），视为已收取，结束任务不再重试。
      if ((withdraw.count ?? 0) === 0) {
        this.agingTasks.delete(task.id)
        this.deleteAgingTask(task.id)
        this.unlockAfterAgingIfMine()
        await this.restoreStagedInventory()
        await this.notifyAgingOwner(
          task,
          `陈化 ${task.recipeId} @ ${task.barrel.alias} 桶内没有成品（可能已被人工提前收取），任务已结束`
        )
        return
      }

      try {
        await this.storeAllPotions()
      } catch (err) {
        await this.notifyAgingOwner(
          task,
          `陈化产物已取出但入库失败: ${(err as Error).message}`
        )
        return
      }

      this.agingTasks.delete(task.id)
      this.deleteAgingTask(task.id)
      this.unlockAfterAgingIfMine()
      await this.restoreStagedInventory()
      await this.notifyAgingOwner(
        task,
        `陈化 ${task.recipeId} @ ${task.barrel.alias} 已完成并入库，暂存物品已取回`
      )
    } finally {
      task.collecting = false
    }
  }

  private async notifyAgingOwner (task: AgingTask, message: string): Promise<void> {
    debug(`[Brew][Aging] ${message}`)
    // 陈化提醒始终私聊发起者，不受静默模式影响。
    try {
      this.mcBot.whisper(task.owner, message)
    } catch (err) {
      warn('[Brew] 陈化提醒私聊失败:', (err as Error).message)
    }
  }

  private async storeAllPotions (): Promise<void> {
    const aliases = this.config.productContainers
    if (aliases.length === 0) throw new Error('未配置产物箱')

    const initial = this.inventoryPotionCount()
    if (initial === 0) throw new Error('背包中未发现药水产物')

    for (const alias of aliases) {
      if (this.inventoryPotionCount() === 0) break
      await this.attempt(`存放产物到 ${alias}`, async () => {
        const products = this.requireNode(alias, 'Container', true)
        const result = await this.inventoryActions.storeFilteredInContainer(
          products.x,
          products.y,
          products.z,
          item => normalizeItemKey(item.name).includes('potion'),
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success) throw new Error(result.message || '存放产物失败')
      })
    }

    const remaining = this.inventoryPotionCount()
    if (remaining > 0) {
      throw new Error(`所有产物箱均无法继续存放，背包剩余 ${remaining} 瓶`)
    }
  }

  private async assertContainerAmount (
    node: ContainerRecord,
    itemId: string,
    required: number
  ): Promise<void> {
    const result = await this.inventoryActions.countInContainer(
      node.x,
      node.y,
      node.z,
      itemId,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!result.success) {
      throw new Error(`检查 ${node.alias} 失败: ${result.message || '未知错误'}`)
    }
    if ((result.count ?? 0) < required) {
      throw new Error(`${node.alias} 原料不足 (${result.count ?? 0}/${required})`)
    }
  }

  /** 奶桶不足时：就近找牛挤奶补足，仍不足则抛原料不足 */
  private async ensureMilkBuckets (node: ContainerRecord, required: number): Promise<void> {
    const current = await this.countMilkBuckets(node)
    if (current >= required) return

    const need = required - current
    await this.reportSafe(`${node.alias} 奶桶不足 (${current}/${required})，尝试自动挤奶 ${need} 桶`)
    debug(`[Brew] 奶桶不足 (${current}/${required})，尝试挤奶 ${need} 桶`)

    await this.ensureEmptyBucket()
    const milked = await this.milkCows(need)
    if (milked > 0) {
      await this.attempt(`存奶桶到 ${node.alias}`, async () => {
        const result = await this.inventoryActions.storeFilteredInContainer(
          node.x,
          node.y,
          node.z,
          item => normalizeItemKey(item.name) === 'milk_bucket',
          this.configDistance('interaction'),
          this.configDistance('approach')
        )
        if (!result.success) throw new Error(result.message || '存奶桶失败')
      })
      // 挤奶用剩的空桶归还工具箱
      await this.returnBuckets()
    }

    await this.assertContainerAmount(node, 'milk_bucket', required)
  }

  private async countMilkBuckets (node: ContainerRecord): Promise<number> {
    const result = await this.inventoryActions.countInContainer(
      node.x,
      node.y,
      node.z,
      'milk_bucket',
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!result.success) {
      throw new Error(`检查 ${node.alias} 失败: ${result.message || '未知错误'}`)
    }
    return result.count ?? 0
  }

  /** 确保背包有至少一个空桶（没有则从工具箱取） */
  private async ensureEmptyBucket (): Promise<void> {
    if (this.inventoryCount('bucket') > 0) return
    const toolbox = this.requireNode(this.config.toolbox, 'Container', true)
    const result = await this.inventoryActions.takeExactFromContainer(
      toolbox.x,
      toolbox.y,
      toolbox.z,
      'bucket',
      1,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!result.success) {
      throw new Error(`工具箱中没有空桶: ${result.message || ''}`)
    }
  }

  /** 就近找牛挤奶，返回成功挤到的桶数 */
  private async milkCows (need: number): Promise<number> {
    const bot = this.requireBot()
    const cows = Object.values(bot.entities)
      .filter(e => e?.type === 'mob' && e?.name === 'cow')
      .map(e => ({ e, dist: bot.entity.position.distanceTo(e.position) }))
      .filter(entry => entry.dist <= MILK_SEARCH_DISTANCE)
      .sort((a, b) => a.dist - b.dist)
      .map(entry => entry.e)

    if (cows.length === 0) {
      await this.reportSafe('附近没有奶牛可挤奶')
      return 0
    }

    let milked = 0
    for (const cow of cows) {
      if (milked >= need) break
      this.assertNotCancelled()
      const ok = await this.attempt(`挤奶 (${milked + 1}/${need})`, async () => this.milkCow(cow))
      if (ok) milked++
    }
    return milked
  }

  /** 对一头牛挤奶，成功返回 true */
  private async milkCow (cow: Entity): Promise<boolean> {
    const bot = this.requireBot()
    const approach = await approachEntity(
      bot,
      cow,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近奶牛')

    const bucket = findExactMatchingItems(bot.inventory.items(), 'minecraft:bucket')[0]
    if (!bucket) throw new Error('背包中没有空桶')

    const before = this.inventoryCount('milk_bucket')
    await bot.equip(bucket, 'hand')
    await lookAtSmart(bot, entityLookPoint(cow))
    await sleep(100)
    await bot.activateEntityAt(cow, entityLookPoint(cow))
    const filled = await this.waitForCondition(
      () => this.inventoryCount('milk_bucket') > before,
      Math.max(4000, this.config.interactionDelayMs * 4)
    )
    await sleep(this.config.interactionDelayMs)
    return filled
  }

  private async ensureOneBucket (toolbox: ContainerRecord): Promise<void> {
    if (this.inventoryCount('water_bucket') + this.inventoryCount('bucket') > 0) return

    const waterBuckets = await this.inventoryActions.countInContainer(
      toolbox.x, toolbox.y, toolbox.z, 'water_bucket',
      this.configDistance('interaction'), this.configDistance('approach')
    )
    const query = waterBuckets.success && (waterBuckets.count ?? 0) > 0
      ? 'water_bucket'
      : 'bucket'
    const result = await this.inventoryActions.takeExactFromContainer(
      toolbox.x, toolbox.y, toolbox.z, query, 1,
      this.configDistance('interaction'), this.configDistance('approach')
    )
    if (!result.success) {
      throw new Error(`工具箱中没有可用水桶或空桶: ${result.message || ''}`)
    }
  }

  private async ensureWaterBucket (): Promise<void> {
    if (this.inventoryCount('water_bucket') > 0) return
    if (this.inventoryCount('bucket') === 0) {
      throw new Error('背包中没有空桶')
    }
    await this.collectWater()
    await sleep(this.config.waterRefillDelayMs)
  }

  private async collectWater (): Promise<void> {
    const result = await this.useItemModule.fillWater('桶')
    if (result.success) return
    const failMessages: Record<string, string> = {
      no_water: '附近未找到水源',
      no_item: '背包中没有空桶',
      equip_fail: '装备水桶失败',
      too_far: '无法接近水源',
      not_filled: '从水源取水后未获得水桶'
    }
    throw new Error(failMessages[result.code ?? ''] ?? (result.message || '装水失败'))
  }

  private async returnBuckets (): Promise<void> {
    await this.attempt('归还水桶', async () => {
      const toolbox = this.requireNode(this.config.toolbox, 'Container', true)
      const result = await this.inventoryActions.storeFilteredInContainer(
        toolbox.x,
        toolbox.y,
        toolbox.z,
        item => {
          const name = normalizeItemKey(item.name)
          return name === 'bucket' || name === 'water_bucket'
        },
        this.configDistance('interaction'),
        this.configDistance('approach')
      )
      if (!result.success) throw new Error(result.message || '归还水桶失败')
    })
  }

  private async interactWithItem (node: ContainerRecord, itemId: string): Promise<void> {
    const bot = this.requireBot()
    const approach = await this.inventoryActions.approachBlock(
      node.x,
      node.y,
      node.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近方块')

    const block = bot.blockAt(new Vec3(node.x, node.y, node.z))
    if (!block) throw new Error('方块不可见')
    const item = findExactMatchingItems(bot.inventory.items(), itemId)[0]
    if (!item) throw new Error(`背包中没有 ${itemId}`)
    const beforeCount = this.inventoryCount(itemId)

    // 每次交互都重新装备，奶桶等使用后会变为空桶。
    await bot.equip(item, 'hand')
    await bot.activateBlock(block)
    const consumed = await this.waitForCondition(
      () => this.inventoryCount(itemId) < beforeCount,
      Math.max(4000, this.config.interactionDelayMs * 4)
    )
    if (!consumed) {
      throw new Error(`交互后 ${itemId} 数量未变化`)
    }
    await sleep(this.config.interactionDelayMs)
  }

  private async isFermenterFull (node: ContainerRecord): Promise<boolean> {
    const approach = await this.inventoryActions.approachBlock(
      node.x,
      node.y,
      node.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近炼药锅')
    return this.readFermenterFull(node)
  }

  private readFermenterFull (node: ContainerRecord): boolean {
    const bot = this.requireBot()
    const block = bot.blockAt(new Vec3(node.x, node.y, node.z))
    if (!block) throw new Error('炼药锅方块不可见')
    const props = block.getProperties?.() as { level?: number | string } | undefined
    const level = Number(props?.level ?? block.metadata)
    return (
      (block.name === 'water_cauldron' && level >= 3) ||
      (block.name === 'cauldron' && block.metadata >= 3)
    )
  }

  private async waitForFermenterFull (node: ContainerRecord): Promise<boolean> {
    const approach = await this.inventoryActions.approachBlock(
      node.x,
      node.y,
      node.z,
      this.configDistance('interaction'),
      this.configDistance('approach')
    )
    if (!approach.success) throw new Error(approach.message || '无法接近炼药锅')
    if (this.readFermenterFull(node)) return true
    return this.waitForCondition(
      () => this.readFermenterFull(node),
      Math.max(3000, this.config.interactionDelayMs * 4)
    )
  }

  private requireNode (
    alias: string,
    blockType: ContainerRecord['blockType'],
    requireMixed = false
  ): ContainerRecord {
    const node = this.containerRegistry.get(alias)
    if (!node) throw new Error(`节点不存在: ${alias}`)
    if (node.nodeGroup !== this.config.group) {
      throw new Error(`节点 ${alias} 不属于区域 ${this.config.group}`)
    }
    if (node.blockType !== blockType) {
      throw new Error(`节点 ${alias} 类型应为 ${blockType}，实际为 ${node.blockType}`)
    }
    if (requireMixed && node.isDedicated !== false) {
      throw new Error(`节点 ${alias} 必须是混合容器`)
    }
    return node
  }

  private requireBottleContainer (): ContainerRecord {
    const node = this.requireNode(this.config.bottleContainer, 'Container')
    if (!node.isDedicated || !node.itemId) {
      throw new Error(`玻璃瓶容器 ${node.alias} 必须是专用容器`)
    }
    if (normalizeItemKey(node.itemId) !== 'glass_bottle') {
      throw new Error(`玻璃瓶容器 ${node.alias} 绑定的物品不是 glass_bottle`)
    }
    return node
  }

  private requireDedicatedContainer (alias: string, expectedItem: string): ContainerRecord {
    const node = this.requireNode(alias, 'Container')
    if (!node.isDedicated || !node.itemId) {
      throw new Error(`节点 ${alias} 必须是专用容器`)
    }
    if (normalizeItemKey(node.itemId) !== normalizeItemKey(expectedItem)) {
      throw new Error(`节点 ${alias} 应绑定 ${expectedItem}，实际为 ${node.itemId}`)
    }
    return node
  }

  private requireBot () {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) throw new Error('机器人未就绪')
    return bot
  }

  private inventoryCount (itemId: string): number {
    const bot = this.requireBot()
    return findExactMatchingItems(bot.inventory.items(), itemId)
      .reduce((sum, item) => sum + item.count, 0)
  }

  private inventoryPotionCount (): number {
    const bot = this.requireBot()
    return bot.inventory.items()
      .filter(item => normalizeItemKey(item.name).includes('potion'))
      .reduce((sum, item) => sum + item.count, 0)
  }

  private async attempt<T> (label: string, action: () => Promise<T>): Promise<T | null> {
    try {
      return await action()
    } catch (err) {
      if (err instanceof BrewCancelledError || this.cancelRequested) {
        throw new BrewCancelledError()
      }
      this.errors++
      const message = `${label}失败: ${(err as Error).message}`
      warn(`[Brew] ${message}`)
      await this.reportSafe(message)
      return null
    }
  }

  private async waitUntil (finishAt: number): Promise<void> {
    while (Date.now() < finishAt) {
      this.assertNotCancelled()
      await sleep(Math.min(1000, finishAt - Date.now()))
    }
  }

  private async waitForCondition (
    condition: () => boolean,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      this.assertNotCancelled()
      if (condition()) return true
      await sleep(50)
    }
    return condition()
  }

  private assertNotCancelled (): void {
    if (this.cancelRequested) throw new BrewCancelledError()
  }

  private async reportSafe (message: string): Promise<void> {
    try {
      await this.report?.(message)
    } catch (err) {
      warn('[Brew] 汇报失败:', (err as Error).message)
    }
  }

  private configDistance (kind: 'interaction' | 'approach'): number {
    return kind === 'interaction' ? this.interactionDistance : BREW_APPROACH
  }
}

class BrewCancelledError extends Error {
  constructor () {
    super('cancelled')
  }
}
