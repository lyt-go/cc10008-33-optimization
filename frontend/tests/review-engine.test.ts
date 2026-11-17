/**
 * 误报收敛 / 增量复算领域测试。
 *
 * 覆盖任务要求：
 * 1. 两个重叠检测窗口同时汇总：复核项只增加一次，后到结果补充来源、误报计数不重复增加。
 * 2. 高敏检测结果与低敏历史命中在同一异常对象重叠：窗口/规则两种仲裁都保持单对象单占位。
 * 3. 并发写入：只落盘一份清单，另一份回执 CONFLICT。
 * 4. 增量复算：未受影响规则沿用上一完整异常标签命中结果；重复投递幂等。
 * 5. 高/低敏检测器覆盖同一行为：复核项只增加一次且两个误报来源均可展开。
 * 6. 窗口级 / 规则级两份归并清单的汇总正确性。
 */
import './setup'

import {
  baselineHits,
  commitSnapshot,
  emptySnapshot,
  firstAffectedRules,
  firstIncrementalBatch,
  recomputeIncremental,
  resetSnapshot,
  ruleLevelSources,
  runExclusive,
  secondAffectedRules,
  secondIncrementalBatch,
  windowLevelConvergence,
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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    console.error(`  ✗ ${label}\n    expected=${JSON.stringify(expected)}\n    actual  =${JSON.stringify(actual)}`)
    failed += 1
  } else {
    passed += 1
    console.log(`  ✓ ${label}`)
  }
}

const NOW = 2 * 1440 + 9 * 60

// --- 场景一：重叠检测窗口只产生一个复核位置、误报只计一次 ---
console.log('场景一：两个重叠检测窗口同时汇总')
{
  const snap0 = emptySnapshot('window')
  const snap1 = recomputeIncremental(
    snap0,
    firstIncrementalBatch(),
    baselineHits(),
    firstAffectedRules(),
    'window',
    NOW,
  )
  const itemA = snap1.items['USER-A100']
  assert(itemA !== undefined, 'USER-A100 进入复核清单')
  assertEqual(Object.keys(snap1.items).length, 2, '两个异常对象 -> 恰好两个复核项（无重复占位）')
  assertEqual(itemA.falsePositiveCount, 1, '重叠窗口的两条误报结果：误报计数只增加一次')
  assertEqual(itemA.falsePositiveSources.length, 2, '两个误报来源均可展开')
  assertEqual(itemA.detectorIds, ['ANOM-0002'], '来源归并到同一检测器')
  assertEqual(itemA.windowIds.length, 2, '两个重叠窗口都保留在复核项上')
  assert(
    itemA.falsePositiveSources[1].overlapWith.includes('WIN-0900-0930'),
    '后到窗口标记了与先到窗口的重叠关系',
  )
  assertEqual(snap1.lastDelta.inserted.sort(), ['USER-A100', 'USER-B200'], '首批两个对象均为新增占位')
  assert(snap1.lastDelta.merged.includes('USER-A100'), '后到结果计入 merged（仅补充来源）')

  const itemB = snap1.items['USER-B200']
  assertEqual(itemB.falsePositiveCount, 0, '非误报候选不增加误报计数')
  assertEqual(itemB.falsePositiveSources.length, 0, '非误报候选没有误报来源')
}

// --- 场景二：高敏结果与低敏历史命中重叠的两种仲裁 ---
console.log('场景二：高敏/低敏同对象重叠的版本冲突仲裁')
for (const axis of ['window', 'rule'] as const) {
  console.log(`  仲裁轴 = ${axis}`)
  const snap0 = emptySnapshot(axis)
  const snap1 = recomputeIncremental(
    snap0,
    firstIncrementalBatch(),
    baselineHits(),
    firstAffectedRules(),
    axis,
    NOW,
  )
  const snap2 = recomputeIncremental(
    snap1,
    secondIncrementalBatch(),
    baselineHits(),
    secondAffectedRules(),
    axis,
    NOW + 60,
  )
  const itemC = snap2.items['USER-C300']
  assert(itemC !== undefined, 'USER-C300 只有一个复核位置')
  assertEqual(Object.keys(snap2.items).length, 3, '第二批未制造重复对象，仍是三个复核项')
  assert(itemC.versionConflict, '高低敏重叠被标记为版本冲突')
  assert(itemC.conflictReason.includes(axis === 'window' ? '窗口级仲裁' : '规则级仲裁'), '仲裁说明与仲裁轴一致')
  if (axis === 'rule') {
    assertEqual(itemC.primaryRuleId, 'ACTI-0003', '规则级归并：高敏规则接管主占位')
    assert(itemC.ruleIds.includes('ACTI-0002'), '规则级归并：低敏历史规则保留可展开')
  } else {
    assertEqual(itemC.primaryRuleId, 'ACTI-0003', '窗口级归并：维持先到规则占位')
    assert(itemC.windowIds.includes('WIN-1000-1030'), '窗口级归并：冲突窗口保留在同一位置')
  }
  assert(snap2.lastDelta.arbitrated.includes('USER-C300'), '仲裁对象写入 delta.arbitrated')
}

// --- 场景三：后到结果只补充来源，误报计数不膨胀 ---
console.log('场景三：USER-A100 第三批来源补充')
{
  const snap1 = recomputeIncremental(
    emptySnapshot('window'),
    firstIncrementalBatch(),
    baselineHits(),
    firstAffectedRules(),
    'window',
    NOW,
  )
  const snap2 = recomputeIncremental(
    snap1,
    secondIncrementalBatch(),
    baselineHits(),
    secondAffectedRules(),
    'window',
    NOW + 60,
  )
  const itemA = snap2.items['USER-A100']
  assertEqual(itemA.falsePositiveCount, 1, '三批误报结果汇合后误报计数仍为 1（不膨胀）')
  assertEqual(itemA.falsePositiveSources.length, 3, '三个误报来源全部可展开')
  assertEqual(itemA.sourceHitIds.length, 3, '三个结果编号都留痕')
}

// --- 场景四：幂等 + 未受影响规则沿用基线 ---
console.log('场景四：幂等投递与未受影响规则')
{
  const snap1 = recomputeIncremental(
    emptySnapshot('window'),
    firstIncrementalBatch(),
    baselineHits(),
    firstAffectedRules(),
    'window',
    NOW,
  )
  const snapIdempotent = recomputeIncremental(
    snap1,
    firstIncrementalBatch(),
    baselineHits(),
    firstAffectedRules(),
    'window',
    NOW + 1,
  )
  assertEqual(
    Object.keys(snapIdempotent.items).length,
    Object.keys(snap1.items).length,
    '同一批结果重复投递不产生新复核项',
  )
  assertEqual(snapIdempotent.lastDelta.inserted, [], '重复投递没有新增占位')
  const itemAReplay = snapIdempotent.items['USER-A100']
  assertEqual(itemAReplay.falsePositiveSources.length, 2, '重复投递不重复登记来源')

  const snap2 = recomputeIncremental(
    snap1,
    secondIncrementalBatch(),
    baselineHits(),
    secondAffectedRules(),
    'window',
    NOW + 60,
  )
  assert(
    snap2.lastDelta.untouchedRules.includes('ACTI-0001'),
    '未受影响规则 ACTI-0001 继续读取上一完整异常标签命中结果',
  )
  assert(
    !snap2.lastDelta.untouchedRules.includes('ACTI-0003'),
    '受影响规则 ACTI-0003 不进入 untouched 列表',
  )
}

// --- 场景五：并发写入只落盘一份，另一份 CONFLICT ---
console.log('场景五：并发写入冲突仲裁')
{
  resetSnapshot('window')
  // 先构造一个已落盘基线版本 v1。
  const seeded = recomputeIncremental(
    emptySnapshot('window'),
    firstIncrementalBatch(),
    baselineHits(),
    firstAffectedRules(),
    'window',
    NOW,
  )
  const baseReceipt = commitSnapshot(seeded, 0)
  assert(baseReceipt.ok, '基线清单提交成功（v1）')
  assertEqual(baseReceipt.currentVersion, 1, '落盘版本抬升到 1')

  const receipts = await runExclusive(() => {
    const baseline = baseReceipt.snapshot as never
    // 两个调用方都基于 v1 读取出同一基线。
    const candidateA = recomputeIncremental(
      JSON.parse(JSON.stringify(baseline)),
      secondIncrementalBatch(),
      baselineHits(),
      secondAffectedRules(),
      'window',
      NOW + 90,
    )
    const candidateB = recomputeIncremental(
      JSON.parse(JSON.stringify(baseline)),
      secondIncrementalBatch(),
      baselineHits(),
      secondAffectedRules(),
      'window',
      NOW + 90,
    )
    return [commitSnapshot(candidateA, 1), commitSnapshot(candidateB, 1)]
  })

  assertEqual(receipts[0].status, 'COMMITTED', '第一份并发写入成功')
  assertEqual(receipts[1].status, 'CONFLICT', '第二份并发写入回执冲突')
  assertEqual(receipts[1].currentVersion, 2, '冲突回执返回当前已提交版本')

  // 关键校验：清单只落盘一份 -> 来源没有被写两遍。
  const stored = JSON.parse(
    (globalThis as { window: { localStorage: { getItem: (k: string) => string } } }).window.localStorage.getItem(
      'behavior-event-trace-hub:anomaly-review',
    ) as string,
  ) as { version: number; items: Record<string, { falsePositiveSources: unknown[] }> }
  assertEqual(stored.version, 2, '落盘版本为 2（只提交了一份）')
  assertEqual(stored.items['USER-A100'].falsePositiveSources.length, 3, '被驳回的写入没有重复落盘来源')
}

// --- 场景六：高/低敏覆盖同一行为，单占位且双来源可展开 ---
console.log('场景六：高/低敏检测器覆盖同一行为')
{
  const mixed = [
    {
      hitId: 'HIT-HIGH-1',
      detectorId: 'ANOM-0002',
      sensitivity: 'high' as const,
      windowId: 'WIN-MIX-1',
      windowStartMin: 100,
      windowEndMin: 130,
      ruleId: 'ACTI-0003',
      objectKey: 'USER-M900',
      objectName: '用户 USER-M900',
      monitorEvent: 'mix_event',
      anomalyPattern: '突增',
      falsePositive: true,
      observedAtMin: 105,
    },
    {
      hitId: 'HIT-LOW-1',
      detectorId: 'ANOM-0003',
      sensitivity: 'low' as const,
      windowId: 'WIN-MIX-2',
      windowStartMin: 110,
      windowEndMin: 140,
      ruleId: 'ACTI-0002',
      objectKey: 'USER-M900',
      objectName: '用户 USER-M900',
      monitorEvent: 'mix_event',
      anomalyPattern: '突增',
      falsePositive: true,
      observedAtMin: 112,
    },
  ]
  const snap = recomputeIncremental(emptySnapshot('window'), mixed, [], ['ACTI-0003', 'ACTI-0002'], 'window', 200)
  assertEqual(Object.keys(snap.items).length, 1, '高低敏覆盖同一行为：复核项只增加一次')
  const item = snap.items['USER-M900']
  assertEqual(item.falsePositiveCount, 1, '误报计数不随第二个检测器增加')
  assertEqual(item.falsePositiveSources.length, 2, '高敏与低敏两个误报来源均可展开')
  assertEqual([...item.detectorIds].sort(), ['ANOM-0002', 'ANOM-0003'], '两个检测器都挂在同一复核位置')
}

// --- 场景七：窗口级 / 规则级归并清单汇总 ---
console.log('场景七：两份归并清单')
{
  const snap = recomputeIncremental(
    recomputeIncremental(
      emptySnapshot('rule'),
      firstIncrementalBatch(),
      baselineHits(),
      firstAffectedRules(),
      'rule',
      NOW,
    ),
    secondIncrementalBatch(),
    baselineHits(),
    secondAffectedRules(),
    'rule',
    NOW + 60,
  )
  const windowRows = windowLevelConvergence(snap)
  const ruleRows = ruleLevelSources(snap)
  const everyObjectOncePerWindow = windowRows.every((row) => new Set(row.objectKeys).size === row.objectKeys.length)
  assert(everyObjectOncePerWindow, '窗口级清单中每个异常对象在每个窗口只出现一次')
  const ruleRow = ruleRows.find((row) => row.ruleId === 'ACTI-0003')
  assert(ruleRow !== undefined, '规则级清单包含高敏规则 ACTI-0003')
  assert(
    (ruleRow?.objectKeys ?? []).every((key, idx, arr) => arr.indexOf(key) === idx),
    '规则级清单中对象不重复',
  )
  const totalObjects = new Set(ruleRows.flatMap((row) => row.objectKeys)).size
  assertEqual(totalObjects, Object.keys(snap.items).length, '规则级清单覆盖全部复核对象且无重复')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exitCode = 1
}
