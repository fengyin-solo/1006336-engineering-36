import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetAll, resetRows, saveRows } from '@/data/local-store'
import {
  auditDutyRows,
  handedOverCount,
  legacyLeftCount,
  pendingHandoverCount,
  ISSUE_LABELS,
} from '@/data/duty-rules'
import {
  confirmHandover,
  registerLegacy,
  startHandover,
} from '@/api/duty-service'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 动作流转：值班交接（duty）的三个动作走领域服务（同一套读写规则、状态机与事务）；
 * 其余模块沿用通用状态机。页面不做业务判断。
 */
export function runAction(key: string, id: number, action: string, payload?: unknown): ActionResult {
  if (key === 'duty') {
    if (action === '发起交接') {
      return startHandover(id)
    }
    if (action === '确认交接') {
      const person =
        payload && typeof payload === 'object' && 'handoverPerson' in payload
          ? String((payload as { handoverPerson: unknown }).handoverPerson ?? '')
          : ''
      return confirmHandover(id, person)
    }
    if (action === '登记遗留') {
      const input = (payload ?? {}) as { items?: string; measuredDate?: string; deviceNo?: string }
      return registerLegacy(id, {
        items: String(input.items ?? ''),
        measuredDate: String(input.measuredDate ?? ''),
        deviceNo: String(input.deviceNo ?? ''),
      })
    }
    return { ok: false, message: `值班交接没有登记「${action}」这个动作` }
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

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function resetAllModules(): void {
  resetAll()
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

/** 核对清单导出：条目与页面「交接核对」表逐条一致（同一数据源、同一顺序）。 */
export function exportDutyAudit(): { filename: string; content: string } {
  const issues = auditDutyRows(listRows('duty'))
  const lines = ['记录ID,交接编号,值班日期,值班班组,问题类型,缘由']
  for (const issue of issues) {
    const cells = [
      issue.rowId,
      issue.code,
      issue.date,
      issue.team,
      ISSUE_LABELS[issue.type],
      issue.reason,
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
    lines.push(cells.join(','))
  }
  return { filename: '运维值班交接-核对清单.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadText(filename: string, content: string): void {
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

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadText(filename, content)
}

export function downloadDutyAudit(): void {
  const { filename, content } = exportDutyAudit()
  downloadText(filename, content)
}

/**
 * 模块指标：统一口径。值班交接的三张卡片与页面、导出、核对都来自同一批行、同一组谓词；
 * 其余模块沿用 pending/abnormal 标记。概览、页面统计、CSV 报表读数因此处处一致。
 */
export function moduleMetricValues(key: string): Record<string, number> {
  if (key === 'duty') {
    const rows = listRows('duty')
    return {
      待交接班次: pendingHandoverCount(rows),
      已交接班次: handedOverCount(rows),
      有遗留事项: legacyLeftCount(rows),
    }
  }
  return {}
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
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
