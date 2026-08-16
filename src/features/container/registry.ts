import type { DatabaseSync } from 'node:sqlite'

export type BlockNodeType = 'Container' | 'Fermenter' | 'Distillery' | 'Aging' | 'Water'

export interface ContainerRecord {
  alias: string
  /** 具体方块名（如 chest / water_cauldron），兼作展示 */
  type: string
  /** 分类类型：Container/Fermenter/Distillery/Aging/Water；旧 `container` 命令登记的可为 null */
  blockType: BlockNodeType | null
  x: number
  y: number
  z: number
  dimension: string
  /** 专用容器（绑定单一物品）时为 true；混合容器为 false；非容器节点为 null */
  isDedicated: boolean | null
  /** 专用容器绑定的物品 ID（如 minecraft:glass_bottle）；混合/非容器节点为 null */
  itemId: string | null
  nodeGroup: string | null
  addedBy: string
  addedAt: string
}

export interface RegisterContainerRecord {
  alias: string
  type: string
  blockType?: BlockNodeType | null
  x: number
  y: number
  z: number
  dimension: string
  isDedicated?: boolean | null
  itemId?: string | null
  nodeGroup?: string | null
  addedBy: string
  addedAt?: string
}

interface ContainerRow extends Omit<ContainerRecord, 'isDedicated'> {
  isDedicated: number | null
}

function mapRow (row: ContainerRow): ContainerRecord {
  return {
    ...row,
    isDedicated: row.isDedicated == null ? null : row.isDedicated === 1
  }
}

export default class ContainerRegistry {
  private db: DatabaseSync

  constructor (db: DatabaseSync) {
    this.db = db
  }

  add (record: RegisterContainerRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO containers (
        alias, type, x, y, z, dimension, added_by, added_at,
        block_type, is_dedicated, item_id, node_group
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.alias,
      record.type,
      record.x,
      record.y,
      record.z,
      record.dimension,
      record.addedBy,
      record.addedAt || new Date().toISOString(),
      record.blockType ?? null,
      record.isDedicated == null ? null : (record.isDedicated ? 1 : 0),
      record.itemId ?? null,
      record.nodeGroup ?? null
    )
  }

  remove (alias: string): boolean {
    const result = this.db.prepare('DELETE FROM containers WHERE alias = ?').run(alias)
    return result.changes > 0
  }

  get (alias: string): ContainerRecord | null {
    const row = this.db.prepare(`
      SELECT alias, type, x, y, z, dimension, added_by AS addedBy, added_at AS addedAt,
             block_type AS blockType, is_dedicated AS isDedicated,
             item_id AS itemId, node_group AS nodeGroup
      FROM containers WHERE alias = ?
    `).get(alias) as ContainerRow | undefined
    return row ? mapRow(row) : null
  }

  list (nodeGroup?: string): ContainerRecord[] {
    const rows = nodeGroup !== undefined
      ? this.db.prepare(`
          SELECT alias, type, x, y, z, dimension, added_by AS addedBy, added_at AS addedAt,
                 block_type AS blockType, is_dedicated AS isDedicated,
                 item_id AS itemId, node_group AS nodeGroup
          FROM containers WHERE node_group = ?
          ORDER BY alias
        `).all(nodeGroup)
      : this.db.prepare(`
          SELECT alias, type, x, y, z, dimension, added_by AS addedBy, added_at AS addedAt,
                 block_type AS blockType, is_dedicated AS isDedicated,
                 item_id AS itemId, node_group AS nodeGroup
          FROM containers ORDER BY alias
        `).all()

    return (rows as unknown as ContainerRow[]).map(mapRow)
  }

  count (): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM containers').get() as { c: number }
    return row.c
  }
}
