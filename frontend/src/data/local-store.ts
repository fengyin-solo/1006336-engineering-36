import { SEED_ROWS } from './seed'
import { SCHEMA_VERSION, freshV2Entries, migrateDatabase } from './migrations'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

/** v2 起整库带版本号：{ version, entries }；v1 是裸 Record，首次读取时迁移。 */
export type Database = {
  version: number
  entries: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalSeed(): Record<string, EntryRow[]> {
  return freshV2Entries(clone(SEED_ROWS))
}

function parseStored(raw: string): Database {
  const parsed = JSON.parse(raw) as Database | Record<string, EntryRow[]>
  // v2 已带版本：直接用（版本一致，幂等；将来升版再在这里挂 migrateV2toV3）。
  if (parsed && typeof parsed === 'object' && 'version' in parsed && 'entries' in parsed) {
    return { version: SCHEMA_VERSION, entries: parsed.entries as Record<string, EntryRow[]> }
  }
  // v1 裸记录：另存一份新库，老快照保留在调用前的 localStorage 里（见 persist）。
  return { version: SCHEMA_VERSION, entries: migrateDatabase(parsed as Record<string, EntryRow[]>) }
}

function readStorage(): Database {
  const fallback: Database = { version: SCHEMA_VERSION, entries: canonicalSeed() }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    try {
      persist(fallback)
    } catch {
      // 播种落盘失败不影响本次使用，内存里仍是完整的实测种子。
    }
    return fallback
  }
  try {
    const db = parseStored(raw)
    try {
      // 迁移或版本升级后的新库整包落盘；落不下去只影响下次，不影响本次读到的库。
      persist(db)
    } catch {
      /* 读路径不抛出：显式写动作（saveRows/commitRows）失败才整套退回 */
    }
    return db
  } catch {
    try {
      persist(fallback)
    } catch {
      /* 同上 */
    }
    return fallback
  }
}

/**
 * 原子落库：先在内存里把整库序列化成一个完整字符串，再一次性 setItem。
 * setItem 抛错（配额满等）时不更新内存缓存、不保留任何半截字段 —— 整套退回。
 */
function persist(db: Database): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const payload = JSON.stringify(db) // 先序列化：失败发生在这里就完全没写
  window.localStorage.setItem(STORAGE_KEY, payload)
}

let cache: Database | null = null

export function database(): Database {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return database().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 多模块一次提交（如登记遗留同时写 duty + maintenance）：全部落库或整套退回。 */
export function commitRows(patch: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const db = database()
  // 先在内存快照上改，序列化成功才替换缓存；任何一步失败都回滚到 oldCache。
  const oldCache = cache
  const next: Database = {
    version: SCHEMA_VERSION,
    entries: { ...db.entries, ...clone(patch) },
  }
  try {
    persist(next)
  } catch (error) {
    cache = oldCache // 整套退回：字段不落库，也不留在内存中间态
    throw new Error(`数据落库失败，已整套退回：${error instanceof Error ? error.message : '未知错误'}`)
  }
  cache = next
  return next.entries
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(canonicalSeed()[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供数据层验证脚本使用：换一个干净的 localStorage 后清掉内存缓存。 */
export function __resetCacheForVerify(): void {
  cache = null
}
