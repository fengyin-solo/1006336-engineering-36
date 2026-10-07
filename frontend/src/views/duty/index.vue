<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">发起交接、确认交接、登记遗留走同一套读写规则；交接编号由值班日期与班次推导，本地与线上同一份种子。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出交接清单</button>
        <button class="btn" type="button" @click="exportAudit">导出核对清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in metricCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">核对问题合计：{{ issues.length }} 条（与下表条数一致）</span>
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
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="openForm(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="availableActions(row).length === 0" class="muted">无</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条值班交接记录（清单条数即本页表格条数）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 确认交接：交接人员必须出自本班花名册 -->
    <div v-if="formAction === '确认交接' && formRow" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3>确认交接 · {{ formRow['交接编号'] }}</h3>
        <p class="muted">
          值班班组「{{ formRow['值班班组'] }}」，合法交接人员：{{ rosterText(formRow) }}
        </p>
        <label class="form-item">
          <span>交接人员 *</span>
          <input v-model="form.handoverPerson" list="duty-personnel" placeholder="从值班班组花名册选择/填写" />
          <datalist id="duty-personnel">
            <option v-for="name in roster(formRow)" :key="name" :value="name" />
          </datalist>
        </label>
        <div class="form-actions">
          <button class="btn primary" type="submit">确认交接</button>
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
        </div>
      </form>
    </div>

    <!-- 登记遗留：遗留事项 + 现场实测日期（必填，缺值不许用默认值顶），可关联设备同步保养台账 -->
    <div v-if="formAction === '登记遗留' && formRow" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3>登记遗留 · {{ formRow['交接编号'] }}</h3>
        <label class="form-item">
          <span>遗留事项 *</span>
          <textarea v-model="form.items" rows="3" placeholder="现场记录的遗留事项，不允许留空"></textarea>
        </label>
        <label class="form-item">
          <span>现场实测日期 *</span>
          <input v-model="form.measuredDate" type="date" />
        </label>
        <label class="form-item">
          <span>关联设备（选填）</span>
          <input v-model="form.deviceNo" list="duty-devices" placeholder="形如 DEVI-0002，填写后同步设备保养台账" />
          <datalist id="duty-devices">
            <option v-for="device in deviceOptions" :key="device.no" :value="device.no">{{ device.name }}</option>
          </datalist>
        </label>
        <p class="muted">关联设备后，设备台账「上次保养日」以本次现场实测为准重算，两边登记同成同败。</p>
        <div class="form-actions">
          <button class="btn primary" type="submit">登记遗留</button>
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
        </div>
      </form>
    </div>

    <!-- 交接核对：三类问题逐条列缘由，页面、概览与导出同源同序 -->
    <section class="audit-block">
      <h3>交接核对（{{ issues.length }} 条）</h3>
      <p class="muted">
        口径：交接编号撞车 {{ issueCount('duplicate-code') }} 条、班次空着
        {{ issueCount('shift-empty') }} 条、交接人员与值班班组对不上
        {{ issueCount('personnel-mismatch') }} 条；一条记录可命中多条，合计与上表一致。
      </p>
      <table v-if="issues.length" class="data-table">
        <thead>
          <tr>
            <th>记录ID</th><th>交接编号</th><th>值班日期</th><th>值班班组</th><th>问题类型</th><th>缘由</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(issue, index) in issues" :key="`${issue.rowId}-${issue.type}`">
            <td>{{ issue.rowId }}</td>
            <td>{{ issue.code || '—' }}</td>
            <td>{{ issue.date || '—' }}</td>
            <td>{{ issue.team || '—' }}</td>
            <td>{{ issueLabels[issue.type] }}</td>
            <td>{{ issue.reason }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">核对通过：没有撞号、缺班次或人员对不上的记录。</p>

      <h3 v-if="migrationNotes.length">迁移补登留痕</h3>
      <table v-if="migrationNotes.length" class="data-table">
        <thead>
          <tr><th>记录ID</th><th>交接编号</th><th>值班日期</th><th>迁移说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="note in migrationNotes" :key="note.rowId">
            <td>{{ note.rowId }}</td>
            <td>{{ note.code }}</td>
            <td>{{ note.date }}</td>
            <td>{{ note.note }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  downloadText,
  exportDutyAudit,
  listEntries,
  moduleMeta,
  moduleMetricValues,
  runAction as applyAction,
} from '@/api/local-service'
import { TEAM_ROSTERS, ISSUE_LABELS, auditDutyRows, type DutyIssue, type IssueType } from '@/data/duty-rules'
import { listRows, dutyMigrationNotes } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = meta.fields
const filterFields = ['交接编号', '值班班组', '值班日期']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const issues = ref<DutyIssue[]>([])
const issueLabels = ISSUE_LABELS

// 迁移留痕来自迁移期一次性写入的说明（早年缺班次补登、编号重算），页面只读展示。
const migrationNotes = computed(() => dutyMigrationNotes())

const metricCards = computed(() => {
  const values = moduleMetricValues('duty')
  return [
    { label: '待交接班次', value: values['待交接班次'] ?? 0 },
    { label: '已交接班次', value: values['已交接班次'] ?? 0 },
    { label: '有遗留事项', value: values['有遗留事项'] ?? 0 },
  ]
})

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const deviceOptions = computed(() =>
  listRows('device').map((row) => ({
    no: String(row['设备编号'] ?? ''),
    name: String(row['设备名称'] ?? ''),
  })),
)

function issueCount(type: IssueType): number {
  return issues.value.filter((issue) => issue.type === type).length
}

function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待交接':
      // 现场先发现遗留时可先登记遗留，再补走交接
      return ['发起交接', '登记遗留']
    case '交接中':
      return ['确认交接', '登记遗留']
    case '已交接':
      return []
    case '有遗留':
      return []
    default:
      return []
  }
}

function roster(row: EntryRow): string[] {
  return TEAM_ROSTERS[String(row['值班班组'] ?? '')] ?? []
}

function rosterText(row: EntryRow): string {
  const names = roster(row)
  return names.length ? names.join('、') : '（该班组不在值班队名册内）'
}

// ───────────── 表单 ─────────────

const formAction = ref('')
const formRow = ref<EntryRow | null>(null)
const form = ref({ handoverPerson: '', items: '', measuredDate: '', deviceNo: '' })

function openForm(action: string, row: EntryRow) {
  errorMessage.value = ''
  formAction.value = action
  formRow.value = row
  form.value = { handoverPerson: '', items: '', measuredDate: '', deviceNo: '' }
}

function closeForm() {
  formAction.value = ''
  formRow.value = null
}

function submitForm() {
  if (!formRow.value) {
    return
  }
  const payload =
    formAction.value === '确认交接'
      ? { handoverPerson: form.value.handoverPerson }
      : {
          items: form.value.items,
          measuredDate: form.value.measuredDate,
          deviceNo: form.value.deviceNo,
        }
  const result = applyAction(meta.key, Number(formRow.value.id), formAction.value, payload)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeForm()
  reload()
}

// ───────────── 读取 ─────────────

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportAudit() {
  // 页面核对表与导出走同一个 auditDutyRows，条数天然一致；先按当前数据再核一遍再下载。
  const live = auditDutyRows(listRows(meta.key))
  if (live.length !== issues.value.length) {
    issues.value = live
  }
  const { content, filename } = exportDutyAudit()
  downloadText(filename, content)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    issues.value = auditDutyRows(listRows(meta.key))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

onMounted(reload)
</script>
