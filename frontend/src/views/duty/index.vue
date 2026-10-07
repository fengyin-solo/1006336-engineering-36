<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">发起交接、确认交接、登记遗留走同一套读写规则；遗留事项同步登记到保养台账，来源交接编号两边对齐。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
        <button class="btn ghost" type="button" @click="resetData">恢复现场实测种子</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="canRun('发起交接', row)"
              class="link"
              type="button"
              @click="runAction('发起交接', row)"
            >
              发起交接
            </button>
            <button
              v-if="canRun('确认交接', row)"
              class="link"
              type="button"
              @click="runAction('确认交接', row)"
            >
              确认交接
            </button>
            <button
              v-if="canRun('登记遗留', row)"
              class="link"
              type="button"
              @click="openLegacy(row)"
            >
              登记遗留
            </button>
            <span v-if="!availableActions(row).length" class="muted">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="legacyTarget" class="legacy-panel" @submit.prevent="submitLegacy">
      <h3>登记遗留 · {{ legacyTarget['交接编号'] }}（{{ legacyTarget['值班日期'] }} {{ legacyTarget['班次'] }}）</h3>
      <p class="muted">遗留事项会同步登记到设施检修保养台账，来源交接编号：{{ legacyTarget['交接编号'] }}</p>
      <label class="filter-item">
        <span>交接人员</span>
        <input v-model="legacyForm.handoverPerson" placeholder="现场交班人姓名（必须属于当班班组）" />
      </label>
      <label class="filter-item">
        <span>遗留事项</span>
        <textarea v-model="legacyForm.legacyNote" rows="3" placeholder="现场遗留情况，缺值不拿默认值顶"></textarea>
      </label>
      <div class="page-actions">
        <button class="btn primary" type="submit">提交登记（同事务写保养台账）</button>
        <button class="btn ghost" type="button" @click="closeLegacy">取消</button>
      </div>
    </section>

    <section class="audit-panel">
      <header class="audit-head">
        <h3>存量核对</h3>
        <span>页面 {{ rows.length }} 条，核对有问题 {{ auditItems.length }} 条</span>
      </header>
      <table v-if="auditItems.length" class="data-table">
        <thead>
          <tr>
            <th>行号</th><th>交接编号</th><th>值班日期</th><th>班次</th><th>值班班组</th><th>交接人员</th><th>缘由</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in auditItems" :key="`${item.id}-${item.code}`">
            <td>{{ item.id }}</td>
            <td>{{ item.code }}</td>
            <td>{{ item.dutyDate || '—' }}</td>
            <td>{{ item.shift }}</td>
            <td>{{ item.team }}</td>
            <td>{{ item.handoverPerson }}</td>
            <td>{{ item.reasons.join('；') }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">交接编号无撞车、班次无空缺、交接人员与值班班组全部对得上。</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条运维值班交接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  auditEntries,
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleStats,
  resetModule,
  runAction as applyAction,
} from '@/api/local-service'
import type { AuditLike, EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = meta.fields
const statuses = ["待交接", "交接中", "已交接", "有遗留"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const auditItems = ref<AuditLike[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["交接编号", "值班班组", "值班日期"]

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const legacyTarget = ref<EntryRow | null>(null)
const legacyForm = ref({ handoverPerson: '', legacyNote: '' })

function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待交接') {
    return ['发起交接']
  }
  if (status === '交接中') {
    return ['确认交接', '登记遗留']
  }
  if (status === '已交接') {
    return ['登记遗留']
  }
  return []
}

function canRun(action: string, row: EntryRow): boolean {
  return availableActions(row).includes(action)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key, filters.value)
}

function resetData() {
  resetModule(meta.key)
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openLegacy(row: EntryRow) {
  errorMessage.value = ''
  legacyTarget.value = row
  legacyForm.value = {
    handoverPerson: String(row['交接人员'] ?? ''),
    legacyNote: String(row['遗留事项'] ?? ''),
  }
}

function closeLegacy() {
  legacyTarget.value = null
}

function submitLegacy() {
  if (!legacyTarget.value) {
    return
  }
  const result = applyAction(meta.key, Number(legacyTarget.value.id), '登记遗留', {
    legacyNote: legacyForm.value.legacyNote,
    handoverPerson: legacyForm.value.handoverPerson,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeLegacy()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 指标卡与核对清单都从页面同一份筛选结果读数。
    stats.value = moduleStats(meta.key, filters.value)
    auditItems.value = auditEntries(meta.key, filters.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.audit-panel {
  margin-top: 16px;
  border-top: 1px solid #d8dee8;
  padding-top: 12px;
}
.audit-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.legacy-panel {
  margin-top: 12px;
  border: 1px solid #c9a227;
  border-radius: 8px;
  padding: 12px 16px;
  background: #fffaf0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.muted {
  color: #7a869a;
}
</style>
