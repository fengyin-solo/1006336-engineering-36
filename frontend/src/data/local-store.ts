import { buildSeedBundle, migrateV1ToV2, DATA_VERSION } from './migrations'
import type { EntryRow } from './types'
import type { DutyMigrationNote } from './migrations'

/**
 * 本地持久化（v2，版本化信封）。
 *
 * 信封：{ version, entries, dutyNotes }
 * - 首次打开：直接播种当前权威种子（buildSeedBundle），任何机器、dev/线上同一份；
 * - 旧版本地库（v1：localStorage 里直接铺的 Record<string, EntryRow[]>）：启动时一次性
 *   迁移到 v2（migrateV1ToV2），迁移按自然键合并，重复执行不新增班次；
 * - 写入只认 commitEntries：先整体序列化再写 localStorage，序列化或落库抛错时缓存不动、
 *   现场数据原样保留 —— 落库失败整套退回，字段不许留在中间态。
 */

const STORAGE_KEY = 'urban-utility-tunnel:entries'

export type StoreEnvelope = {
  version: number
  entries: Record<string, EntryRow[]>
  /** 值班交接迁移留痕（早年缺班次补登、编号重算），随迁移一次性写入，页面只读展示。 */
  dutyNotes: DutyMigrationNote[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshEnvelope(): StoreEnvelope {
  const bundle = buildSeedBundle()
  return { version: bundle.version, entries: bundle.entries, dutyNotes: bundle.dutyNotes }
}

/** v1 库特征：没有 version 信封，解析出来直接是模块数组字典。 */
function isV1Shape(parsed: unknown): parsed is Record<string, EntryRow[]> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const obj = parsed as Record<string, unknown>
  return !('version' in obj) && Object.values(obj).every((value) => Array.isArray(value))
}

function readStorage(): StoreEnvelope {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshEnvelope()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshEnvelope()
    tryCommit(seeded)
    return seeded
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 内容损坏不猜不补：回到权威种子（旧库已无法解析，不存在可保留的真实登记行）。
    const seeded = freshEnvelope()
    tryCommit(seeded)
    return seeded
  }

  if (isV1Shape(parsed)) {
    // 旧版本地库：一次性版本化迁移；落库失败则本次会话用迁移结果运行，不影响读写。
    const bundle = migrateV1ToV2(parsed)
    const envelope: StoreEnvelope = {
      version: bundle.version,
      entries: bundle.entries,
      dutyNotes: bundle.dutyNotes,
    }
    tryCommit(envelope)
    return envelope
  }

  const envelope = parsed as StoreEnvelope
  if (envelope.version !== DATA_VERSION) {
    // 预留：以后再有版本升级，在这里接续迁移；当前只有 v2，落到同版本权威种子。
    const seeded = freshEnvelope()
    tryCommit(seeded)
    return seeded
  }
  return envelope
}

/** 启动期播种/迁移落库：存储不可用时不阻断应用（本次会话使用内存快照）。 */
function tryCommit(envelope: StoreEnvelope): void {
  try {
    commitToStorage(envelope)
  } catch {
    // 忽略：后续业务写入仍会尝试落库，失败会按事务规则整套退回并提示页面。
  }
}

/** 直接写 localStorage（供启动播种/迁移用）；失败时抛出，由调用方决定如何兜底。 */
function commitToStorage(envelope: StoreEnvelope): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先序列化：序列化失败不会触碰既有数据。
  const serialized = JSON.stringify(envelope)
  window.localStorage.setItem(STORAGE_KEY, serialized)
}

let cache: StoreEnvelope | null = null

function snapshot(): StoreEnvelope {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return snapshot().entries
}

export function listRows(key: string): EntryRow[] {
  return snapshot().entries[key] ?? []
}

/**
 * 事务提交：接收「基于当前快照产出下一版信封」的纯函数，先序列化再落库。
 * 任一步失败：缓存保持旧值并抛错，调用方向页面返回失败，不产生部分字段已落库的中间态。
 */
export function commitEntries(
  produce: (entries: Record<string, EntryRow[]>) => Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const current = snapshot()
  const draftEntries = produce(clone(current.entries))
  const next: StoreEnvelope = {
    version: DATA_VERSION,
    entries: draftEntries,
    dutyNotes: current.dutyNotes,
  }
  const serialized = JSON.stringify(next) // 先序列化：失败则缓存不动（整套退回）
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized) // 落库失败同样不更新缓存
  }
  cache = next
  return next.entries
}

/** 单模块保存：走统一事务。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  commitEntries((entries) => ({ ...entries, [key]: rows }))
}

/** 多模块一起保存（如登记遗留要同时写交接记录与设备保养台账）：同一事务，同成同败。 */
export function saveRowsBatch(patch: Record<string, EntryRow[]>): void {
  commitEntries((entries) => ({ ...entries, ...patch }))
}

export function resetRows(key: string): EntryRow[] {
  const seeded = freshEnvelope().entries[key] ?? []
  saveRows(key, clone(seeded))
  return listRows(key)
}

/** 整套重新初始化：幂等，反复执行都收敛到权威种子，不会冒出多余班次。 */
export function resetAll(): Record<string, EntryRow[]> {
  const seeded = freshEnvelope()
  commitToStorage(seeded)
  cache = seeded
  return seeded.entries
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function dataVersion(): number {
  return snapshot().version
}

export function dutyMigrationNotes(): DutyMigrationNote[] {
  return clone(snapshot().dutyNotes)
}
