/**
 * 本地数据层版本化迁移（另存，不覆盖老数据）。
 *
 * 做法选择：另存而不是原地覆盖 —— 老快照整体保留在内存上一份，新库整包序列化后一次性
 * 写入 localStorage；写入失败就丢掉新库、继续用老库，不会出现字段落了一半的中间态。
 * 迁移以版本号驱动（v1 裸记录 → v2 {version, entries}），重复执行结果一致：
 * 实测数据按业务主键合并，幂等合并不会冒出多余班次。
 *
 * 早年没有班次登记的补录规则（按值班日期迁移）：
 *   同一值班日期内，已明确登记的班次先占位，缺班次的记录按原登记顺序补第一个空位
 *   （第一条补白班、第二条补夜班）；同一天没有空位，或值班日期本身缺失/非法，
 *   无法定位时点，班次一律留空，交核对清单列出 —— 缺值不拿默认值顶。
 */
import {
  DUTY_STATUSES,
  SHIFTS,
  STATUS_PENDING,
  normalizeDutyRows,
} from './duty-domain'
import { measuredDutyRows, measuredLeakRows, measuredMaintenanceRows } from './seed-measured'
import type { EntryRow } from './types'

export const SCHEMA_VERSION = 2

export type RawDatabase = Record<string, EntryRow[]>

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value)
}

/** 识别 v1 仓库自动播种的占位样例行（各模块的“xx样例N”），这些不是真实存量记录。 */
const PLACEHOLDER_PATTERNS: Record<string, RegExp> = {
  duty: /^运维值班交接样例\d+$/,
  leak: /^渗漏水处置样例\d+$/,
  maintenance: /^设施检修管理样例\d+$/,
}

function validDate(value: string): boolean {
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function withFlags(row: EntryRow, status: string, pending: boolean, abnormal: boolean): EntryRow {
  return { ...row, status, pending, abnormal }
}

// ---------------------------------------------------------------------------
// 值班交接
// ---------------------------------------------------------------------------

type IndexedRow = { row: EntryRow; index: number }

function realLegacy(key: string, rows: EntryRow[]): IndexedRow[] {
  const markers: Record<string, string> = {
    duty: '值班班组',
    leak: '渗漏点位',
    maintenance: '检修对象',
  }
  const marker = markers[key]
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !(marker && PLACEHOLDER_PATTERNS[key].test(text(row, marker))))
}

/** 早年缺班次记录按值班日期补录，返回带「班次 / 班次来源」的新行。 */
export function backfillEarlyShifts(rows: EntryRow[]): EntryRow[] {
  const occupied = new Map<string, Set<string>>()
  const candidates: { index: number; date: string }[] = []
  rows.forEach((row, index) => {
    const date = text(row, '值班日期')
    const shift = text(row, '班次')
    const source = text(row, '班次来源')
    if (validDate(date) && (SHIFTS as readonly string[]).includes(shift)) {
      const set = occupied.get(date) ?? new Set<string>()
      set.add(shift)
      occupied.set(date, set)
    } else if (validDate(date) && source.startsWith('补录')) {
      // 幂等：上一轮补录的班次继续占位，不当成新的缺班次记录。
      const set = occupied.get(date) ?? new Set<string>()
      set.add(shift)
      occupied.set(date, set)
    } else if (validDate(date) && !shift.trim()) {
      candidates.push({ index, date })
    }
  })
  const result = rows.map((row) => ({ ...row }))
  for (const { index, date } of candidates) {
    const used = occupied.get(date) ?? new Set<string>()
    const candidate = SHIFTS.find((item) => !used.has(item))
    if (!candidate) {
      result[index] = { ...result[index], 班次: '', 班次来源: '' }
      continue
    }
    used.add(candidate)
    occupied.set(date, used)
    result[index] = { ...result[index], 班次: candidate, 班次来源: '补录（按值班日期）' }
  }
  return result
}

function normalizeDutyStatus(row: EntryRow): string {
  const status = text(row, 'status')
  return (DUTY_STATUSES as readonly string[]).includes(status) ? status : STATUS_PENDING
}

function migrateDuty(oldRows: EntryRow[]): EntryRow[] {
  const legacy = realLegacy('duty', oldRows).map(({ row }) => row)
  const measuredCodes = new Set(measuredDutyRows().map((row) => text(row, '交接编号')))
  // 实测与存量撞同一交接编号时，以实测那份为准；其余存量记录保留。
  const carried = legacy.filter((row) => !measuredCodes.has(text(row, '交接编号')))
  // 补录在合并后统一做：同日已登记（含实测）的班次先占位，再给早年缺班次的行补空位。
  const combined = [...measuredDutyRows(), ...carried].map((row) =>
    withFlags(row, normalizeDutyStatus(row), row.pending ?? false, row.abnormal ?? false),
  )
  const backfilled = backfillEarlyShifts(combined)
  const sorted = [...backfilled]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareDuty(a, b))
    .map(({ row }, index) => ({ ...row, id: index + 1 }))
  // 派生字段（pending/abnormal/交接状态）统一按领域规则重算。
  return normalizeDutyRows(sorted)
}

function shiftOrder(shift: string): number {
  if (shift === '白班') {
    return 0
  }
  if (shift === '夜班') {
    return 1
  }
  return 2
}

function compareDuty(a: IndexedRow, b: IndexedRow): number {
  const da = text(a.row, '值班日期')
  const db = text(b.row, '值班日期')
  const va = validDate(da)
  const vb = validDate(db)
  if (va !== vb) {
    return va ? -1 : 1
  }
  if (va && vb && da !== db) {
    return da < db ? -1 : 1
  }
  const sa = shiftOrder(text(a.row, '班次'))
  const sb = shiftOrder(text(b.row, '班次'))
  if (sa !== sb) {
    return sa - sb
  }
  return a.index - b.index
}

// ---------------------------------------------------------------------------
// 渗漏水处置：老记录按发现日期倒排补录，缺值保留为空
// ---------------------------------------------------------------------------

const LEAK_STATUSES = ['待处置', '处置中', '已完工', '需返工']

function migrateLeak(oldRows: EntryRow[]): EntryRow[] {
  const legacy = realLegacy('leak', oldRows).map(({ row }) => {
    const status = LEAK_STATUSES.includes(text(row, 'status')) ? text(row, 'status') : '待处置'
    return withFlags(row, status, status !== '已完工', status === '需返工')
  })
  const measuredCodes = new Set(measuredLeakRows().map((row) => text(row, '处置编号')))
  const carried = legacy.filter((row) => !measuredCodes.has(text(row, '处置编号')))
  const merged = [...measuredLeakRows(), ...carried]
  const sorted = [...merged]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const da = text(a.row, '发现日期')
      const db = text(b.row, '发现日期')
      const va = validDate(da)
      const vb = validDate(db)
      if (va !== vb) {
        return va ? -1 : 1
      }
      if (va && vb && da !== db) {
        return da < db ? 1 : -1 // 倒排：发现日期越新越靠前
      }
      return a.index - b.index
    })
    .map(({ row }, index) => ({ ...row, id: index + 1 }))
  return sorted
}

// ---------------------------------------------------------------------------
// 保养台账：与值班交接遗留事项对齐（来源交接编号），实测为主
// ---------------------------------------------------------------------------

const MAINT_STATUSES = ['待开工', '检修中', '已完工', '已延期']

function migrateMaintenance(oldRows: EntryRow[]): EntryRow[] {
  const legacy = realLegacy('maintenance', oldRows).map(({ row }) => {
    const status = MAINT_STATUSES.includes(text(row, 'status')) ? text(row, 'status') : '待开工'
    return withFlags(
      { ...row, 来源交接编号: text(row, '来源交接编号') },
      status,
      status !== '已完工',
      status === '已延期',
    )
  })
  const measuredCodes = new Set(measuredMaintenanceRows().map((row) => text(row, '检修编号')))
  const carried = legacy.filter((row) => !measuredCodes.has(text(row, '检修编号')))
  return [...measuredMaintenanceRows(), ...carried].map((row, index) => ({ ...row, id: index + 1 }))
}

/**
 * v1（裸记录）/ 任意旧快照 → v2 entries。
 * 只整理 duty / leak / maintenance 三个模块，其余模块原样搬。
 * 已经是 v2 形态的库原样返回：迁移按版本号驱动，重复执行不会再跑一遍、不会冒班次。
 */
export function migrateDatabase(old: RawDatabase): RawDatabase {
  if (isV2Shape(old)) {
    return old
  }
  const next: RawDatabase = { ...old }
  next.duty = migrateDuty(old.duty ?? [])
  next.leak = migrateLeak(old.leak ?? [])
  next.maintenance = migrateMaintenance(old.maintenance ?? [])
  return next
}

/** v2 的值班表带「班次来源」字段且交接编号采用日期-班次编码；据此识别已迁移库。 */
function isV2Shape(db: RawDatabase): boolean {
  const duty = db.duty
  if (!duty || duty.length === 0) {
    return false
  }
  return duty.every((row) => '班次来源' in row && /^DUTY-\d{8}-[12]$/.test(text(row, '交接编号')))
}

/** v2 全新库的权威种子：duty/leak/maintenance 用实测数据，其余沿用仓库示例。 */
export function freshV2Entries(seedRows: RawDatabase): RawDatabase {
  return migrateDatabase(seedRows)
}
