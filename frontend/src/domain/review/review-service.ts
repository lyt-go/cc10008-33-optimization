/**
 * 异常标签复核服务：页面唯一读写入口（与项目“页面只渲染、读写统一走 service”约定一致）。
 *
 * 数据流入：
 *   local-store(action 标签规则 / anomaly 检测器)
 *     -> 标签规则处理点筛选（仅“已生效”规则产出命中）
 *        -> convergence.recomputeIncremental（误报收敛 + 版本冲突仲裁）
 *           -> review-store.commitSnapshot（互斥 + 乐观版本，并发只落盘一份）
 */

import { listRows } from '@/data/local-store'
import {
  emptySnapshot,
  recomputeIncremental,
  ruleLevelSources,
  windowLevelConvergence,
} from './convergence'
import {
  commitSnapshot,
  loadSnapshot,
  resetSnapshot,
  runExclusive,
} from './review-store'
import type {
  ArbitrationAxis,
  BaselineHit,
  DetectorHit,
  ReviewItem,
  ReviewSnapshot,
  ReviewStatus,
  ReviewWriteReceipt,
} from './types'

/** 标签规则处理点：从行动标签模块读取规则，仅“已生效”规则可参与异常标签命中。 */
export function effectiveTagRules(): Array<{ ruleId: string; tagName: string; status: string }> {
  return listRows('action')
    .map((row) => ({
      ruleId: String(row['规则编号'] ?? ''),
      tagName: String(row['标签名称'] ?? ''),
      status: String(row.status ?? ''),
    }))
    .filter((rule) => rule.ruleId !== '')
}

/** 检测器清单：从异常检测模块读取，灵敏度字段映射为 high/low。 */
export function registeredDetectors(): Array<{
  detectorId: string
  monitorEvent: string
  sensitivity: string
  windowMin: string
  status: string
}> {
  return listRows('anomaly').map((row) => ({
    detectorId: String(row['检测器编号'] ?? ''),
    monitorEvent: String(row['监控事件'] ?? ''),
    sensitivity: String(row['灵敏度'] ?? ''),
    windowMin: String(row['检测窗口分'] ?? ''),
    status: String(row.status ?? ''),
  }))
}

/** 当前复核清单快照。 */
export function currentSnapshot(): ReviewSnapshot {
  return loadSnapshot()
}

/** 当前复核项列表（每个异常对象只占一个位置）。 */
export function listReviewItems(): ReviewItem[] {
  return Object.values(loadSnapshot().items).sort((a, b) => a.firstSeenMin - b.firstSeenMin)
}

/** 窗口级误报收敛清单。 */
export function windowConvergence() {
  return windowLevelConvergence(loadSnapshot())
}

/** 规则级异常来源清单。 */
export function ruleSources() {
  return ruleLevelSources(loadSnapshot())
}

/**
 * 提交一批增量检测器结果，完成“读取基线 -> 增量复算 -> 互斥提交”。
 * 整个流程在 runExclusive 临界区内，并发请求只有一份能 COMMITTED。
 */
export async function submitIncremental(params: {
  hits: DetectorHit[]
  baselines: BaselineHit[]
  affectedRuleIds: string[]
  axis: ArbitrationAxis
  nowMin: number
}): Promise<ReviewWriteReceipt> {
  return runExclusive(() => {
    const previous = loadSnapshot(params.axis)
    const candidate = recomputeIncremental(
      previous,
      params.hits,
      params.baselines,
      params.affectedRuleIds,
      params.axis,
      params.nowMin,
    )
    return commitSnapshot(candidate, previous.version)
  })
}

/**
 * 模拟并发写入：两个调用方基于同一基线版本同时提交同一批增量。
 * 期望：第一份 COMMITTED，第二份 CONFLICT，清单只落盘一份。
 */
export async function submitConcurrent(params: {
  hits: DetectorHit[]
  baselines: BaselineHit[]
  affectedRuleIds: string[]
  axis: ArbitrationAxis
  nowMin: number
}): Promise<ReviewWriteReceipt[]> {
  const sharedBase = loadSnapshot(params.axis)
  const buildCandidate = () =>
    recomputeIncremental(
      sharedBase,
      params.hits,
      params.baselines,
      params.affectedRuleIds,
      params.axis,
      params.nowMin,
    )

  return runExclusive(() => {
    // 临界区内串行执行两次提交：第二次因版本号已抬升而被乐观锁驳回。
    const first = commitSnapshot(buildCandidate(), sharedBase.version)
    const second = commitSnapshot(buildCandidate(), sharedBase.version)
    return [first, second]
  })
}

/** 复核项状态流转（沿用 local-service 的集中流转风格，页面不做业务判断）。 */
const REVIEW_TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  待复核: ['复核中', '误报关闭'],
  复核中: ['已确认', '误报关闭'],
  已确认: [],
  误报关闭: [],
}

export function transitionReviewItem(objectKey: string, target: ReviewStatus): ReviewWriteReceipt {
  const previous = loadSnapshot()
  const item = previous.items[objectKey]
  if (!item) {
    return {
      ok: false,
      status: 'CONFLICT',
      message: `没有找到异常对象 ${objectKey} 的复核项`,
      baseVersion: previous.version,
      currentVersion: previous.version,
      snapshot: null,
    }
  }
  if (!REVIEW_TRANSITIONS[item.status].includes(target)) {
    return {
      ok: false,
      status: 'CONFLICT',
      message: `复核项当前为「${item.status}」，不能流转到「${target}」`,
      baseVersion: previous.version,
      currentVersion: previous.version,
      snapshot: null,
    }
  }
  const candidate: ReviewSnapshot = JSON.parse(JSON.stringify(previous)) as ReviewSnapshot
  candidate.items[objectKey].status = target
  candidate.lastDelta = { ...candidate.lastDelta }
  return commitSnapshot(candidate, previous.version)
}

/** 重置复核清单（演示用）。 */
export function resetReview(axis: ArbitrationAxis = 'window'): ReviewSnapshot {
  return resetSnapshot(axis)
}

/** 空快照工厂透传，便于测试与首次播种。 */
export function createEmptySnapshot(axis: ArbitrationAxis, nowMin: number): ReviewSnapshot {
  return emptySnapshot(axis, nowMin)
}
