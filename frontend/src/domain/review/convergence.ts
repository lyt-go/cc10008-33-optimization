/**
 * 误报收敛引擎：纯函数实现，不接触 localStorage，方便按增量结果反复复算。
 *
 * 收敛规则总览：
 * - 去重主键：异常对象 objectKey —— 每个异常对象在当前复核清单只占一个复核位置。
 * - 窗口重叠：两个检测窗口区间相交且监控事件一致时，后到结果并入同一复核项，
 *   复核项不重复增加，误报计数也不重复增加，只补充可展开来源。
 * - 幂等：相同 hitId 重复投递直接忽略。
 * - 版本冲突：高敏检测结果与低敏历史命中落在同一异常对象时，按仲裁轴归并：
 *   window -> 窗口级误报收敛清单；rule -> 规则级异常来源清单；两种归并都保持单对象单占位。
 */

import type {
  ArbitrationAxis,
  BaselineHit,
  DetectorHit,
  FalsePositiveSource,
  RecomputeDelta,
  ReviewItem,
  ReviewSnapshot,
  Sensitivity,
} from './types'

/** 两个分钟级区间是否重叠（半开区间 [start, end)）。 */
export function windowsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** 窗口级归并键：同一对象 + 同一监控事件下，重叠窗口共享一个归并槽。 */
function windowSlotKey(hit: DetectorHit): string {
  return `${hit.objectKey}::${hit.monitorEvent}::${hit.windowId}`
}

function toSource(hit: DetectorHit, overlapWith: string[]): FalsePositiveSource {
  return {
    detectorId: hit.detectorId,
    ruleId: hit.ruleId,
    windowId: hit.windowId,
    sensitivity: hit.sensitivity,
    windowStartMin: hit.windowStartMin,
    windowEndMin: hit.windowEndMin,
    observedAtMin: hit.observedAtMin,
    overlapWith: [...new Set(overlapWith)],
  }
}

function sourceKey(source: Pick<FalsePositiveSource, 'detectorId' | 'windowId' | 'ruleId'>): string {
  return `${source.detectorId}::${source.windowId}::${source.ruleId}`
}

function rankSensitivity(sensitivity: Sensitivity): number {
  // 高敏优先占位：高敏结果先到或仲裁胜出时由高敏主导复核位置。
  return sensitivity === 'high' ? 1 : 0
}

function emptyDelta(): RecomputeDelta {
  return { inserted: [], merged: [], arbitrated: [], untouchedRules: [] }
}

/**
 * 判定一个新到结果与既有复核项是否属于“重叠检测窗口同时汇总”。
 * 需要：同对象、同监控事件，且任一既有窗口与新窗口区间相交。
 */
function hitsOverlappingWindow(existing: ReviewItem, hit: DetectorHit): boolean {
  if (existing.objectKey !== hit.objectKey || existing.monitorEvent !== hit.monitorEvent) {
    return false
  }
  return existing.falsePositiveSources.some(
    (source) =>
      windowsOverlap(
        source.windowStartMin,
        source.windowEndMin,
        hit.windowStartMin,
        hit.windowEndMin,
      ) || source.windowId === hit.windowId,
  )
}

/** 把一条检测器结果收敛进既有复核项：只补充来源与归并信息，不增加误报计数。 */
function mergeIntoItem(item: ReviewItem, hit: DetectorHit): void {
  if (!item.ruleIds.includes(hit.ruleId)) {
    item.ruleIds.push(hit.ruleId)
  }
  if (!item.detectorIds.includes(hit.detectorId)) {
    item.detectorIds.push(hit.detectorId)
  }
  if (!item.windowIds.includes(hit.windowId)) {
    item.windowIds.push(hit.windowId)
  }

  // 高敏结果到达时抬升复核项灵敏度展示。
  if (rankSensitivity(hit.sensitivity) > rankSensitivity(item.sensitivity)) {
    item.sensitivity = hit.sensitivity
  }

  item.lastUpdatedMin = Math.max(item.lastUpdatedMin, hit.observedAtMin)

  if (hit.falsePositive) {
    const overlapWindows = item.falsePositiveSources
      .filter((source) =>
        windowsOverlap(
          source.windowStartMin,
          source.windowEndMin,
          hit.windowStartMin,
          hit.windowEndMin,
        ),
      )
      .map((source) => source.windowId)

    const candidate = toSource(hit, overlapWindows)
    const duplicated = item.falsePositiveSources.some(
      (source) => sourceKey(source) === sourceKey(candidate),
    )
    if (!duplicated) {
      item.falsePositiveSources.push(candidate)
      // 关键收敛点：复核项已存在时，后到误报结果只补充来源，不再增加误报计数。
      // falsePositiveCount 仅在新建占位（createItem）时计一次。
    }
  }
}

/** 为一个没有既有占位的对象新建复核项；误报候选在此处计且仅计一次。 */
function createItem(hit: DetectorHit): ReviewItem {
  const item: ReviewItem = {
    objectKey: hit.objectKey,
    objectName: hit.objectName,
    monitorEvent: hit.monitorEvent,
    anomalyPattern: hit.anomalyPattern,
    primaryRuleId: hit.ruleId,
    ruleIds: [hit.ruleId],
    detectorIds: [hit.detectorId],
    windowKey: windowSlotKey(hit),
    windowIds: [hit.windowId],
    sensitivity: hit.sensitivity,
    status: '待复核',
    falsePositiveCount: hit.falsePositive ? 1 : 0,
    falsePositiveSources: hit.falsePositive ? [toSource(hit, [])] : [],
    versionConflict: false,
    conflictReason: '',
    firstSeenMin: hit.observedAtMin,
    lastUpdatedMin: hit.observedAtMin,
    sourceHitIds: [hit.hitId],
  }
  return item
}

/**
 * 版本冲突仲裁：高敏检测结果与低敏历史命中在同一异常对象重叠。
 * 两种仲裁轴都保持“每个异常对象只占一个当前复核位置”。
 */
function arbitrateConflict(
  item: ReviewItem,
  hit: DetectorHit,
  baseline: BaselineHit | undefined,
  axis: ArbitrationAxis,
): void {
  if (!baseline || hit.sensitivity !== 'high' || baseline.sensitivity !== 'low') {
    return
  }
  item.versionConflict = true
  if (axis === 'window') {
    // 窗口级误报收敛清单：以检测窗口为归并边界，主规则保持先到占位规则，
    // 低敏历史命中作为来源补充进同一窗口槽，不另开复核位置。
    item.conflictReason =
      `窗口级仲裁：高敏结果(${hit.detectorId}/${hit.windowId})与低敏历史命中` +
      `(${baseline.ruleId})在对象 ${item.objectKey} 重叠，按检测窗口归并为单一复核位置`
    item.windowKey = `${hit.objectKey}::${hit.monitorEvent}::${hit.windowId}`
  } else {
    // 规则级异常来源清单：以标签规则为归并边界，高敏结果携带的规则接管主占位，
    // 低敏历史规则保留在 ruleIds / 来源中可展开。
    item.primaryRuleId = hit.ruleId
    if (!item.ruleIds.includes(baseline.ruleId)) {
      item.ruleIds.push(baseline.ruleId)
    }
    item.conflictReason =
      `规则级仲裁：高敏规则 ${hit.ruleId} 与低敏历史规则 ${baseline.ruleId}` +
      `在对象 ${item.objectKey} 重叠，按标签规则归并，高敏规则主导当前复核位置`
  }
}

/** 深拷贝快照，保证纯函数语义：调用方持有的旧快照不被原地修改。 */
function cloneSnapshot(snapshot: ReviewSnapshot): ReviewSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ReviewSnapshot
}

/**
 * 增量重算入口。
 *
 * @param previous 上一版完整复核清单快照（含上一完整异常标签命中结果）
 * @param detectorHits 本次增量读取到的一批检测器结果
 * @param baselines 上一完整异常标签命中结果（规则级），用于高低敏重叠仲裁
 * @param affectedRuleIds 本次受影响的标签规则；其余规则沿用上一完整命中，不参与重算
 * @param axis 版本冲突仲裁轴
 * @param nowMin 当前时间（分钟级），用于快照 updatedAtMin
 */
export function recomputeIncremental(
  previous: ReviewSnapshot,
  detectorHits: DetectorHit[],
  baselines: BaselineHit[],
  affectedRuleIds: string[],
  axis: ArbitrationAxis,
  nowMin: number,
): ReviewSnapshot {
  const next = cloneSnapshot(previous)
  next.arbitrationAxis = axis
  const delta = emptyDelta()

  const affected = new Set(affectedRuleIds)
  const allRuleIds = new Set([
    ...Object.values(next.items).flatMap((item) => item.ruleIds),
    ...detectorHits.map((hit) => hit.ruleId),
    ...baselines.map((hit) => hit.ruleId),
  ])
  delta.untouchedRules = [...allRuleIds].filter((ruleId) => !affected.has(ruleId))

  // 同批结果按对象 + 到达时间排序，保证复算确定性。
  const ordered = [...detectorHits].sort((a, b) => {
    if (a.objectKey !== b.objectKey) {
      return a.objectKey.localeCompare(b.objectKey)
    }
    if (a.observedAtMin !== b.observedAtMin) {
      return a.observedAtMin - b.observedAtMin
    }
    return a.hitId.localeCompare(b.hitId)
  })

  const baselineByObjectRule = new Map<string, BaselineHit>()
  const baselineByObject = new Map<string, BaselineHit>()
  for (const baseline of baselines) {
    baselineByObjectRule.set(`${baseline.objectKey}::${baseline.ruleId}`, baseline)
    // 冲突判定以“同一异常对象”为准：高敏结果携带的规则可能与低敏历史规则不同，
    // 因此同时保留对象级索引，先按对象命中，再回退对象+规则精确匹配。
    if (!baselineByObject.has(baseline.objectKey)) {
      baselineByObject.set(baseline.objectKey, baseline)
    }
  }

  const findBaseline = (hit: DetectorHit): BaselineHit | undefined =>
    baselineByObjectRule.get(`${hit.objectKey}::${hit.ruleId}`) ??
    baselineByObject.get(hit.objectKey)

  for (const hit of ordered) {
    const existing = next.items[hit.objectKey]

    // 幂等：同一结果重复投递不再产生任何变化。
    if (existing && existing.sourceHitIds.includes(hit.hitId)) {
      continue
    }

    if (!existing) {
      // 该异常对象首次出现 -> 新建唯一复核位置；误报候选在此计 1 次。
      const item = createItem(hit)
      const baseline = findBaseline(hit)
      const hadConflict =
        baseline !== undefined && hit.sensitivity === 'high' && baseline.sensitivity === 'low'
      if (hadConflict) {
        arbitrateConflict(item, hit, baseline, axis)
        delta.arbitrated.push(hit.objectKey)
      }
      next.items[hit.objectKey] = item
      delta.inserted.push(hit.objectKey)
      continue
    }

    // 同一异常对象的后到结果：复核位置不重复增加。
    const overlapping = hitsOverlappingWindow(existing, hit)
    mergeIntoItem(existing, hit)
    existing.sourceHitIds.push(hit.hitId)

    const baseline = findBaseline(hit)
    const hadConflict =
      baseline !== undefined && hit.sensitivity === 'high' && baseline.sensitivity === 'low'
    if (hadConflict && !existing.versionConflict) {
      arbitrateConflict(existing, hit, baseline, axis)
      delta.arbitrated.push(hit.objectKey)
    }

    // 两个重叠检测窗口同时汇总：只补充来源，不增加误报计数（计数在 mergeIntoItem 中保持不变）。
    if (overlapping || existing.falsePositiveCount > 0) {
      if (!delta.merged.includes(hit.objectKey)) {
        delta.merged.push(hit.objectKey)
      }
    }
  }

  next.lastDelta = delta
  next.updatedAtMin = nowMin
  return next
}

/** 构造一份空快照（首次播种用）。 */
export function emptySnapshot(axis: ArbitrationAxis = 'window', nowMin = 0): ReviewSnapshot {
  return {
    version: 0,
    arbitrationAxis: axis,
    items: {},
    lastDelta: emptyDelta(),
    updatedAtMin: nowMin,
  }
}

/**
 * 窗口级误报收敛清单：按检测窗口维度汇总复核项（每个对象仍只出现一次）。
 */
export function windowLevelConvergence(snapshot: ReviewSnapshot): Array<{
  windowId: string
  objectKeys: string[]
  falsePositiveCount: number
  sourceCount: number
}> {
  const buckets = new Map<
    string,
    { objectKeys: Set<string>; falsePositiveCount: number; sourceCount: number }
  >()
  for (const item of Object.values(snapshot.items)) {
    for (const windowId of item.windowIds) {
      const bucket =
        buckets.get(windowId) ?? { objectKeys: new Set<string>(), falsePositiveCount: 0, sourceCount: 0 }
      bucket.objectKeys.add(item.objectKey)
      bucket.falsePositiveCount += item.falsePositiveCount
      bucket.sourceCount += item.falsePositiveSources.filter(
        (source) => source.windowId === windowId,
      ).length
      buckets.set(windowId, bucket)
    }
  }
  return [...buckets.entries()].map(([windowId, bucket]) => ({
    windowId,
    objectKeys: [...bucket.objectKeys],
    falsePositiveCount: bucket.falsePositiveCount,
    sourceCount: bucket.sourceCount,
  }))
}

/**
 * 规则级异常来源清单：按标签规则维度汇总来源（每个对象在每个规则下仍只计一次）。
 */
export function ruleLevelSources(snapshot: ReviewSnapshot): Array<{
  ruleId: string
  objectKeys: string[]
  detectors: string[]
  sourceCount: number
}> {
  const buckets = new Map<string, { objectKeys: Set<string>; detectors: Set<string>; sourceCount: number }>()
  for (const item of Object.values(snapshot.items)) {
    for (const ruleId of item.ruleIds) {
      const bucket =
        buckets.get(ruleId) ?? { objectKeys: new Set<string>(), detectors: new Set<string>(), sourceCount: 0 }
      bucket.objectKeys.add(item.objectKey)
      for (const source of item.falsePositiveSources) {
        if (source.ruleId === ruleId) {
          bucket.sourceCount += 1
          bucket.detectors.add(source.detectorId)
        }
      }
      buckets.set(ruleId, bucket)
    }
  }
  return [...buckets.entries()].map(([ruleId, bucket]) => ({
    ruleId,
    objectKeys: [...bucket.objectKeys],
    detectors: [...bucket.detectors],
    sourceCount: bucket.sourceCount,
  }))
}
