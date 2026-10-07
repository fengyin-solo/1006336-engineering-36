import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  applyDutyAction,
  auditDutyRows,
  dutyMetrics,
  normalizeDutyRows,
} from '@/data/duty-domain'
import type { ActionResult, AuditLike, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function rawModuleRows(key: string): EntryRow[] {
  // 值班交接的读也统一过领域规范化，待交接班次、遗留标记各环境一致。
  return key === 'duty' ? normalizeDutyRows(listRows(key)) : listRows(key)
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(rawModuleRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 登记遗留时的补充入参：遗留事项与交接人员都必须现场填写，不许给默认值。 */
export type DutyActionPayload = {
  legacyNote?: string
  handoverPerson?: string
}

function nextMaintenanceCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /^MAIN-(\d+)$/.exec(String(row['检修编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `MAIN-${String(max + 1).padStart(4, '0')}`
}

/**
 * 值班交接遗留事项同步登记到保养台账：同一条交接编号只维护一条台账记录，
 * 两边通过「来源交接编号」对齐；duty 与 maintenance 在同一个原子提交里落库。
 */
function syncLegacyToMaintenance(dutyRow: EntryRow): EntryRow[] {
  const rows = [...listRows('maintenance')]
  const code = String(dutyRow['交接编号'] ?? '')
  const legacy = String(dutyRow['遗留事项'] ?? '')
  const existing = rows.findIndex((row) => String(row['来源交接编号'] ?? '') === code)
  const linked: EntryRow = {
    id: existing >= 0 ? rows[existing].id : rows.length + 1,
    status: '待开工',
    pending: true,
    abnormal: false,
    检修编号: existing >= 0 ? rows[existing]['检修编号'] : nextMaintenanceCode(rows),
    检修对象: `值班交接遗留（${code}）`,
    检修类别: '遗留整改',
    检修班组: String(dutyRow['值班班组'] ?? ''),
    来源交接编号: code,
    计划工期: '',
    完工日期: '',
    更换部件: '',
    检修状态: '待开工',
    遗留内容: legacy,
  }
  if (existing >= 0) {
    rows[existing] = linked
  } else {
    rows.push(linked)
  }
  return rows
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: DutyActionPayload = {},
): ActionResult {
  // 值班交接的写全部走领域规则，页面不做业务判断。
  if (key === 'duty') {
    const dutyRows = rawModuleRows(key)
    const outcome = applyDutyAction(dutyRows, id, action as '发起交接' | '确认交接' | '登记遗留', {
      遗留事项: payload.legacyNote ?? '',
      交接人员: payload.handoverPerson ?? '',
    })
    if (!outcome.result.ok) {
      return outcome.result
    }
    const target = outcome.rows.find((row) => Number(row.id) === id)
    try {
      if (action === '登记遗留' && target) {
        // 两个模块一次提交：落库失败整套退回，不会只写一半。
        commitRows({ duty: outcome.rows, maintenance: syncLegacyToMaintenance(target) })
      } else {
        saveRows(key, outcome.rows)
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '数据落库失败，已整套退回' }
    }
    return outcome.result
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 存量核对：在页面同一份筛选结果上核对，核对条数与页面条数一致。 */
export function auditEntries(key: string, filters: Record<string, string> = {}): AuditLike[] {
  const page = listEntries(key, filters)
  if (key === 'duty') {
    return auditDutyRows(page.items)
  }
  return []
}

function currentMonth(): string {
  // 以当前系统月份为「本月」口径。
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '')
}

/**
 * 模块指标卡：页面卡片、看板汇总都从这里取数，避免页面写死 0。
 * 返回 {label, value}[]，顺序与 meta.metrics 一致。
 */
export function moduleStats(key: string, filters: Record<string, string> = {}): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = filterRows(rawModuleRows(key), filters)
  if (key === 'duty') {
    const m = dutyMetrics(rows)
    return meta.metrics.map((label) => ({ label, value: m[label as keyof typeof m] ?? 0 }))
  }
  const month = currentMonth()
  return meta.metrics.map((label) => {
    let value = 0
    if (label.includes('待')) {
      value = rows.filter((row) => String(row.status) === meta.statuses[0]).length
    } else if (label.includes('本月完工') || label.includes('本月')) {
      value = rows.filter(
        (row) => String(row.status) === '已完工' && fieldText(row, '完工日期').startsWith(month),
      ).length
    } else if (label.includes('中')) {
      value = rows.filter((row) => String(row.status) === meta.statuses[1]).length
    } else if (label.includes('正常') || label.includes('已')) {
      value = rows.filter((row) => String(row.status) === meta.statuses[2]).length
    }
    return { label, value }
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 报表导出与页面读同一份筛选结果，汇总和报表读数一致。 */
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const page = listEntries(key, filters)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of page.items) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = meta.key === 'duty' ? normalizeDutyRows(rows[meta.key] ?? []) : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
