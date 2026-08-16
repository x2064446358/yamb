declare module 'mineflayer-pathfinder' {
  import type { Bot } from 'mineflayer'
  import type { Vec3 } from 'vec3'

  export class Movements {
    constructor (bot: Bot)
    canDig?: boolean
    allow1by1towers?: boolean
    allowParkour?: boolean
    allowSprinting?: boolean
    allowFreeMotion?: boolean
  }

  export namespace goals {
    class GoalNear {
      constructor (x: number, y: number, z: number, range: number)
    }
    class GoalBlock {
      constructor (x: number, y: number, z: number)
    }
    class GoalLookAtBlock {
      constructor (
        pos: Vec3,
        world: unknown,
        options?: { reach?: number, entityHeight?: number }
      )
    }
  }

  export function pathfinder (bot: Bot): void
}
