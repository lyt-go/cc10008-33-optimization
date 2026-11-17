/**
 * 复核演示数据：引用行动标签模块真实规则编号（ACTI-xxxx）与异常检测模块真实检测器编号
 * （ANOM-xxxx），构造可复现的检测器结果批次与上一完整异常标签命中结果。
 *
 * 场景覆盖任务要求的全部关键行为：
 * - 场景一：两个重叠检测窗口同时汇总同一异常对象（高敏），复核项只增加一次、误报不重复计数。
 * - 场景二：高敏检测结果与低敏历史命中在同一异常对象重叠，分别按窗口/规则仲裁。
 * - 场景三：并发写入同一批增量，只落盘一份，另一份回执 CONFLICT。
 * - 场景四：增量复算时部分标签规则未受影响，沿用上一完整异常标签命中结果。
 */

import type { BaselineHit, DetectorHit } from './types'

/** 分钟级时间戳助手：hour*60 + minute。 */
function min(day: number, hour: number, minute: number): number {
  return day * 1440 + hour * 60 + minute
}

/**
 * 第一批增量：高敏检测器 ANOM-0002 在两个重叠窗口对同一对象 USER-A100 产出误报候选，
 * 同时包含另一个对象 USER-B200 的常规命中。
 */
export function firstIncrementalBatch(): DetectorHit[] {
  return [
    {
      hitId: 'HIT-1001',
      detectorId: 'ANOM-0002',
      sensitivity: 'high',
      windowId: 'WIN-0900-0930',
      windowStartMin: min(1, 9, 0),
      windowEndMin: min(1, 9, 30),
      ruleId: 'ACTI-0003',
      objectKey: 'USER-A100',
      objectName: '用户 USER-A100',
      monitorEvent: 'pay_submit',
      anomalyPattern: '频次突增',
      falsePositive: true,
      observedAtMin: min(1, 9, 12),
    },
    {
      // 与 HIT-1001 窗口重叠（09:15-09:45 与 09:00-09:30 在 09:15-09:30 相交）。
      hitId: 'HIT-1002',
      detectorId: 'ANOM-0002',
      sensitivity: 'high',
      windowId: 'WIN-0915-0945',
      windowStartMin: min(1, 9, 15),
      windowEndMin: min(1, 9, 45),
      ruleId: 'ACTI-0003',
      objectKey: 'USER-A100',
      objectName: '用户 USER-A100',
      monitorEvent: 'pay_submit',
      anomalyPattern: '频次突增',
      falsePositive: true,
      observedAtMin: min(1, 9, 20),
    },
    {
      hitId: 'HIT-1003',
      detectorId: 'ANOM-0003',
      sensitivity: 'low',
      windowId: 'WIN-0900-1000',
      windowStartMin: min(1, 9, 0),
      windowEndMin: min(1, 10, 0),
      ruleId: 'ACTI-0002',
      objectKey: 'USER-B200',
      objectName: '用户 USER-B200',
      monitorEvent: 'login_fail',
      anomalyPattern: '离群行为',
      falsePositive: false,
      observedAtMin: min(1, 9, 40),
    },
  ]
}

/**
 * 上一完整异常标签命中结果（基线）：USER-C300 上已有一条低敏历史命中，
 * 供第二批的高敏结果触发版本冲突仲裁。
 */
export function baselineHits(): BaselineHit[] {
  return [
    {
      ruleId: 'ACTI-0002',
      objectKey: 'USER-C300',
      objectName: '用户 USER-C300',
      monitorEvent: 'coupon_claim',
      sensitivity: 'low',
      hitCount: 4,
      lastHitMin: min(0, 22, 10),
    },
    {
      // 未受影响规则 ACTI-0001 的历史命中：增量复算时应原样沿用。
      ruleId: 'ACTI-0001',
      objectKey: 'USER-D400',
      objectName: '用户 USER-D400',
      monitorEvent: 'page_view',
      sensitivity: 'low',
      hitCount: 2,
      lastHitMin: min(0, 18, 5),
    },
  ]
}

/**
 * 第二批增量：
 * - 高敏结果在 USER-C300 上与低敏历史命中重叠（版本冲突仲裁场景）。
 * - USER-A100 的后到结果补充第三个来源但不得再增加误报计数。
 * - 仅规则 ACTI-0003 / ACTI-0002 受影响，ACTI-0001 不参与本次重算。
 */
export function secondIncrementalBatch(): DetectorHit[] {
  return [
    {
      hitId: 'HIT-2001',
      detectorId: 'ANOM-0001',
      sensitivity: 'high',
      windowId: 'WIN-1000-1030',
      windowStartMin: min(1, 10, 0),
      windowEndMin: min(1, 10, 30),
      ruleId: 'ACTI-0003',
      objectKey: 'USER-C300',
      objectName: '用户 USER-C300',
      monitorEvent: 'coupon_claim',
      anomalyPattern: '模式漂移',
      falsePositive: true,
      observedAtMin: min(1, 10, 8),
    },
    {
      hitId: 'HIT-2002',
      detectorId: 'ANOM-0002',
      sensitivity: 'high',
      windowId: 'WIN-0930-1000',
      windowStartMin: min(1, 9, 30),
      windowEndMin: min(1, 10, 0),
      ruleId: 'ACTI-0003',
      objectKey: 'USER-A100',
      objectName: '用户 USER-A100',
      monitorEvent: 'pay_submit',
      anomalyPattern: '频次突增',
      falsePositive: true,
      observedAtMin: min(1, 9, 35),
    },
  ]
}

/** 第二批受影响的标签规则；ACTI-0001 不在其中，继续读取上一完整命中。 */
export function secondAffectedRules(): string[] {
  return ['ACTI-0003', 'ACTI-0002']
}

/** 第一批受影响的标签规则。 */
export function firstAffectedRules(): string[] {
  return ['ACTI-0003', 'ACTI-0002']
}
