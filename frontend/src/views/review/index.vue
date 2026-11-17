<template>
  <section class="page" data-module="review">
    <header class="page-head">
      <div>
        <h2>异常标签复核</h2>
        <p class="page-desc">
          标签异常联动入口：行动标签规则命中 → 异常检测 → 误报收敛 → 异常标签待复核数据清单（增量复算、单对象单占位）。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="runFirstBatch">提交第一批增量</button>
        <button class="btn" type="button" @click="runSecondBatch">提交第二批增量</button>
        <button class="btn" type="button" @click="runConcurrent">模拟并发写入</button>
        <button class="btn ghost" type="button" @click="resetAll">重置清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">当前复核项（异常对象数）</span>
        <strong class="stat-value">{{ items.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">误报计数合计（收敛后）</span>
        <strong class="stat-value">{{ totalFalsePositive }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">可展开误报来源数</span>
        <strong class="stat-value">{{ totalSources }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">版本冲突仲裁项</span>
        <strong class="stat-value">{{ conflictCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">清单版本 / 仲裁轴</span>
        <strong class="stat-value">v{{ snapshot.version }} · {{ axisLabel }}</strong>
      </article>
    </div>

    <section class="flow-panel">
      <h3>数据流与标签规则处理点</h3>
      <ol class="flow-list">
        <li>标签规则处理点：行动标签（action）状态流转 草稿 → 规则评审中 → 已生效 / 已停用，仅「已生效」规则（{{ effectiveRuleIds }}）参与异常标签命中。</li>
        <li>上一完整异常标签命中结果作为基线，本次未受影响规则（{{ untouchedRuleIds || '—' }}）继续读取上一完整命中，不参与重算。</li>
        <li>异常检测（anomaly）检测器按灵敏度（高敏/低敏）与检测窗口分产出检测器结果，进入误报收敛。</li>
        <li>收敛不变量：同一异常对象只占一个当前复核位置；重叠窗口后到结果只补充来源、不增加误报计数；并发写入只落盘一份，另一份回执 CONFLICT。</li>
      </ol>
      <p class="axis-switch">
        仲裁轴：
        <label><input type="radio" value="window" v-model="axis" /> 检测窗口归并（窗口级误报收敛清单）</label>
        <label><input type="radio" value="rule" v-model="axis" /> 标签规则归并（规则级异常来源清单）</label>
      </p>
    </section>

    <p v-if="message" class="status-legend">
      <span class="legend-item" :class="{ 'conflict-legend': lastConflict }">{{ message }}</span>
    </p>

    <h3>异常标签待复核数据清单（每对象单占位）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>异常对象</th>
          <th>监控事件 / 模式</th>
          <th>主规则 / 涉及规则</th>
          <th>检测器</th>
          <th>检测窗口</th>
          <th>灵敏度</th>
          <th>误报计数</th>
          <th>误报来源（可展开）</th>
          <th>冲突仲裁</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="item in items" :key="item.objectKey">
          <tr>
            <td>{{ item.objectName }}</td>
            <td>{{ item.monitorEvent }} / {{ item.anomalyPattern }}</td>
            <td>{{ item.primaryRuleId }}<br /><small>{{ item.ruleIds.join('、') }}</small></td>
            <td>{{ item.detectorIds.join('、') }}</td>
            <td>{{ item.windowIds.join('、') }}</td>
            <td>{{ item.sensitivity === 'high' ? '高敏' : '低敏' }}</td>
            <td>{{ item.falsePositiveCount }}</td>
            <td>
              <button class="link" type="button" @click="toggleExpand(item.objectKey)">
                {{ expanded[item.objectKey] ? '收起来源' : `展开 ${item.falsePositiveSources.length} 个来源` }}
              </button>
            </td>
            <td>
              <span v-if="item.versionConflict" class="conflict-tag">已仲裁</span>
              <span v-else>—</span>
            </td>
            <td>{{ item.status }}</td>
            <td class="row-actions">
              <button v-if="item.status === '待复核'" class="link" type="button" @click="transition(item.objectKey, '复核中')">开始复核</button>
              <button v-if="item.status === '复核中'" class="link" type="button" @click="transition(item.objectKey, '已确认')">确认异常</button>
              <button v-if="item.status !== '已确认' && item.status !== '误报关闭'" class="link" type="button" @click="transition(item.objectKey, '误报关闭')">误报关闭</button>
            </td>
          </tr>
          <tr v-if="expanded[item.objectKey]">
            <td colspan="11" class="source-cell">
              <table class="data-table sub-table">
                <thead>
                  <tr><th>检测器</th><th>规则</th><th>窗口</th><th>灵敏度</th><th>窗口区间(分)</th><th>到达时间(分)</th><th>重叠窗口</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(source, idx) in item.falsePositiveSources" :key="idx">
                    <td>{{ source.detectorId }}</td>
                    <td>{{ source.ruleId }}</td>
                    <td>{{ source.windowId }}</td>
                    <td>{{ source.sensitivity === 'high' ? '高敏' : '低敏' }}</td>
                    <td>{{ source.windowStartMin }} - {{ source.windowEndMin }}</td>
                    <td>{{ source.observedAtMin }}</td>
                    <td>{{ source.overlapWith.length ? source.overlapWith.join('、') : '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="item.versionConflict" class="conflict-reason">{{ item.conflictReason }}</p>
            </td>
          </tr>
        </template>
        <tr v-if="!items.length">
          <td colspan="11" class="empty-state">暂无复核项，先提交一批增量检测器结果</td>
        </tr>
      </tbody>
    </table>

    <div class="dual-panel">
      <section>
        <h3>窗口级误报收敛清单（窗口归并）</h3>
        <table class="data-table">
          <thead><tr><th>检测窗口</th><th>异常对象（单占位）</th><th>误报计数</th><th>来源数</th></tr></thead>
          <tbody>
            <tr v-for="row in windowRows" :key="row.windowId">
              <td>{{ row.windowId }}</td>
              <td>{{ row.objectKeys.join('、') }}</td>
              <td>{{ row.falsePositiveCount }}</td>
              <td>{{ row.sourceCount }}</td>
            </tr>
            <tr v-if="!windowRows.length"><td colspan="4" class="empty-state">暂无数据</td></tr>
          </tbody>
        </table>
      </section>
      <section>
        <h3>规则级异常来源清单（规则归并）</h3>
        <table class="data-table">
          <thead><tr><th>标签规则</th><th>异常对象（单占位）</th><th>检测器</th><th>来源数</th></tr></thead>
          <tbody>
            <tr v-for="row in ruleRows" :key="row.ruleId">
              <td>{{ row.ruleId }}</td>
              <td>{{ row.objectKeys.join('、') }}</td>
              <td>{{ row.detectors.join('、') || '—' }}</td>
              <td>{{ row.sourceCount }}</td>
            </tr>
            <tr v-if="!ruleRows.length"><td colspan="4" class="empty-state">暂无数据</td></tr>
          </tbody>
        </table>
      </section>
    </div>

    <h3>写入回执日志</h3>
    <table class="data-table">
      <thead><tr><th>回执状态</th><th>基线版本</th><th>当前版本</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="(receipt, idx) in receipts" :key="idx">
          <td>
            <span :class="receipt.ok ? 'ok-tag' : 'conflict-tag'">{{ receipt.status }}</span>
          </td>
          <td>{{ receipt.baseVersion }}</td>
          <td>{{ receipt.currentVersion }}</td>
          <td>{{ receipt.message }}</td>
        </tr>
        <tr v-if="!receipts.length"><td colspan="4" class="empty-state">尚未发生写入</td></tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>复核清单持久化在浏览器 localStorage（behavior-event-trace-hub:anomaly-review），可按增量结果反复复算</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  baselineHits,
  currentSnapshot,
  effectiveTagRules,
  firstAffectedRules,
  firstIncrementalBatch,
  listReviewItems,
  resetReview,
  ruleSources,
  secondAffectedRules,
  secondIncrementalBatch,
  submitConcurrent,
  submitIncremental,
  transitionReviewItem,
  windowConvergence,
} from '@/domain/review'
import type { ArbitrationAxis, ReviewItem, ReviewStatus, ReviewWriteReceipt } from '@/domain/review'

const nowMin = 2 * 1440 + 9 * 60

const items = ref<ReviewItem[]>([])
const receipts = ref<ReviewWriteReceipt[]>([])
const expanded = reactive<Record<string, boolean>>({})
const axis = ref<ArbitrationAxis>('window')
const message = ref('')
const lastConflict = ref(false)

const snapshot = ref(currentSnapshot())
const effectiveRules = ref(effectiveTagRules())
const effectiveRuleIds = computed(() =>
  effectiveRules.value.filter((rule) => rule.status === '已生效').map((rule) => rule.ruleId).join('、') || '—',
)
const axisLabel = computed(() => (axis.value === 'window' ? '窗口归并' : '规则归并'))
const totalFalsePositive = computed(() =>
  items.value.reduce((sum, item) => sum + item.falsePositiveCount, 0),
)
const totalSources = computed(() =>
  items.value.reduce((sum, item) => sum + item.falsePositiveSources.length, 0),
)
const conflictCount = computed(() => items.value.filter((item) => item.versionConflict).length)
const untouchedRuleIds = computed(() => snapshot.value.lastDelta.untouchedRules.join('、'))
const windowRows = computed(() => windowConvergence())
const ruleRows = computed(() => ruleSources())

function refresh() {
  snapshot.value = currentSnapshot()
  items.value = listReviewItems()
  effectiveRules.value = effectiveTagRules()
  axis.value = snapshot.value.arbitrationAxis
}

function pushReceipt(receipt: ReviewWriteReceipt) {
  receipts.value.push(receipt)
  message.value = receipt.message
  lastConflict.value = receipt.status === 'CONFLICT'
}

async function runFirstBatch() {
  const receipt = await submitIncremental({
    hits: firstIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: firstAffectedRules(),
    axis: axis.value,
    nowMin,
  })
  pushReceipt(receipt)
  refresh()
}

async function runSecondBatch() {
  const receipt = await submitIncremental({
    hits: secondIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: secondAffectedRules(),
    axis: axis.value,
    nowMin: nowMin + 60,
  })
  pushReceipt(receipt)
  refresh()
}

async function runConcurrent() {
  const pair = await submitConcurrent({
    hits: secondIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: secondAffectedRules(),
    axis: axis.value,
    nowMin: nowMin + 120,
  })
  pair.forEach(pushReceipt)
  refresh()
}

function transition(objectKey: string, target: ReviewStatus) {
  const receipt = transitionReviewItem(objectKey, target)
  pushReceipt(receipt)
  refresh()
}

function toggleExpand(objectKey: string) {
  expanded[objectKey] = !expanded[objectKey]
}

function resetAll() {
  resetReview(axis.value)
  receipts.value = []
  message.value = '复核清单已重置为空快照（version=0）'
  lastConflict.value = false
  Object.keys(expanded).forEach((key) => delete expanded[key])
  refresh()
}

onMounted(refresh)
</script>

<style scoped>
.flow-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.flow-panel h3 {
  margin: 4px 0 8px;
  font-size: 14px;
}
.flow-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
}
.axis-switch {
  display: flex;
  gap: 16px;
  font-size: 13px;
  margin: 8px 0 0;
}
.axis-switch label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.dual-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 14px 0;
}
.dual-panel h3 {
  font-size: 14px;
  margin: 6px 0;
}
.sub-table {
  margin: 6px 0;
  background: #f8fafc;
}
.source-cell {
  background: #f8fafc;
}
.conflict-tag {
  background: #fef3c7;
  color: #92400e;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}
.ok-tag {
  background: #dcfce7;
  color: #166534;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}
.conflict-reason {
  font-size: 12px;
  color: #92400e;
  margin: 6px 0 0;
}
.conflict-legend {
  background: #fee2e2 !important;
  color: #b42318;
}
h3 {
  font-size: 14px;
  margin: 14px 0 8px;
}
</style>
