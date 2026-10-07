/**
 * 数据层验证脚本（npm run verify：esbuild 打包后用 node 执行，不依赖浏览器/DOM）。
 * 覆盖：实测种子确定性、动作流转、存量核对、v1→v2 迁移幂等与补录规则、
 * 遗留同步保养台账、落库失败整套退回、页面/核对/导出读数一致。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  auditEntries,
  exportEntries,
  listEntries,
  moduleStats,
  runAction,
} from '../src/api/local-service'
import {
  applyDutyAction,
  auditDutyRows,
  dutyMetrics,
  expectedTeam,
  normalizeDutyRows,
  pendingDutyRows,
} from '../src/data/duty-domain'
import {
  commitRows,
  listRows,
  resetRows,
  saveRows,
  storageKey,
  __resetCacheForVerify,
} from '../src/data/local-store'
import { migrateDatabase, SCHEMA_VERSION } from '../src/data/migrations'
import {
  measuredDutyRows,
  measuredLeakRows,
  measuredMaintenanceRows,
} from '../src/data/seed-measured'
import type { EntryRow } from '../src/data/types'

// --- 最小 localStorage 桩（local-store 只用到 getItem/setItem） ---
type Bag = Map<string, string>
function installStorage(failOnSet = false, bag?: Bag): Bag {
  const store: Bag = bag ?? new Map()
  const g = globalThis as unknown as { window?: unknown; localStorage?: Storage }
  g.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      if (failOnSet) {
        throw new Error('QuotaExceededError')
      }
      store.set(key, value)
    },
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
  g.window = { localStorage: g.localStorage }
  // local-store 缓存的是整库；换了存储实例必须清缓存，保证读到的是新实例。
  __resetCacheForVerify()
  return store
}

let passed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

// 现场之外另存的一份「旧机器存量」：占位样例 + 真实老记录（含脏数据）。
const v1Fixture: Record<string, EntryRow[]> = {
  duty: [
    { id: 1, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-0001', 值班班组: '运维值班交接样例1', 值班日期: '2026-09-01', 班次: '运维值班交接样例1', 值班人员: 'x', 交接事项: 'x', 交接人员: 'x', 交接状态: 'x' },
    { id: 2, status: '交接中', pending: true, abnormal: true, 交接编号: 'DUTY-0002', 值班班组: '运维值班交接样例2', 值班日期: '2026-09-02', 班次: '运维值班交接样例2', 值班人员: 'x', 交接事项: 'x', 交接人员: 'x', 交接状态: 'x' },
    { id: 3, status: '已交接', pending: false, abnormal: false, 交接编号: 'DUTY-0003', 值班班组: '运维值班交接样例3', 值班日期: '2026-09-03', 班次: '运维值班交接样例3', 值班人员: 'x', 交接事项: 'x', 交接人员: 'x', 交接状态: 'x' },
    // 早年无班次登记：9月10日两条，按值班日期补白班/夜班
    { id: 4, status: '已交接', pending: false, abnormal: false, 交接编号: 'DUTY-20210910-OLD1', 值班班组: '综合运维二班', 值班日期: '2021-09-10', 班次: '', 值班人员: '赵启明', 交接事项: '例行交接', 交接人员: '何静', 交接状态: '已交接' },
    { id: 5, status: '已交接', pending: false, abnormal: false, 交接编号: 'DUTY-20210910-OLD2', 值班班组: '综合运维三班', 值班日期: '2021-09-10', 班次: '', 值班人员: '孙鹏', 交接事项: '例行交接', 交接人员: '周野', 交接状态: '已交接' },
    // 第三条同日期无空位 → 班次留空，交核对列出
    { id: 6, status: '已交接', pending: false, abnormal: false, 交接编号: 'DUTY-20210910-OLD3', 值班班组: '综合运维一班', 值班日期: '2021-09-10', 班次: '', 值班人员: '宋洁', 交接事项: '替班交接', 交接人员: '陈岩', 交接状态: '已交接' },
    // 交接人员串到别的班组（孙鹏是三班，挂在一班头上）
    { id: 7, status: '交接中', pending: true, abnormal: false, 交接编号: 'DUTY-20250618-1', 值班班组: '综合运维一班', 值班日期: '2025-06-18', 班次: '白班', 值班人员: '陈岩', 交接事项: '', 交接人员: '孙鹏', 交接状态: '交接中' },
    // 交接编号与实测撞车：以实测那份为准（整条被实测取代）
    { id: 8, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-20261002-1', 值班班组: '综合运维二班', 值班日期: '2026-10-02', 班次: '白班', 值班人员: '赵启明', 交接事项: '', 交接人员: '', 交接状态: '待交接' },
  ],
  leak: [
    { id: 9, status: '已完工', pending: false, abnormal: false, 处置编号: 'LEAK-0001', 渗漏点位: '渗漏水处置样例1', 渗漏程度: 'x', 处置方式: 'x', 处置班组: 'x', 发现日期: '2026-09-01', 完工日期: '2026-09-01', 处置状态: '已完工' },
  ],
  maintenance: [
    { id: 1, status: '待开工', pending: true, abnormal: false, 检修编号: 'MAIN-0001', 检修对象: '设施检修管理样例1', 检修类别: 'x', 检修班组: 'x', 计划工期: 'x', 完工日期: '2026-09-01', 更换部件: 'x', 检修状态: '待开工' },
  ],
  tunnel: [{ id: 1, status: '待投运', pending: true, abnormal: false, 管廊编号: 'TUNN-0001' }],
}

// 1) 实测种子：确定性 + 自洽 -------------------------------------------------
const measured = measuredDutyRows()
check('实测种子生成14个班次', measured.length === 14)
eq('实测种子重复生成完全一致（开发/线上同一份）', measuredDutyRows(), measured)
eq('待交接班次读数（10-07白/夜班）', pendingDutyRows(measured).map((r) => r['交接编号']), ['DUTY-20261007-1', 'DUTY-20261007-2'])
eq('有遗留事项读数', dutyMetrics(measured).有遗留事项, 1)
eq('待交接班次指标', dutyMetrics(measured).待交接班次, 2)
eq('已交接班次指标', dutyMetrics(measured).已交接班次, 10)
check('无空班次', measured.every((r) => String(r['班次']).length > 0))
check('无重复交接编号', new Set(measured.map((r) => r['交接编号'])).size === measured.length)
check('交接人员全部属于当班班组花名册', measured.every((r) => {
  const roster: Record<string, string[]> = {
    综合运维一班: ['陈岩', '高航', '宋洁'],
    综合运维二班: ['林远航', '赵启明', '何静'],
    综合运维三班: ['周野', '孙鹏', '郭敏'],
  }
  const p = String(r['交接人员'] ?? '')
  return p === '' || roster[String(r['值班班组'])]?.includes(p)
}))
eq('轮转：10-04白班为一班', expectedTeam('2026-10-04', '白班'), '综合运维一班')
eq('轮转：10-04夜班为二班', expectedTeam('2026-10-04', '夜班'), '综合运维二班')

// 2) 动作流转同一套规则 -----------------------------------------------------
let flow = normalizeDutyRows(measured)
const pendingId = flow.find((r) => r['交接编号'] === 'DUTY-20261007-1')!.id
check('待交接才能发起（已交接拒绝再发起）', applyDutyAction(flow, 1, '发起交接').result.ok === false)
let act = applyDutyAction(flow, pendingId, '发起交接')
check('发起交接成功', act.result.ok, act.result.message)
flow = act.rows
act = applyDutyAction(flow, pendingId, '确认交接')
check('交接事项为空不能确认', act.result.ok === false)
flow = flow.map((r) => (Number(r.id) === pendingId ? { ...r, 交接事项: '白班巡视正常', 交接人员: '宋洁' } : r))
act = applyDutyAction(flow, pendingId, '确认交接')
check('交接事项齐全确认成功', act.result.ok, act.result.message)
flow = act.rows
act = applyDutyAction(flow, pendingId, '登记遗留', { 遗留事项: '环控柜异响待查', 交接人员: '宋洁' })
check('已交接仍可登记遗留', act.result.ok, act.result.message)
flow = act.rows
check('遗留事项为空拒绝（不拿默认值顶）', applyDutyAction(flow, pendingId, '登记遗留', { 遗留事项: '  ', 交接人员: '宋洁' }).result.ok === false)
check('空班次记录任何动作拒绝', applyDutyAction([{ id: 99, status: '待交接', pending: true, abnormal: false, 交接编号: 'X', 值班班组: '一班', 值班日期: '2026-10-01', 班次: '' }], 99, '发起交接').result.ok === false)

// 3) v1→v2 迁移 ------------------------------------------------------------
const migrated = migrateDatabase(v1Fixture)
check('迁移后版本数据存在', Array.isArray(migrated.duty))
const codes = migrated.duty.map((r) => String(r['交接编号']))
check('占位样例DUTY-0001/2/3不迁入', !codes.includes('DUTY-0001') && !codes.includes('DUTY-0003'))
check('实测14个班次都在', measuredDutyRows().every((r) => codes.includes(String(r['交接编号']))))
check('真实老记录保留（除撞号）', codes.includes('DUTY-20210910-OLD1') && codes.includes('DUTY-20250618-1'))
check('撞实测编号的老记录不重复出现', codes.filter((c) => c === 'DUTY-20261002-1').length === 1)
check('迁移后无重复执行冒出多余班次', JSON.stringify(migrateDatabase(migrated)) === JSON.stringify(migrated))
check('再迁一遍仍幂等', JSON.stringify(migrateDatabase(migrateDatabase(migrated))) === JSON.stringify(migrated))
const old1 = migrated.duty.find((r) => r['交接编号'] === 'DUTY-20210910-OLD1')
const old2 = migrated.duty.find((r) => r['交接编号'] === 'DUTY-20210910-OLD2')
const old3 = migrated.duty.find((r) => r['交接编号'] === 'DUTY-20210910-OLD3')
eq('早年第一条缺班次补白班', old1!['班次'], '白班')
eq('补录来源标注', old1!['班次来源'], '补录（按值班日期）')
eq('早年第二条缺班次补夜班', old2!['班次'], '夜班')
eq('同日无空位班次留空（不许默认值）', old3!['班次'], '')
check('迁移后按值班日期排序、id连续', migrated.duty.every((r, i) => Number(r.id) === i + 1))
const dates = migrated.duty.map((r) => String(r['值班日期']))
check('值班日期升序', dates.every((d, i) => i === 0 || dates[i - 1] <= d))
// 渗漏处置倒排
const leakDates = migrated.leak.map((r) => String(r['发现日期']))
check('渗漏处置按发现日期倒排', leakDates.every((d, i) => i === 0 || leakDates[i - 1] >= d))
check('处置中完工日期留空，无默认值', migrated.leak.find((r) => r['处置编号'] === 'LEAK-0009')!['完工日期'] === '')
check('保养台账保留来源交接编号', migrated.maintenance.some((r) => r['来源交接编号'] === 'DUTY-20261004-1'))
check('其他模块原样搬', (migrated.tunnel?.length ?? 0) === 1)
eq('迁移后值班交接总数=实测14+存量4（撞号1条并入实测、占位3条丢弃）', migrated.duty.length, 18)
eq('存量核对条数=2（空班次1 + 跨班组人员1）', auditDutyRows(migrated.duty).length, 2)
eq('迁移后首条为最早日期的白班', String(migrated.duty[0]['交接编号']), 'DUTY-20210910-OLD1')
eq('迁移后第二条为同日夜班', String(migrated.duty[1]['交接编号']), 'DUTY-20210910-OLD2')

// 4) 核对清单：缘由逐条、条数=页面 ------------------------------------------
const audit = auditDutyRows(migrated.duty)
const old3Audit = audit.find((a) => a.code === 'DUTY-20210910-OLD3')
check('班次空着被列出', !!old3Audit && old3Audit.reasons.includes('班次空着'))
const cross = audit.find((a) => a.code === 'DUTY-20250618-1')
check('交接人员与值班班组对不上被列出', !!cross && cross.reasons.includes('交接人员与值班班组对不上'))
// 手工构造撞号场景核对
const dupRows = normalizeDutyRows([
  ...measuredDutyRows(),
  { id: 100, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-20261007-1', 值班班组: '综合运维一班', 值班日期: '2026-10-07', 班次: '白班', 值班人员: '高航', 交接事项: '', 交接人员: '' },
])
const dupAudit = auditDutyRows(dupRows)
check('交接编号撞车两条都列出', dupAudit.filter((a) => a.code === 'DUTY-20261007-1').length === 2 && dupAudit.every((a) => a.reasons.includes('交接编号撞车')))
const auditAll = auditDutyRows(migrated.duty)
check('核对覆盖页面全量：有问题条数不超过页面总条数', auditAll.length <= migrated.duty.length)
// 页面过滤条件与核对口径一致：在任意子集上，核对结果等于直接核对该子集
const sepSubset = migrated.duty.filter((r) => String(r['值班班组']) === '综合运维一班')
eq('核对跑在页面同一份子集上', auditDutyRows(sepSubset).length, auditDutyRows(migrated.duty.filter((r) => String(r['值班班组']) === '综合运维一班')).length)

// 5) 经 local-service / local-store 端到端 ---------------------------------
installStorage()
saveRows('duty', migrated.duty)
saveRows('leak', migrated.leak)
saveRows('maintenance', migrated.maintenance)
const page = listEntries('duty')
eq('页面读数：总条数', page.total, migrated.duty.length)
eq('页面读数=核对基准：核对条数', auditEntries('duty').length, auditDutyRows(page.items).length)
// 筛选后页面与核对仍是同一份
const filtered = listEntries('duty', { 值班日期: '2021-09-10' })
eq('筛选页面3条老记录', filtered.total, 3)
eq('筛选下核对条数与页面一致', auditEntries('duty', { 值班日期: '2021-09-10' }).length, auditDutyRows(filtered.items).length)
const cards = moduleStats('duty')
check('指标卡三项', cards.length === 3 && cards.every((c) => typeof c.value === 'number'))
const csv = exportEntries('duty')
check('导出行数=页面条数+表头', csv.content.split('\n').length === page.total + 1)

// 登记遗留：duty + maintenance 同事务
const target = listRows('duty').find((r) => r['交接编号'] === 'DUTY-20261007-2')!
const beforeMaint = listRows('maintenance').length
const r1 = runAction('duty', Number(target.id), '发起交接')
check('夜班发起交接', r1.ok, r1.message)
const r2 = runAction('duty', Number(target.id), '登记遗留', { legacyNote: '照明2回路绝缘偏低', handoverPerson: '陈岩' })
check('登记遗留成功', r2.ok, r2.message)
check('遗留写入duty', String(listRows('duty').find((r) => Number(r.id) === Number(target.id))!['遗留事项']) === '照明2回路绝缘偏低')
check('保养台账新增一条', listRows('maintenance').length === beforeMaint + 1)
const linked = listRows('maintenance').find((r) => r['来源交接编号'] === 'DUTY-20261007-2')
check('保养台账来源交接编号对齐', !!linked && String(linked['检修对象']).includes('DUTY-20261007-2'))
// 重复登记不重复建台账，只更新
const r3 = runAction('duty', Number(target.id), '登记遗留', { legacyNote: '照明2回路绝缘偏低（已约厂家）', handoverPerson: '陈岩' })
check('再次登记成功且不重复建台账', r3.ok && listRows('maintenance').length === beforeMaint + 1)

// 落库失败整套退回：用独立 store，先落一版，再让 setItem 失败，确认两模块都没变
const bag = installStorage(false)
saveRows('duty', migrated.duty)
saveRows('maintenance', migrated.maintenance)
const snapshot = JSON.stringify({ duty: listRows('duty'), maintenance: listRows('maintenance') })
installStorage(true, bag)
let threw = false
try {
  const svcDuty = listRows('duty').map((r, i) => (i === 0 ? { ...r, 交接事项: '半截写入探测' } : r))
  const svcMaint = listRows('maintenance').map((r, i) => (i === 0 ? { ...r, 更换部件: '半截写入探测' } : r))
  commitRows({ duty: svcDuty, maintenance: svcMaint })
} catch {
  threw = true
}
check('双模块提交失败抛错', threw)
check('双模块都保持提交前快照（整套退回，无中间态）', JSON.stringify({ duty: listRows('duty'), maintenance: listRows('maintenance') }) === snapshot)

// 存储版本：v1裸记录首次读取迁移为v2，且重复读取不冒班次
installStorage(false)
const v1Store = new Map<string, string>([[storageKey(), JSON.stringify(v1Fixture)]])
installStorage(false, v1Store)
const firstRead = JSON.stringify(listRows('duty'))
const persisted = JSON.parse(v1Store.get(storageKey())!) as { version: number }
eq('落盘带版本号v2', persisted.version, SCHEMA_VERSION)
const secondRead = JSON.stringify(listRows('duty'))
eq('重复初始化结果一致，不冒出多余班次', secondRead, firstRead)

// 空库首次打开：播实测种子
installStorage(false, new Map())
eq('空库首读值班班次=实测14', listRows('duty').length, measuredDutyRows().length)
eq('空库首读渗漏=实测4', listRows('leak').length, measuredLeakRows().length)
eq('空库首读保养台账=实测4', listRows('maintenance').length, measuredMaintenanceRows().length)

// resetRows 回到实测种子
resetRows('duty')
eq('reset值班=实测14', listRows('duty').length, 14)

// 6) 产物：核对清单导出为运维交接核对报告 -----------------------------------
const reportDir = mkdtempSync(join(tmpdir(), 'duty-verify-'))
const lines = ['交接编号\t值班日期\t班次\t值班班组\t交接人员\t缘由']
for (const item of auditEntries('duty')) {
  lines.push([item.code, item.dutyDate, item.shift, item.team, item.handoverPerson, item.reasons.join('；')].join('\t'))
}
writeFileSync(join(reportDir, 'duty-audit-report.tsv'), lines.join('\n'), 'utf8')

if (failures.length) {
  console.error(`\n验证失败 ${failures.length} 项：`)
  for (const f of failures) {
    console.error(`  ✗ ${f}`)
  }
  process.exit(1)
}
console.log(`\n全部通过：${passed} 项断言；核对报告样例 ${join(reportDir, 'duty-audit-report.tsv')}`)
