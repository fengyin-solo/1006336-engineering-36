/**
 * 运维值班交接 —— 全平台唯一的读写规则。
 *
 * 发起交接 / 确认交接 / 登记遗留，以及指标汇总、存量核对，全部走这里的纯函数；
 * 页面（views/duty）、本地数据服务（local-service）、迁移（migrations）和验证脚本
 * 读的是同一套规则，换机器、换环境不会再出现班次、交接人员、遗留事项串台的情况。
 *
 * 纯函数不碰 localStorage / window，可以直接在 Node 里跑验证。
 */
import type { EntryRow } from './types'

export const DUTY_MODULE_KEY = 'duty'

/** 班次取值只准是这两个，空着就是空着，绝不拿默认值顶。 */
export const SHIFT_DAY = '白班' as const
export const SHIFT_NIGHT = '夜班' as const
export const SHIFTS = [SHIFT_DAY, SHIFT_NIGHT] as const
export type Shift = (typeof SHIFTS)[number]

/** 班次时段（与 stores/session 里的值班口径保持一致）。 */
export const SHIFT_SPANS: Record<Shift, string> = {
  [SHIFT_DAY]: '08:00-20:00',
  [SHIFT_NIGHT]: '20:00-次日08:00',
}

export const STATUS_PENDING = '待交接'
export const STATUS_HANDOVER = '交接中'
export const STATUS_DONE = '已交接'
export const STATUS_LEGACY = '有遗留'

/** 允许出现的状态顺序，动作只能顺着走或在「已交接/有遗留」之间登记遗留。 */
export const DUTY_STATUSES = [STATUS_PENDING, STATUS_HANDOVER, STATUS_DONE, STATUS_LEGACY] as const

/**
 * 各班次的值班班组花名册（现场实测口径，迁移时以这份为准）。
 * key = `${值班日期}#${班次}`。
 * 核对「交接人员与值班班组对不上」就查这张表。
 */
export const DUTY_TEAMS = ['综合运维一班', '综合运维二班', '综合运维三班'] as const

/** 白班/夜班的人员归属：交接人员必须属于该班次的值班班组，跨班组交接即核对不通过。 */
export const TEAM_ROSTER: Record<string, readonly string[]> = {
  综合运维一班: ['陈岩', '高航', '宋洁'],
  综合运维二班: ['林远航', '赵启明', '何静'],
  综合运维三班: ['周野', '孙鹏', '郭敏'],
}

/** 固定轮转：白班按日序轮转，夜班 = 白班的下一个班组。日期缺省时无法判定。 */
export function expectedTeam(dutyDate: string, shift: string): string {
  const ordinal = daysSinceBase(dutyDate)
  if (ordinal < 0) {
    return ''
  }
  const dayTeam = DUTY_TEAMS[ordinal % DUTY_TEAMS.length]
  if (shift === SHIFT_NIGHT) {
    return DUTY_TEAMS[(ordinal + 1) % DUTY_TEAMS.length]
  }
  return dayTeam
}

/** 实测数据集基准日期（2026-10-01 为一班白班）。 */
export const BASE_DATE = '2026-10-01'

export function daysSinceBase(dutyDate: string): number {
  const base = Date.parse(`${BASE_DATE}T00:00:00Z`)
  const cur = Date.parse(`${dutyDate}T00:00:00Z`)
  if (Number.isNaN(base) || Number.isNaN(cur)) {
    return -1
  }
  return Math.round((cur - base) / 86_400_000)
}

export function rosterOf(team: string): readonly string[] {
  return TEAM_ROSTER[team] ?? []
}

export function isValidShift(value: unknown): value is Shift {
  return value === SHIFT_DAY || value === SHIFT_NIGHT
}

/** 交接编号 DUTY-YYYYMMDD-班次序号(白班1/夜班2)，按交接编号与班次生成，环境间一致。 */
export function dutyCode(dutyDate: string, shift: Shift): string {
  const compact = dutyDate.replace(/-/g, '')
  return `DUTY-${compact}-${shift === SHIFT_DAY ? '1' : '2'}`
}

export type DutyIssue =
  | '交接编号撞车'
  | '班次空着'
  | '交接人员与值班班组对不上'
  | '值班班组与排班不符'

export type AuditItem = {
  id: number | ''
  code: string
  dutyDate: string
  shift: string
  team: string
  handoverPerson: string
  reasons: DutyIssue[]
}

export type DutyActionResult = {
  ok: boolean
  message: string
}

/** 登记遗留时的入参，缺值必须显式传空串，服务层不许编默认值。 */
export type LegacyInput = {
  遗留事项: string
  交接人员: string
}

type ActionName = '发起交接' | '确认交接' | '登记遗留'

function str(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value)
}

function derive(row: EntryRow): EntryRow {
  const status = str(row, 'status') || STATUS_PENDING
  const legacy = str(row, '遗留事项')
  // 有遗留事项而状态没体现的，以事项为准重算状态（实测优先的派生口径）。
  const resolved: string = legacy && status !== STATUS_LEGACY ? STATUS_LEGACY : status
  return {
    ...row,
    status: resolved,
    pending: resolved !== STATUS_DONE,
    abnormal: resolved === STATUS_LEGACY,
    交接状态: resolved,
  }
}

/** 读：所有列表/汇总入口统一先过这道规范化，保证待交接班次读数一致。 */
export function normalizeDutyRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => derive(row))
}

function guard(row: EntryRow, action: ActionName): DutyActionResult {
  const status = str(row, 'status') || STATUS_PENDING
  const code = str(row, '交接编号')
  const team = str(row, '值班班组')
  const shift = str(row, '班次')
  const date = str(row, '值班日期')
  const label = code || `第 ${row.id} 条`

  if (!code.trim()) {
    return { ok: false, message: `${label}交接编号空着，不能${action}` }
  }
  if (!date.trim()) {
    return { ok: false, message: `${label}值班日期空着，不能${action}` }
  }
  if (!shift.trim()) {
    return { ok: false, message: `${label}班次空着，不能${action}` }
  }
  if (!isValidShift(shift)) {
    return { ok: false, message: `${label}班次「${shift}」不在白班/夜班登记口径内` }
  }
  if (!team.trim()) {
    return { ok: false, message: `${label}值班班组空着，不能${action}` }
  }

  if (action === '发起交接') {
    if (status !== STATUS_PENDING) {
      return { ok: false, message: `${label}当前是「${status}」，只有待交接的班次能发起交接` }
    }
  }
  if (action === '确认交接') {
    if (status !== STATUS_HANDOVER) {
      return { ok: false, message: `${label}当前是「${status}」，只有交接中的班次能确认交接` }
    }
    if (!str(row, '交接人员').trim()) {
      return { ok: false, message: `${label}交接人员空着，不能确认交接` }
    }
    if (!str(row, '交接事项').trim()) {
      return { ok: false, message: `${label}交接事项空着，不能确认交接` }
    }
  }
  if (action === '登记遗留') {
    if (status === STATUS_PENDING) {
      return { ok: false, message: `${label}还没发起交接，不能登记遗留` }
    }
  }
  return { ok: true, message: '' }
}

/** 写：单条动作规则，返回新行（不就地改）。legacyInput 仅登记遗留时使用。 */
export function applyDutyAction(
  rows: EntryRow[],
  id: number,
  action: ActionName,
  legacyInput?: LegacyInput,
): { rows: EntryRow[]; result: DutyActionResult; changed: EntryRow | null } {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { rows, changed: null, result: { ok: false, message: `没有找到编号为 ${id} 的值班交接记录` } }
  }
  const row = rows[index]
  const check = guard(row, action)
  if (!check.ok) {
    return { rows, changed: null, result: check }
  }

  let next: EntryRow = { ...row }
  if (action === '发起交接') {
    next = { ...next, status: STATUS_HANDOVER }
  } else if (action === '确认交接') {
    next = { ...next, status: STATUS_DONE }
  } else {
    const issue = (legacyInput?.遗留事项 ?? '').trim()
    if (!issue) {
      return { rows, changed: null, result: { ok: false, message: '遗留事项空着，不能登记遗留；缺值不拿默认值顶' } }
    }
    next = {
      ...next,
      status: STATUS_LEGACY,
      遗留事项: issue,
      交接人员: (legacyInput?.交接人员 ?? str(row, '交接人员')).trim() || str(row, '交接人员'),
    }
  }
  next = derive(next)
  const updated = [...rows]
  updated[index] = next
  return {
    rows: updated,
    changed: next,
    result: { ok: true, message: `班次${str(next, '班次')}（${str(next, '交接编号')}）已${action}，当前状态「${str(next, 'status')}」` },
  }
}

/** 汇总：待交接班次 / 已交接班次 / 有遗留事项，页面卡片与概览共用这一份读数。 */
export function dutyMetrics(rows: EntryRow[]) {
  const normalized = normalizeDutyRows(rows)
  return {
    待交接班次: normalized.filter((row) => str(row, 'status') === STATUS_PENDING).length,
    已交接班次: normalized.filter((row) => str(row, 'status') === STATUS_DONE).length,
    有遗留事项: normalized.filter((row) => str(row, '遗留事项').trim() !== '').length,
  }
}

/**
 * 存量核对：交接编号撞车 / 班次空着 / 交接人员与值班班组对不上，逐条列出缘由。
 * 核对的是页面上同一份数据，调用方保证条数一致。
 */
export function auditDutyRows(rows: EntryRow[]): AuditItem[] {
  const normalized = normalizeDutyRows(rows)
  const codeOwners = new Map<string, number>()
  const duplicated = new Set<string>()
  for (const row of normalized) {
    const code = str(row, '交接编号')
    if (!code) {
      continue
    }
    if (codeOwners.has(code)) {
      duplicated.add(code)
    } else {
      codeOwners.set(code, Number(row.id))
    }
  }

  const items: AuditItem[] = []
  for (const row of normalized) {
    const reasons: DutyIssue[] = []
    const code = str(row, '交接编号')
    const shift = str(row, '班次')
    const team = str(row, '值班班组')
    const date = str(row, '值班日期')
    const person = str(row, '交接人员')

    if (code && duplicated.has(code)) {
      reasons.push('交接编号撞车')
    }
    if (!shift.trim()) {
      reasons.push('班次空着')
    }
    if (team.trim() && person.trim()) {
      const roster = rosterOf(team)
      if (roster.length > 0 && !roster.includes(person)) {
        reasons.push('交接人员与值班班组对不上')
      }
    }
    // 排班口径一并提示（迁移以现场实测花名册重算班组，便于发现串台来源）
    if (date.trim() && isValidShift(shift) && team.trim()) {
      const expected = expectedTeam(date, shift)
      if (expected && team !== expected) {
        reasons.push('值班班组与排班不符')
      }
    }
    if (reasons.length > 0) {
      items.push({
        id: Number.isFinite(Number(row.id)) ? Number(row.id) : '',
        code: code || '（无交接编号）',
        dutyDate: date,
        shift: shift || '（空）',
        team: team || '（空）',
        handoverPerson: person || '（空）',
        reasons,
      })
    }
  }
  return items
}

/** 读待交接班次：交班页面只展示这一份结果，避免各环境口径不一。 */
export function pendingDutyRows(rows: EntryRow[]): EntryRow[] {
  return normalizeDutyRows(rows).filter((row) => str(row, 'status') === STATUS_PENDING)
}
