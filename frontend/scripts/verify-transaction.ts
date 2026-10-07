/**
 * 事务核对：落库失败时整套退回，字段不许留在中间态。
 * node 环境下用内存 localStorage，先正常播种，再让 setItem 抛错：
 * - 发起交接 / 登记遗留返回失败；
 * - localStorage 里的 JSON 与失败前逐字节一致（没有半个字段写进去）；
 * - 恢复写入能力后数据仍可正常流转，且登记遗留与设备保养台账同成同败。
 */
import { listRows } from '@/data/local-store'
import { startHandover, registerLegacy } from '@/api/duty-service'
import { auditDutyRows, legacyLeftCount } from '@/data/duty-rules'

const KEY = 'urban-utility-tunnel:entries'
const mem = new Map<string, string>()
const store: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => {
    if (failing) throw new Error('模拟磁盘写满')
    mem.set(k, v)
  },
}
;(globalThis as { window?: unknown }).window = { localStorage: store }

let failing = false
let failures = 0
function checkTrue(name: string, cond: boolean, detail = '') {
  if (!cond) {
    failures++
    console.error(`✗ ${name} ${detail}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// 触发首次播种（此时写入正常）
listRows('duty')
const before = mem.get(KEY)!
checkTrue('首次播种已落库', !!before)

// id 8：待交接 → 发起交接（失败路径）
failing = true
const r1 = startHandover(8)
checkTrue('落库失败时发起交接返回失败', r1.ok === false && r1.message.includes('整套退回'), r1.message)
checkTrue('落库失败后 localStorage 内容逐字节未变（无中间态）', mem.get(KEY) === before)

// id 8：登记遗留（单模块写，同样失败）
const r2 = registerLegacy(8, { items: '风机异响待复核', measuredDate: '2026-10-03' })
checkTrue('落库失败时登记遗留返回失败', r2.ok === false)
checkTrue('登记遗留失败后 localStorage 仍未变', mem.get(KEY) === before)

// 恢复写入：id 8 发起交接应成功，状态变为交接中
failing = false
const r3 = startHandover(8)
checkTrue('恢复后发起交接成功', r3.ok, r3.message)
checkTrue('恢复后状态=交接中', String(listRows('duty').find((r) => Number(r.id) === 8)!.status) === '交接中')

// 成功路径：登记遗留并关联设备 DEVI-0002，两边同事务落库
const snapshot = mem.get(KEY)!
failing = true
const r4 = registerLegacy(8, { items: '2 号通风机组振动超标', measuredDate: '2026-10-03', deviceNo: 'DEVI-0002' })
checkTrue('批量落库失败整套退回', r4.ok === false && mem.get(KEY) === snapshot, r4.message)
failing = false
const r5 = registerLegacy(8, { items: '2 号通风机组振动超标', measuredDate: '2026-10-03', deviceNo: 'DEVI-0002' })
checkTrue('批量落库成功（交接+设备同成同败）', r5.ok, r5.message)
const duty = listRows('duty')
const row8 = duty.find((r) => Number(r.id) === 8)!
const dev2 = listRows('device').find((r) => String(r['设备编号']) === 'DEVI-0002')!
checkTrue('交接记录状态=有遗留', String(row8.status) === '有遗留')
checkTrue('交接记录写入关联设备', String(row8['关联设备']) === 'DEVI-0002')
checkTrue('交接记录写入现场实测日期', String(row8['实测日期']) === '2026-10-03')
checkTrue('设备台账上次保养日=现场实测', String(dev2['上次保养日']) === '2026-10-03')
checkTrue('设备台账关联交接编号回填', String(dev2['关联交接']) === 'DUTY-20261002-N')
checkTrue('有遗留事项口径随之更新', legacyLeftCount(duty) === 2)
checkTrue('登记遗留不引入新核对问题', auditDutyRows(duty).length === 6, `实际 ${auditDutyRows(duty).length}`)

if (failures) {
  console.error(`\n事务核对未通过：${failures} 项失败`)
  process.exit(1)
}
console.log('\n事务核对全部通过')
