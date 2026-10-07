/**
 * 运维值班交接：统一读写规则（唯一事实来源）。
 *
 * 发起交接 / 确认交接 / 登记遗留，以及种子生成、存量迁移、核对清单，全部走这一份规则，
 * 保证「本地开发」和「上线环境」读到的待交接班次、有遗留事项完全一致，换台机器也一样。
 *
 * 规则要点：
 * 1. 班次字典固定为 白班 / 夜班 / 中班，不允许自由填写；
 * 2. 值班班组固定为三个值班队，每队有固定花名册，交接人员必须出自接班班组花名册；
 * 3. 交接编号由「值班日期 + 班次」推导：DUTY-YYYYMMDD-班次码（白 D / 夜 N / 中 M），
 *    同日期同班次天然同号 —— 撞号即说明同一班次被登记了两次；
 * 4. 早年（LEGACY_SHIFT_FILL_BEFORE 之前）没有班次登记的存量记录，按值班日期「日序奇偶」补：
 *    奇数日补白班、偶数日补夜班。该规则确定、可复算；该日期之后缺班次一律不补、不拿默认值顶，
 *    原样进入核对清单。
 */

import type { EntryRow } from './types'

// ────────────────────────── 字典与花名册 ──────────────────────────

export const SHIFTS = ['白班', '夜班', '中班'] as const
export type Shift = (typeof SHIFTS)[number]

const SHIFT_CODES: Record<Shift, string> = { 白班: 'D', 夜班: 'N', 中班: 'M' }

/** 值班班组与固定花名册：交接人员（接班人）必须在接班班组的花名册里。 */
export const TEAM_ROSTERS: Record<string, string[]> = {
  综合运维一班: ['张建国', '李秀英', '王海涛'],
  综合运维二班: ['陈志强', '刘桂兰', '赵鹏'],
  机电保障三班: ['孙卫民', '周敏', '吴磊'],
}

export const TEAM_NAMES = Object.keys(TEAM_ROSTERS)

export const DUTY_STATUSES = ['待交接', '交接中', '已交接', '有遗留'] as const

/** 待交接口径：状态尚未走到终态（已交接 / 有遗留）的班次。所有入口共用这一个口径。 */
export const PENDING_HANDOVER_STATUSES: string[] = ['待交接', '交接中']
export const FINAL_STATUSES: string[] = ['已交接', '有遗留']
export const LEGACY_LEFT_STATUS = '有遗留'

/**
 * 早年缺班次的补登分界：值班日期早于该日且班次为空/非法的，按日序奇偶补白/夜班；
 * 该日及之后缺班次的不补，按缺值问题列出。
 */
export const LEGACY_SHIFT_FILL_BEFORE = '2025-01-01'

/**
 * 统计基准日（固定，保证种子读数在任何机器、任何一天构建都一致）。
 * 仅用于种子数据的派生状态；运行期新登记记录按真实日期计算。
 */
export const STATS_BASE_DATE = '2026-10-01'

// ────────────────────────── 编号与班次推导 ──────────────────────────

export function isShift(value: unknown): value is Shift {
  return typeof value === 'string' && (SHIFTS as readonly string[]).includes(value.trim())
}

export function shiftOfCode(code: string): Shift | null {
  const entry = Object.entries(SHIFT_CODES).find(([, c]) => c === code)
  return entry ? (entry[0] as Shift) : null
}

/** 班次码：白 D / 夜 N / 中 M。 */
export function shiftCode(shift: Shift): string {
  return SHIFT_CODES[shift]
}

/** 交接编号：DUTY-YYYYMMDD-班次码，由值班日期与班次唯一确定。 */
export function handoverCode(date: string, shift: Shift): string {
  const compact = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, '') : ''
  return `DUTY-${compact}-${shiftCode(shift)}`
}

/** 从交接编号反解班次码；编号非法时返回 null。 */
export function codeShiftSuffix(code: string): Shift | null {
  const matched = /^DUTY-\d{8}-([DNM])$/.exec(String(code ?? ''))
  if (!matched) {
    return null
  }
  return shiftOfCode(matched[1])
}

export function isValidDate(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

/** 早年缺班次补登规则：日序奇数补白班、偶数补夜班；无法解析日期时不补（返回 null）。 */
export function legacyShiftFor(date: string): Shift | null {
  if (!isValidDate(date)) {
    return null
  }
  const day = Number(date.slice(8, 10))
  return day % 2 === 1 ? '白班' : '夜班'
}

// ────────────────────────── 核对（读规则） ──────────────────────────

export type IssueType = 'duplicate-code' | 'shift-empty' | 'personnel-mismatch'

export type DutyIssue = {
  type: IssueType
  rowId: number
  code: string
  date: string
  team: string
  shift: string
  person: string
  reason: string
}

export const ISSUE_LABELS: Record<IssueType, string> = {
  'duplicate-code': '交接编号撞车',
  'shift-empty': '班次空着',
  'personnel-mismatch': '交接人员与值班班组对不上',
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * 逐条核对交接记录，三类问题各算一条（一条记录可命中多条），
 * 返回顺序固定：先按记录 id，再按问题类型，页面与导出都用它，条数必然对得上。
 */
export function auditDutyRows(rows: EntryRow[]): DutyIssue[] {
  const issues: DutyIssue[] = []

  const codeCount = new Map<string, number>()
  for (const row of rows) {
    const code = clean(row['交接编号'])
    if (code) {
      codeCount.set(code, (codeCount.get(code) ?? 0) + 1)
    }
  }

  for (const row of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
    const code = clean(row['交接编号'])
    const date = clean(row['值班日期'])
    const team = clean(row['值班班组'])
    const shift = clean(row['班次'])
    const person = clean(row['交接人员'])
    const status = clean(row.status)
    const base = { rowId: Number(row.id), code, date, team, shift, person }

    if (code && (codeCount.get(code) ?? 0) > 1) {
      issues.push({
        ...base,
        type: 'duplicate-code',
        reason: `交接编号 ${code} 出现 ${codeCount.get(code)} 次：交接编号由值班日期与班次推导（DUTY-YYYYMMDD-班次码），同号说明同一班次被重复登记`,
      })
    }

    if (!isShift(shift)) {
      issues.push({
        ...base,
        type: 'shift-empty',
        reason: `班次为空或不在班次字典（白班/夜班/中班）内，现值「${shift || '空'}」`,
      })
    }

    // 交接人员（接班人签字）核对：
    // - 已交接：签字必须出自本班花名册，空缺也列问题；
    // - 有遗留但签字空缺：说明是待交接班次直接登记的遗留，尚未完成接班签字，不报「对不上」；
    // - 待交接 / 交接中：接班人尚未签字，不报。
    if (status === '已交接') {
      const roster = TEAM_ROSTERS[team]
      if (!roster) {
        issues.push({
          ...base,
          type: 'personnel-mismatch',
          reason: `值班班组「${team || '空'}」不在三个值班队名册内，无法核对交接人员`,
        })
      } else if (!person) {
        issues.push({
          ...base,
          type: 'personnel-mismatch',
          reason: `已交接但交接人员空缺，值班班组「${team}」花名册为 ${roster.join('、')}`,
        })
      } else if (!roster.includes(person)) {
        issues.push({
          ...base,
          type: 'personnel-mismatch',
          reason: `交接人员「${person}」不在值班班组「${team}」花名册（${roster.join('、')}）内`,
        })
      }
    }
  }

  const order: IssueType[] = ['duplicate-code', 'shift-empty', 'personnel-mismatch']
  return issues.sort((a, b) => a.rowId - b.rowId || order.indexOf(a.type) - order.indexOf(b.type))
}

// ────────────────────────── 汇总口径（所有页面/报表共用） ──────────────────────────

export function pendingHandoverCount(rows: EntryRow[]): number {
  return rows.filter((row) => PENDING_HANDOVER_STATUSES.includes(clean(row.status))).length
}

export function handedOverCount(rows: EntryRow[]): number {
  return rows.filter((row) => clean(row.status) === '已交接').length
}

export function legacyLeftCount(rows: EntryRow[]): number {
  return rows.filter((row) => clean(row.status) === LEGACY_LEFT_STATUS).length
}
