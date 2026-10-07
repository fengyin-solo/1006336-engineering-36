/**
 * 启动迁移冒烟：localStorage 里预置 v1 旧库（无版本信封），
 * 首次读取应自动迁移为 v2 信封；之后再次读取不重复迁移、不新增班次。
 */
const KEY = 'urban-utility-tunnel:entries'
const mem = new Map<string, string>()
const store: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, v) },
}
;(globalThis as { window?: unknown }).window = { localStorage: store }

// 预置一份 v1 旧库（旧种子结构：duty 三条占位行 + tunnel 占位行）
mem.set(KEY, JSON.stringify({
  duty: [
    { id: 1, status: '待交接', pending: true, abnormal: false, 交接编号: 'DUTY-0001', 值班班组: '运维值班交接样例1', 值班日期: '2026-09-01', 班次: '运维值班交接样例1', 值班人员: '运维值班交接样例1', 交接事项: '运维值班交接样例1', 交接人员: '运维值班交接样例1', 交接状态: '运维值班交接样例1' },
    { id: 2, status: '交接中', pending: true, abnormal: true, 交接编号: 'DUTY-0002', 值班班组: '运维值班交接样例2', 值班日期: '2026-09-02', 班次: '运维值班交接样例2', 值班人员: '运维值班交接样例2', 交接事项: '运维值班交接样例2', 交接人员: '运维值班交接样例2', 交接状态: '运维值班交接样例2' },
    { id: 3, status: '已交接', pending: false, abnormal: false, 交接编号: 'DUTY-0003', 值班班组: '运维值班交接样例3', 值班日期: '2026-09-03', 班次: '运维值班交接样例3', 值班人员: '运维值班交接样例3', 交接事项: '运维值班交接样例3', 交接人员: '运维值班交接样例3', 交接状态: '运维值班交接样例3' },
  ],
  tunnel: [
    { id: 1, status: '待投运', pending: true, abnormal: false, 管廊编号: 'TUNN-0001', 管廊名称: '管廊主体台账样例1', 所属片区: '管廊主体台账样例1', 舱室数量: 10, 总长度: '管廊主体台账样例1', 结构类型: '管廊主体台账样例1', 投运日期: '2026-09-01', 管廊状态: '管廊主体台账样例1' },
  ],
}))

const { allRows, dataVersion, listRows } = await import('@/data/local-store')
const { pendingHandoverCount, legacyLeftCount } = await import('@/data/duty-rules')

let failures = 0
function checkTrue(name: string, cond: boolean, detail = '') {
  if (!cond) { failures++; console.error(`✗ ${name} ${detail}`) } else console.log(`✓ ${name}`)
}

checkTrue('旧库读取后升级为 v2', dataVersion() === 2)
const duty = listRows('duty')
checkTrue('占位旧行被权威种子替换（无 DUTY-0001）', !duty.some((r) => r['交接编号'] === 'DUTY-0001'))
checkTrue('权威班次齐全（14 条）', duty.length === 14, `实际 ${duty.length}`)
checkTrue('待交接班次=4', pendingHandoverCount(duty) === 4, `实际 ${pendingHandoverCount(duty)}`)
checkTrue('有遗留事项=1', legacyLeftCount(duty) === 1)

const persisted = JSON.parse(mem.get(KEY)!)
checkTrue('落库结构带 version=2', persisted.version === 2)
checkTrue('落库含迁移留痕', Array.isArray(persisted.dutyNotes) && persisted.dutyNotes.length >= 4)

// 模拟换台机器 / 刷新：再读一次（清模块缓存由进程隔离无法模拟，改为直接复用快照读）
const again = allRows().duty
checkTrue('再次读取记录数不变（不重复迁移）', again.length === 14)
checkTrue('再次读取与首次内容一致', JSON.stringify(again) === JSON.stringify(duty))

if (failures) { console.error(`\n迁移冒烟未通过：${failures} 项`); process.exit(1) }
console.log('\n启动迁移冒烟全部通过')
