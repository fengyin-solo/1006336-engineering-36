/**
 * 运维值班交接领域服务：发起交接 / 确认交接 / 登记遗留的唯一读写入口。
 *
 * 三步动作共用同一套校验与提交规则：
 * - 读：统一从 local-store 当前版本快照取数，待交接口径只有 pendingHandoverCount 这一份；
 * - 校验：班次字典、班组花名册、交接编号（日期+班次推导）、状态机顺序，全部来自 duty-rules；
 * - 写：统一走 commitEntries/saveRowsBatch 事务，落库失败整体回滚，不留中间态；
 * - 登记遗留若涉及设备，设备保养台账在同一事务里按现场实测日期对齐、派生状态重算。
 */

import { listRows, saveRows, saveRowsBatch } from '@/data/local-store'
import { alignDeviceLedger, DEVICE_LINK_FIELD } from '@/data/migrations'
import {
  FINAL_STATUSES,
  PENDING_HANDOVER_STATUSES,
  SHIFTS,
  STATS_BASE_DATE,
  TEAM_ROSTERS,
  auditDutyRows,
  handoverCode,
  isShift,
  isValidDate,
} from '@/data/duty-rules'
import type { ActionResult, EntryRow } from '@/data/types'

const KEY = 'duty'

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

/** 待交接班次：任何入口（页面、汇总、导出）都读这一份。 */
export function pendingDutyRows(): EntryRow[] {
  return listRows(KEY).filter((row) => PENDING_HANDOVER_STATUSES.includes(clean(row.status)))
}

export function dutyRows(): EntryRow[] {
  return listRows(KEY)
}

function refreshFlags(rows: EntryRow[]): EntryRow[] {
  const issueIds = new Set(auditDutyRows(rows).map((issue) => issue.rowId))
  return rows.map((row) => ({
    ...row,
    pending: PENDING_HANDOVER_STATUSES.includes(clean(row.status)),
    abnormal: issueIds.has(Number(row.id)) || clean(row.status) === '有遗留',
  }))
}

/** 发起交接：仅「待交接」可发起；编号/班次/班组缺失不许带病流转。 */
export function startHandover(id: number): ActionResult {
  const rows = listRows(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值班交接记录` }
  }
  if (clean(row.status) !== '待交接') {
    return { ok: false, message: `当前状态「${row.status}」不能发起交接（只有待交接可发起）` }
  }
  if (!isShift(row['班次']) || !isValidDate(row['值班日期'])) {
    return { ok: false, message: '班次或值班日期不合法，不能发起交接；请先在核对清单里核实班次' }
  }
  const expected = handoverCode(clean(row['值班日期']), clean(row['班次']) as never)
  if (clean(row['交接编号']) !== expected) {
    return { ok: false, message: `交接编号与班次对不上，应为「${expected}」，请先核实` }
  }
  const next = refreshFlags(
    rows.map((item) => (Number(item.id) === id ? { ...item, status: '交接中' } : item)),
  )
  try {
    saveRows(KEY, next)
  } catch (error) {
    return { ok: false, message: `落库失败，整套退回：${error instanceof Error ? error.message : '未知错误'}` }
  }
  return { ok: true, message: '交接已发起，当前状态「交接中」' }
}

/** 确认交接：仅「交接中」可确认；交接人员必须出自本班花名册。 */
export function confirmHandover(id: number, handoverPerson: string): ActionResult {
  const person = clean(handoverPerson)
  if (!person) {
    return { ok: false, message: '确认交接必须登记交接人员，缺值不许留空' }
  }
  const rows = listRows(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值班交接记录` }
  }
  if (clean(row.status) !== '交接中') {
    return { ok: false, message: `当前状态「${row.status}」不能确认交接（只有交接中可确认）` }
  }
  const team = clean(row['值班班组'])
  const roster = TEAM_ROSTERS[team]
  if (!roster) {
    return { ok: false, message: `值班班组「${team}」不在值班队名册内，无法确认交接` }
  }
  if (!roster.includes(person)) {
    return { ok: false, message: `交接人员「${person}」不在「${team}」花名册（${roster.join('、')}）内，不能确认` }
  }
  const next = refreshFlags(
    rows.map((item) =>
      Number(item.id) === id
        ? { ...item, status: '已交接', 交接人员: person, 交接状态: '已交接' }
        : item,
    ),
  )
  try {
    saveRows(KEY, next)
  } catch (error) {
    return { ok: false, message: `落库失败，整套退回：${error instanceof Error ? error.message : '未知错误'}` }
  }
  return { ok: true, message: '交接已确认，当前状态「已交接」' }
}

export type LegacyInput = {
  /** 遗留事项说明（必填，现场记录）。 */
  items: string
  /** 现场实测日期（YYYY-MM-DD）：涉及设备时作为保养台账的权威取值。 */
  measuredDate: string
  /** 涉及设备编号（可空）：形如 DEVI-0002；给了就两边登记对齐。 */
  deviceNo?: string
}

/**
 * 登记遗留：交接中/已交接的班次可登记；遗留事项必填、缺值不许用默认值顶。
 * 涉及设备时：交接记录（关联设备、实测日期）与设备保养台账同一事务提交，
 * 设备的上次保养日取现场实测值，派生状态按实测日重算。
 */
export function registerLegacy(id: number, input: LegacyInput): ActionResult {
  const items = clean(input.items)
  const measuredDate = clean(input.measuredDate)
  const deviceNo = clean(input.deviceNo)

  if (!items) {
    return { ok: false, message: '遗留事项必须填写现场记录，缺值不许用默认值顶' }
  }
  if (!measuredDate || !isValidDate(measuredDate)) {
    return { ok: false, message: '现场实测日期必填且应为 YYYY-MM-DD，缺值不许用默认值顶' }
  }
  if (deviceNo && !/^DEVI-\d{4}$/.test(deviceNo)) {
    return { ok: false, message: `设备编号「${deviceNo}」格式不合法（形如 DEVI-0002）` }
  }

  const rows = listRows(KEY)
  const row = findRow(rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的值班交接记录` }
  }
  const status = clean(row.status)
  if (FINAL_STATUSES.includes(status) && status !== '有遗留') {
    return { ok: false, message: '班次已交接完成且无遗留，不能再登记遗留' }
  }
  if (deviceNo && !listRows('device').some((device) => clean(device['设备编号']) === deviceNo)) {
    return { ok: false, message: `设备台账里没有「${deviceNo}」，无法两边对齐；请先核实设备编号` }
  }

  const mergedItems = deviceNo
    ? `${items}（设备 ${deviceNo}，现场实测 ${measuredDate}）`
    : `${items}（现场实测 ${measuredDate}）`

  const dutyNext = refreshFlags(
    rows.map((item) =>
      Number(item.id) === id
        ? {
            ...item,
            status: '有遗留',
            交接事项: mergedItems,
            关联设备: deviceNo,
            实测日期: measuredDate,
            交接状态: '有遗留',
          }
        : item,
    ),
  )

  // 设备台账对齐：以现场实测为准重算，同事务提交（同成同败）。
  const deviceNext = alignDeviceLedger(listRows('device'), dutyNext, STATS_BASE_DATE).rows

  try {
    saveRowsBatch({ [KEY]: dutyNext, device: deviceNext })
  } catch (error) {
    return { ok: false, message: `落库失败，整套退回：${error instanceof Error ? error.message : '未知错误'}` }
  }

  return {
    ok: true,
    message: deviceNo
      ? `遗留已登记（状态「有遗留」），设备 ${deviceNo} 已按实测日期 ${measuredDate} 同步到保养台账`
      : `遗留已登记，当前状态「有遗留」（现场实测 ${measuredDate}）`,
  }
}

export { SHIFTS, DEVICE_LINK_FIELD }
