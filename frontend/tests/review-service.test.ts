/**
 * 复核服务层冒烟测试：验证从 local-store 的 action/anomaly 真实数据
 * 经 review-service 到 localStorage 落盘的完整调用链。
 */
import './setup'

import {
  baselineHits,
  currentSnapshot,
  effectiveTagRules,
  firstAffectedRules,
  firstIncrementalBatch,
  listReviewItems,
  registeredDetectors,
  resetReview,
  ruleSources,
  secondAffectedRules,
  secondIncrementalBatch,
  submitConcurrent,
  submitIncremental,
  transitionReviewItem,
  windowConvergence,
} from '../src/domain/review'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

console.log('服务层：标签规则处理点读取')
{
  const rules = effectiveTagRules()
  assert(rules.length === 3, '从 action 模块读到 3 条标签规则')
  const detectors = registeredDetectors()
  assert(detectors.length === 3, '从 anomaly 模块读到 3 个检测器')
  assert(detectors.every((d) => d.detectorId.startsWith('ANOM-')), '检测器编号来自 anomaly 模块')
}

console.log('服务层：两次增量提交 + 单对象单占位')
{
  resetReview('window')
  const r1 = await submitIncremental({
    hits: firstIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: firstAffectedRules(),
    axis: 'window',
    nowMin: 3000,
  })
  assert(r1.ok && r1.status === 'COMMITTED', '第一批增量提交成功')
  assert(currentSnapshot().version === 1, '清单版本抬升到 1')

  const r2 = await submitIncremental({
    hits: secondIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: secondAffectedRules(),
    axis: 'window',
    nowMin: 3060,
  })
  assert(r2.ok, '第二批增量提交成功')
  assert(currentSnapshot().version === 2, '清单版本抬升到 2')

  const items = listReviewItems()
  const keys = items.map((i) => i.objectKey)
  assert(new Set(keys).size === keys.length, '当前复核清单每个异常对象只占一个位置')
  assert(keys.length === 3, '三批汇合后共 3 个复核对象')

  const itemA = items.find((i) => i.objectKey === 'USER-A100')
  assert(itemA?.falsePositiveCount === 1, '服务链路下误报计数仍收敛为 1')
  assert((itemA?.falsePositiveSources.length ?? 0) === 3, '三个误报来源均可展开')
  assert(itemA?.versionConflict === false, 'USER-A100 无高低敏冲突')

  const itemC = items.find((i) => i.objectKey === 'USER-C300')
  assert(itemC?.versionConflict === true, 'USER-C300 高低敏重叠已仲裁')
}

console.log('服务层：并发写入只落盘一份')
{
  resetReview('rule')
  const pair = await submitConcurrent({
    hits: firstIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: firstAffectedRules(),
    axis: 'rule',
    nowMin: 3100,
  })
  assert(pair[0].status === 'COMMITTED' && pair[1].status === 'CONFLICT', '并发双写：一份提交、一份冲突')
  assert(currentSnapshot().version === 1, '冲突写入没有抬升版本，清单只有一份')
  assert(listReviewItems().length === 2, '被驳回的一份没有重复落盘复核项')
}

console.log('服务层：状态流转与两份归并清单')
{
  resetReview('window')
  await submitIncremental({
    hits: firstIncrementalBatch(),
    baselines: baselineHits(),
    affectedRuleIds: firstAffectedRules(),
    axis: 'window',
    nowMin: 3200,
  })
  const t1 = transitionReviewItem('USER-A100', '复核中')
  assert(t1.ok, '待复核 -> 复核中 流转成功')
  const t2 = transitionReviewItem('USER-A100', '已确认')
  assert(t2.ok, '复核中 -> 已确认 流转成功')
  const t3 = transitionReviewItem('USER-A100', '误报关闭')
  assert(!t3.ok && t3.status === 'CONFLICT', '终态不可再流转，回执冲突')
  assert(currentSnapshot().items['USER-A100'].status === '已确认', '被驳回的流转未改状态')

  const windows = windowConvergence()
  const rules = ruleSources()
  assert(windows.length >= 2, '窗口级误报收敛清单已生成')
  assert(rules.some((r) => r.ruleId === 'ACTI-0003'), '规则级异常来源清单包含 ACTI-0003')
}

console.log(`\n服务层结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exitCode = 1
}
