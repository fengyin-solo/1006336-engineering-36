/**
 * 数据版本迁移与种子装配。
 *
 * 迁移方式：版本化「原地覆盖」，不另存一份。
 * 理由：本地数据只有 localStorage 单键一个落点，另存旧版本会让「发起交接/确认交接/登记遗留」
 * 长期存在两套读入口，正是这次要根治的「换台机器数据就变」问题；版本号 + 按自然键合并保证
 * 迁移幂等、可重复执行，落库由 local-store 统一事务提交（失败整体回滚，不留中间态）。
 *
 * v1（旧版本地库，无版本信封）→ v2：
 * - 值班交接（duty）：按值班日期升序迁移；早年（2025-01-01 前）缺/非法班次按日序奇偶补登，
 *   交接编号按「值班日期+班次」重算（保留撞车事实，不删数据）；晚于分界缺班次不补、不拿默认值顶；
 * - 渗漏处置（leak）：老的处置记录按发现日期倒排补录，缺值字段保留空，不拿默认值顶；
 * - 设备台账（device）：值班交接遗留事项涉及设备的，现场实测日期落到保养台账，设备派生状态
 *   按实测日期重算（两处取值打架，以现场实测那份为准）。
 *
 * 任何机器全新打开（直接播种 v2）与旧机器升级（v1→v2）收敛到同一份数据。
 */

import type { EntryRow } from './types'
import { SEED_ROWS_V1_TEMPLATE } from './seed-other-modules'
import { CANONICAL_DUTY_ROWS, LEGACY_DUTY_ROWS } from './duty-seed'
import {
  FINAL_STATUSES,
  LEGACY_SHIFT_FILL_BEFORE,
  PENDING_HANDOVER_STATUSES,
  SHIFTS,
  TEAM_ROSTERS,
  auditDutyRows,
  handoverCode,
  isShift,
  isValidDate,
  legacyShiftFor,
  type Shift,
} from './duty-rules'

export const DATA_VERSION = 2

/** 旧版种子里各模块的字段值占位模式（「XX样例N」），用于识别机器生成的占位行。 */
const PLACEHOLDER_PATTERN = /样例\d+$/

export function isPlaceholderRow(row: EntryRow): boolean {
  return Object.values(row).some(
    (value) => typeof value === 'string' && PLACEHOLDER_PATTERN.test(value),
  )
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

// ────────────────────────── 值班交接：存量规整 ──────────────────────────

export type DutyMigrationNote = {
  rowId: number
  code: string
  date: string
  note: string
}

/**
 * 规整一条值班交接存量记录（幂等：已是规范形态的记录原样返回）。
 * - 早年（LEGACY_SHIFT_FILL_BEFORE 前）班次空缺/非法：按日序奇偶补白/夜班；
 * - 晚于分界班次空缺/非法：保留空值，等核对清单逐条列出；
 * - 班次合法或补登成功后，交接编号统一按日期+班次重算，旧编号不同时在备注里留痕；
 * - 状态字段同步规整，pending 按统一口径重算，不保留各行其是的旧标记。
 */
export function normalizeDutyRow(row: EntryRow): { row: EntryRow; note: string | null } {
  const next: EntryRow = { ...row }
  const notes: string[] = []

  const date = text(next['值班日期'])
  const rawShift = text(next['班次'])
  let shift: string = isShift(rawShift) ? rawShift : ''

  if (!shift && isValidDate(date) && date < LEGACY_SHIFT_FILL_BEFORE) {
    const filled = legacyShiftFor(date)
    if (filled) {
      shift = filled
      notes.push(`早年缺班次登记，按值班日期日序奇偶补登为「${shift}」`)
    }
  }
  if (!shift) {
    // 晚于分界仍缺班次：缺值不许拿默认值顶，留空进入核对清单。
    next['班次'] = ''
  } else {
    next['班次'] = shift
  }

  const oldCode = text(next['交接编号'])
  if (shift) {
    const canonical = handoverCode(date, shift as Shift)
    if (oldCode !== canonical) {
      if (oldCode) {
        notes.push(`交接编号由「${oldCode}」按值班日期与班次重算为「${canonical}」（重号保留不删）`)
      }
      next['交接编号'] = canonical
    }
  }

  const status = text(next.status)
  next.status = status
  next.pending = PENDING_HANDOVER_STATUSES.includes(status)

  return { row: next, note: notes.length ? notes.join('；') : null }
}

/** 存量交接记录按值班日期迁移（升序落位；日期缺失排最后），返回规整结果与留痕备注。 */
export function migrateDutyRows(rows: EntryRow[]): { rows: EntryRow[]; notes: DutyMigrationNote[] } {
  const notes: DutyMigrationNote[] = []
  const migrated = rows.map((row) => {
    const { row: next, note } = normalizeDutyRow(row)
    if (note) {
      notes.push({ rowId: Number(next.id), code: text(next['交接编号']), date: text(next['值班日期']), note })
    }
    return next
  })
  migrated.sort((a, b) => {
    const da = text(a['值班日期'])
    const db = text(b['值班日期'])
    if (da === db) {
      return Number(a.id) - Number(b.id)
    }
    if (!isValidDate(da)) {
      return 1
    }
    if (!isValidDate(db)) {
      return -1
    }
    return da < db ? -1 : 1
  })
  return { rows: migrated, notes }
}

// ────────────────────────── 设备台账：与交接遗留两边对齐 ──────────────────────────

export const DEVICE_LINK_FIELD = '关联交接'

/** 保养周期（天）：种子设备是规整值；运行期登记若仍是旧占位/非数字，按 null 处理（不拿默认值顶）。 */
function maintenanceIntervalDays(period: unknown): number | null {
  const value = Number(String(period ?? '').replace(/[^0-9]/g, ''))
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 以现场实测日期为准重算设备保养状态：
 * - 实测「上次保养日」直接覆盖台账旧值（两处取值打架以现场实测那份为准）；
 * - 距基准日超过保养周期 → 待保养；周期内 → 已保养；周期缺失无法判定 → 运行中，不臆造。
 */
export function recomputeDeviceStatus(row: EntryRow, measuredDate: string, baseDate: string): EntryRow {
  const next: EntryRow = { ...row, 上次保养日: measuredDate }
  const interval = maintenanceIntervalDays(next['保养周期'])
  let status = '运行中'
  if (isValidDate(measuredDate) && interval !== null) {
    const elapsed = Math.round((Date.parse(baseDate) - Date.parse(measuredDate)) / 86_400_000)
    status = elapsed > interval ? '待保养' : '已保养'
  }
  next.status = status
  next.pending = status === '待保养'
  next.abnormal = status === '待保养'
  return next
}

/**
 * 值班交接遗留 → 设备保养台账对齐。
 * 只处理「有遗留」状态、交接事项里给出设备编号的交接记录；同一设备多条遗留时取最新实测日期
 * （现场实测优先）。返回对齐后的设备台账，以及两边编号互相能查到的链接集合。
 */
export function alignDeviceLedger(
  deviceRows: EntryRow[],
  dutyRows: EntryRow[],
  baseDate: string,
): { rows: EntryRow[]; linked: Set<string> } {
  // 设备编号 → 现场实测（值班日期）：同一设备多条遗留时，以最后登记的那次现场实测为准
  // （两次取值打架以现场实测那份为准；登记顺序即行顺序，后一条覆盖前一条）。
  const measured = new Map<string, { date: string; code: string }>()
  for (const row of dutyRows) {
    if (text(row.status) !== '有遗留') {
      continue
    }
    // 优先取登记时填写的实测日期，没有再退回值班日期
    const explicit = text(row['实测日期'])
    const match = /(DEVI-\d{4})/.exec(text(row['交接事项']))
    if (!match) {
      continue
    }
    const deviceNo = match[1]
    measured.set(deviceNo, {
      date: isValidDate(explicit) ? explicit : text(row['值班日期']),
      code: text(row['交接编号']),
    })
  }

  const linked = new Set<string>()
  const rows = deviceRows.map((row) => {
    const deviceNo = text(row['设备编号'])
    const hit = measured.get(deviceNo)
    if (!hit) {
      const existing = text(row[DEVICE_LINK_FIELD])
      if (existing) {
        linked.add(existing)
      }
      return row
    }
    linked.add(hit.code)
    return recomputeDeviceStatus({ ...row, [DEVICE_LINK_FIELD]: hit.code }, hit.date, baseDate)
  })
  return { rows, linked }
}

// ────────────────────────── 渗漏处置：老记录按发现日期倒排补录 ──────────────────────────

/** 老的处置记录按发现日期倒排补录（缺日期的排最末），缺值字段原样保留，不拿默认值顶。 */
export function orderLeakBackfill(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((a, b) => {
    const da = text(a['发现日期'])
    const db = text(b['发现日期'])
    if (da === db) {
      return Number(b.id) - Number(a.id)
    }
    if (!isValidDate(da)) {
      return 1
    }
    if (!isValidDate(db)) {
      return -1
    }
    return da < db ? 1 : -1
  })
}

// ────────────────────────── 种子装配 ──────────────────────────

export type SeedBundle = {
  version: number
  entries: Record<string, EntryRow[]>
  dutyNotes: DutyMigrationNote[]
}

/**
 * 组装当前版本（v2）的权威种子：所有环境、任何机器都装配这一份。
 * duty = 现行排程 + 早年存量，统一过一遍规整规则（保证种子与迁移后数据完全一致）；
 * device 与遗留事项两边对齐；leak 老记录按发现日期倒排。
 */
export function buildSeedBundle(baseDate = '2026-10-01'): SeedBundle {
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(SEED_ROWS_V1_TEMPLATE)) {
    entries[key] = rows.map((row) => ({ ...row }))
  }

  const dutyMerged = [...CANONICAL_DUTY_ROWS, ...LEGACY_DUTY_ROWS]
  const dutyResult = migrateDutyRows(dutyMerged)
  // 种子里的核对问题要体现在 abnormal 上：核对清单逐条命中的记录标异常，概览/报表读数才一致。
  const issueIds = new Set(auditDutyRows(dutyResult.rows).map((issue) => issue.rowId))
  entries.duty = dutyResult.rows.map((row) => ({
    ...row,
    abnormal: issueIds.has(Number(row.id)) || text(row.status) === '有遗留',
  }))

  entries.device = alignDeviceLedger(entries.device, entries.duty, baseDate).rows
  entries.leak = orderLeakBackfill(entries.leak)

  return { version: DATA_VERSION, entries, dutyNotes: dutyResult.notes }
}

/**
 * v1 旧库（localStorage 里直接铺的 Record<string, EntryRow[]>）迁移到 v2：
 * 旧种子占位行整批替换为权威种子；真实登记行按自然键合并保留，再过模块规整规则。
 * 幂等：重复执行不会新增班次（交接编号相同即视为同一条）。
 */
export function migrateV1ToV2(
  legacy: Record<string, EntryRow[]>,
  baseDate = '2026-10-01',
): SeedBundle {
  const seed = buildSeedBundle(baseDate)
  const entries: Record<string, EntryRow[]> = { ...seed.entries }

  for (const [key, rows] of Object.entries(legacy)) {
    const realRows = rows.filter((row) => !isPlaceholderRow(row))
    if (realRows.length === 0) {
      continue
    }
    if (key === 'duty') {
      // 真实登记行与种子按交接编号合并：同号不新增，只补缺；新编号追加后统一规整。
      const known = new Map(entries.duty.map((row) => [text(row['交接编号']), row]))
      const merged = [...entries.duty]
      for (const row of realRows) {
        const code = text(row['交接编号'])
        if (code && known.has(code)) {
          continue
        }
        merged.push({ ...row })
      }
      const result = migrateDutyRows(merged)
      entries.duty = result.rows
      continue
    }
    // 其余模块：id 不与种子冲突即保留（真实登记行优先，不被重复初始化覆盖）。
    const seedIds = new Set((entries[key] ?? []).map((row) => Number(row.id)))
    const merged = [...(entries[key] ?? [])]
    for (const row of realRows) {
      if (!seedIds.has(Number(row.id))) {
        merged.push({ ...row })
      }
    }
    entries[key] = merged
  }

  entries.device = alignDeviceLedger(entries.device, entries.duty, baseDate).rows
  entries.leak = orderLeakBackfill(entries.leak)

  const issueIds = new Set(auditDutyRows(entries.duty).map((issue) => issue.rowId))
  entries.duty = entries.duty.map((row) => ({
    ...row,
    pending: PENDING_HANDOVER_STATUSES.includes(text(row.status)),
    abnormal: issueIds.has(Number(row.id)) || text(row.status) === '有遗留',
  }))

  return { version: DATA_VERSION, entries, dutyNotes: seed.dutyNotes }
}

export { SHIFTS, TEAM_ROSTERS, FINAL_STATUSES }
