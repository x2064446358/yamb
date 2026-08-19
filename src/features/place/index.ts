import type UseItemModule from '../useitem'
import { Vec3 } from 'vec3'

/**
 * 放置功能边界：相对放置与破基岩追踪放置均从这里对外提供。
 * 底层复用物品模块已经验证过的计时、取消和放置校准执行器，避免两套循环争抢手持物品。
 */
export default class PlaceModule {
  constructor (private readonly runner: UseItemModule) {}

  isActive (): boolean {
    return this.runner.isPlacing()
  }

  isBedrockBreak (): boolean {
    return this.runner.isBedrockBreak()
  }

  setOnBreakChange (fn: (active: boolean, owner: string | null) => void): void {
    this.runner.setOnBreakChange(fn)
  }

  start (args: string, owner?: string): string {
    return this.runner.startPlace(args, owner)
  }

  interrupt (reason: string): void {
    this.runner.interrupt(reason)
  }

  stop (): string {
    return this.runner.stopPlace()
  }

  setReferenceTarget (target: Vec3): void {
    this.runner.setLookTarget(target)
  }
}
