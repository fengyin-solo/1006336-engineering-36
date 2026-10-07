/**
 * 数据层核对脚本：node 环境下用内存 localStorage 跑完整链路。
 * 运行：npm run verify（经 esbuild 按 vite 的 @ 别名打包后执行）。
 * 断言失败立即非零退出，供 CI / 部署前核对。
 */
import { buildSeedBundle, migrateV1ToV2, isPlaceholderRow } from '@/data/migrations'
import { auditDutyRows, handoverCode, pendingHandoverCount, handedOverCount, legacyLeftCount, ISSUE_LABELS } from '@/data/duty-rules'
import { CANONICAL_DUTY_ROWS } from '@/data/duty-seed'
import type { EntryRow } from '@/data/types'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`✗ ${name}\n  期望 ${e}\n  实际 ${a}`)
  } else {
    console.log(`✓ ${name}`)
  }
}
function checkTrue(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.error(`✗ ${name} ${detail}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// ── 1. 编号规则确定性：样例按交接编号与班次生成 ──
check('交接编号=日期+班次推导（白班）', handoverCode('2026-10-01', '白班'), 'DUTY-20261001-D')
check('交接编号=日期+班次推导（夜班）', handoverCode('2024-03-12', '夜班'), 'DUTY-20240312-N')

// ── 2. 种子：本地与线上同一份，读数确定 ──
const s1 = buildSeedBundle()
const s2 = buildSeedBundle()
check('种子构建确定性（重复构建完全一致）', s2, s1)
const duty = s1.entries.duty

check('交接记录总数（8 现行 + 6 早年存量）', duty.length, 14)
check('待交接班次口径（待交接+交接中）', pendingHandoverCount(duty), 4)
check('已交接班次口径', handedOverCount(duty), 9)
check('有遗留事项口径', legacyLeftCount(duty), 1)
check('口径合计=总数', pendingHandoverCount(duty) + handedOverCount(duty) + legacyLeftCount(duty), 14)

// ── 3. 存量按值班日期迁移（升序落位） ──
const dates = duty.map((r) => String(r['值班日期']))
check('存量按值班日期升序迁移', dates, [...dates].sort())

// 早年缺班次补登结果
const byId = new Map(duty.map((r) => [Number(r.id), r]))
check('102 偶数日补夜班', byId.get(102)!['班次'], '夜班')
check('102 编号按日期班次重算', byId.get(102)!['交接编号'], 'DUTY-20240312-N')
check('103 奇数日补白班', byId.get(103)!['班次'], '白班')
check('104 旧叫法「早班」按奇数日补白班', byId.get(104)!['班次'], '白班')
check('105 偶数日补夜班', byId.get(105)!['班次'], '夜班')
check('2025 年后缺班次不补、不拿默认值顶', byId.get(106)!['班次'], '')

// ── 4. 核对清单：逐条缘由，分类计数，总数对得上 ──
const issues = auditDutyRows(duty)
const byType = (t: string) => issues.filter((i) => i.type === t)
check('核对问题总数', issues.length, 6)
check('交接编号撞车条数', byType('duplicate-code').length, 2)
check('班次空着条数', byType('shift-empty').length, 1)
check('人员与班组对不上条数', byType('personnel-mismatch').length, 3)
checkTrue(
  '撞车记录为 103/104 同号 DUTY-20240313-D',
  byType('duplicate-code').map((i) => i.rowId).join(',') === '103,104' &&
    byType('duplicate-code').every((i) => i.code === 'DUTY-20240313-D'),
)
checkTrue('每条问题都带缘由', issues.every((i) => i.reason.length > 10))
checkTrue(
  '问题类型标签齐全',
  [...new Set(issues.map((i) => i.type))].every((t) => ISSUE_LABELS[t as keyof typeof ISSUE_LABELS]),
)

// ── 5. 重复初始化幂等：不会冒出多余班次 ──
const s3 = buildSeedBundle()
check('再次初始化记录数不变', s3.entries.duty.length, duty.length)
check('再次初始化编号集合不变', s3.entries.duty.map((r) => r['交接编号']).sort(), duty.map((r) => r['交接编号']).sort())

// ── 6. 两边对齐：遗留涉及设备 → 保养台账以现场实测为准 ──
const dev = new Map(s1.entries.device.map((r) => [String(r['设备编号']), r]))
const d2 = dev.get('DEVI-0002')!
check('DEVI-0002 上次保养日=现场实测日', d2['上次保养日'], '2026-10-01')
check('DEVI-0002 关联交接编号', d2['关联交接'], 'DUTY-20261001-D')
check('DEVI-0002 状态按实测日重算（30 天周期内→已保养）', d2.status, '已保养')
check('DEVI-0002 pending 随状态重算', d2.pending, false)
check('未涉及遗留的设备不被改动', dev.get('DEVI-0001')!['上次保养日'], '2026-08-20')

// ── 7. 渗漏老记录按发现日期倒排补录，缺值不补默认 ──
const leakIds = s1.entries.leak.map((r) => Number(r.id))
check('渗漏处置按发现日期倒排', leakIds, [2, 1, 3, 201, 202, 203])
const leak202 = s1.entries.leak.find((r) => Number(r.id) === 202)!
const leak203 = s1.entries.leak.find((r) => Number(r.id) === 203)!
check('早年缺处置方式保留空值', leak202['处置方式'], '')
check('早年缺渗漏程度保留空值', leak203['渗漏程度'], '')

// ── 8. v1 旧库迁移：占位行替换、真实行保留、同编号不新增班次 ──
const legacyStore: Record<string, EntryRow[]> = {
  duty: [
    // 模拟旧版占位行（机器生成、将被权威种子整批替换）
    { id: 1, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-0001', 值班班组: '运维值班交接样例1', 值班日期: '2026-09-01', 班次: '运维值班交接样例1', 值班人员: '运维值班交接样例1', 交接事项: '运维值班交接样例1', 交接人员: '运维值班交接样例1', 交接状态: '运维值班交接样例1' },
    // 真实登记行（无占位特征）：新编号应保留并入
    { id: 9001, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-20261003-D', 值班班组: '综合运维二班', 值班日期: '2026-10-03', 班次: '白班', 值班人员: '陈志强', 交接事项: '迁移联调新增班次', 交接人员: '', 交接状态: '待交接' },
    // 真实登记行：与权威种子撞编号 → 不新增班次
    { id: 9002, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-20261001-D', 值班班组: '机电保障三班', 值班日期: '2026-10-01', 班次: '白班', 值班人员: '孙卫民', 交接事项: '重复班次', 交接人员: '', 交接状态: '待交接' },
  ],
  tunnel: [
    { id: 1, status: '待投运', pending: true, abnormal: false, 管廊编号: 'TUNN-0001', 管廊名称: '管廊主体台账样例1', 所属片区: '管廊主体台账样例1', 舱室数量: 10, 总长度: '管廊主体台账样例1', 结构类型: '管廊主体台账样例1', 投运日期: '2026-09-01', 管廊状态: '管廊主体台账样例1' },
  ],
}
const migrated = migrateV1ToV2(legacyStore)
const mIds = new Map(migrated.entries.duty.map((r) => [Number(r.id), r]))
check('v1 占位行被权威种子替换（不存在 DUTY-0001）', migrated.entries.duty.some((r) => r['交接编号'] === 'DUTY-0001'), false)
check('v1 真实新班次保留', mIds.has(9001), true)
check('v1 撞编号班次不新增（9002 不入）', mIds.has(9002), false)
check('v1 迁移幂等：再迁一遍记录数不变', migrateV1ToV2(legacyStore).entries.duty.length, migrated.entries.duty.length)
const migratedIssues = auditDutyRows(migrated.entries.duty)
checkTrue('迁移后新班次不产生新问题', migratedIssues.length === 6, `实际 ${migratedIssues.length} 条`)

// ── 9. 现行种子自身不应有人为人员错配（除早年存量外） ──
const canonicalIds = new Set(CANONICAL_DUTY_ROWS.map((r) => Number(r.id)))
check(
  '现行排程无人员错配',
  auditDutyRows(CANONICAL_DUTY_ROWS).filter((i) => i.type === 'personnel-mismatch').length,
  0,
)
checkTrue('现行排程无撞号', auditDutyRows(CANONICAL_DUTY_ROWS).filter((i) => i.type === 'duplicate-code').length === 0)
void byType
void isPlaceholderRow
void canonicalIds

if (failures) {
  console.error(`\n核对未通过：${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部核对通过')
