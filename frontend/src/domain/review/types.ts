/**
 * 异常标签复核领域模型（纯前端版）。
 *
 * 调用链（与现有 local-service / local-store 约定保持一致）：
 *   行动标签(标签规则 action)
 *     └─ 标签规则处理点：草稿 -> 规则评审中 -> 已生效 / 已停用（只有“已生效”规则产出命中）
 *        └─ 异常标签命中结果（规则级历史命中，含低敏历史命中）
 *           └─ 异常检测(检测器 anomaly：灵敏度 + 检测窗口分)
 *              └─ 误报收敛（窗口级 / 规则级两种仲裁归并）
 *                 └─ 异常标签待复核数据清单（每个异常对象只占一个当前复核位置）
 *
 * 关键不变量：
 * 1. 同一异常对象在当前复核清单里只占一条复核项（按 objectKey 去重）。
 * 2. 两个重叠检测窗口同时汇总时复核项只增加一次；后到结果只补充来源，不再增加误报计数。
 * 3. 并发写入只有一份清单落盘，另一份回执标记冲突（互斥 + 版本号乐观校验）。
 * 4. 增量复算基于上一版完整快照做局部合并：未受影响的标签规则继续读取上一完整异常标签命中结果。
 */

/** 检测器灵敏度：高敏检测器更易触发，是误报膨胀的主要来源。 */
export type Sensitivity = 'high' | 'low'

/** 版本冲突仲裁轴：沿检测窗口归并，或沿标签规则归并。 */
export type ArbitrationAxis = 'window' | 'rule'

/** 复核项生命周期状态。 */
export type ReviewStatus = '待复核' | '复核中' | '已确认' | '误报关闭'

/**
 * 检测器结果（异常检测模块 anomaly 的结构化输出）。
 * 一批 detectorResults 即一次增量重算读取到的检测器结果数据。
 */
export interface DetectorHit {
  /** 结果编号，保证同一批内可区分。 */
  hitId: string
  /** 检测器编号，对应 anomaly 模块的“检测器编号”，如 ANOM-0002。 */
  detectorId: string
  /** 检测器灵敏度。 */
  sensitivity: Sensitivity
  /** 检测窗口标识；两个重叠窗口共享同一窗口区间编号时参与窗口重叠判定。 */
  windowId: string
  /** 检测窗口起点（含），分钟级时间戳，用于判断窗口是否重叠。 */
  windowStartMin: number
  /** 检测窗口终点（不含）。 */
  windowEndMin: number
  /** 命中的标签规则编号，对应 action 模块的“规则编号”，如 ACTI-0003。 */
  ruleId: string
  /** 异常对象唯一标识（用户/设备/会话等），复核去重的主键。 */
  objectKey: string
  /** 异常对象展示名。 */
  objectName: string
  /** 监控事件，对应 anomaly 模块字段。 */
  monitorEvent: string
  /** 异常模式。 */
  anomalyPattern: string
  /** 是否被检测器判为误报候选（false-positive 候选）。 */
  falsePositive: boolean
  /** 结果产生时间（分钟级），同对象多结果到达顺序的确定性裁决依据。 */
  observedAtMin: number
}

/** 标签规则处理点：行动标签规则在流转中的状态快照。 */
export interface TagRulePoint {
  ruleId: string
  tagName: string
  tagCategory: string
  /** 规则当前状态，只有“已生效”参与异常标签命中。 */
  status: string
  /** 规则版本，规则变更会抬高版本，用于规则级仲裁。 */
  ruleVersion: number
}

/**
 * 上一完整异常标签命中结果（基线）。
 * 增量重算时未受影响的规则继续读取这份完整命中，不参与本次重算。
 */
export interface BaselineHit {
  ruleId: string
  objectKey: string
  objectName: string
  monitorEvent: string
  /** 历史命中的灵敏度（低敏历史命中与高敏检测结果在同对象重叠时触发版本冲突仲裁）。 */
  sensitivity: Sensitivity
  /** 命中次数，作为历史来源保留。 */
  hitCount: number
  /** 最近一次命中时间（分钟级）。 */
  lastHitMin: number
}

/** 误报来源：一个复核项下可展开多个来源，来源本身去重。 */
export interface FalsePositiveSource {
  detectorId: string
  ruleId: string
  windowId: string
  sensitivity: Sensitivity
  windowStartMin: number
  windowEndMin: number
  observedAtMin: number
  /** 与既有来源的重叠关系说明，便于复核页展开。 */
  overlapWith: string[]
}

/**
 * 当前复核项：每个异常对象在清单中只占一个位置。
 */
export interface ReviewItem {
  objectKey: string
  objectName: string
  monitorEvent: string
  anomalyPattern: string
  /** 当前占位的标签规则（规则级归并时为仲裁胜出规则）。 */
  primaryRuleId: string
  /** 参与归并的全部规则编号（去重）。 */
  ruleIds: string[]
  /** 参与归并的全部检测器编号（去重），两个误报来源都可展开。 */
  detectorIds: string[]
  /** 窗口级归并键：窗口重叠的结果归到同一复核位置。 */
  windowKey: string
  /** 涉及的检测窗口（去重）。 */
  windowIds: string[]
  sensitivity: Sensitivity
  status: ReviewStatus
  /**
   * 误报计数：复核项首次被判为误报候选时记 1；
   * 后到结果（含重叠窗口、同对象高/低敏来源）只补充来源，不再 +1。
   */
  falsePositiveCount: number
  /** 可展开的误报来源清单（按 detectorId+windowId+ruleId 去重）。 */
  falsePositiveSources: FalsePositiveSource[]
  /** 高敏检测结果与低敏历史命中在同一异常对象重叠时置位。 */
  versionConflict: boolean
  /** 冲突仲裁说明。 */
  conflictReason: string
  /** 首次进入当前复核位置的时间。 */
  firstSeenMin: number
  /** 最近一次有结果补充来源的时间。 */
  lastUpdatedMin: number
  /** 来源结果编号（去重），保证重复投递幂等。 */
  sourceHitIds: string[]
}

/** 一次增量复算产出的变更明细。 */
export interface RecomputeDelta {
  /** 新占位的复核项对象键（复核项只增加一次的那部分）。 */
  inserted: string[]
  /** 仅补充来源、未增加复核位置/误报计数的对象键。 */
  merged: string[]
  /** 触发版本冲突仲裁的对象键。 */
  arbitrated: string[]
  /** 未受影响、沿用上一完整命中结果的规则编号。 */
  untouchedRules: string[]
}

/** 异常标签待复核数据清单快照（持久化单元）。 */
export interface ReviewSnapshot {
  /** 清单版本，每次成功写入 +1，并发写入时做乐观校验。 */
  version: number
  /** 当前仲裁轴。 */
  arbitrationAxis: ArbitrationAxis
  /** 复核项，按 objectKey 索引保证唯一占位。 */
  items: Record<string, ReviewItem>
  /** 本次/最近一次增量复算的变更明细。 */
  lastDelta: RecomputeDelta
  /** 最近成功写入时间（分钟级）。 */
  updatedAtMin: number
}

/** 写入回执：并发写只有一份成功，另一份标记冲突。 */
export interface ReviewWriteReceipt {
  ok: boolean
  /** CONFLICT 表示版本冲突/互斥失败，调用方不得重放为新增。 */
  status: 'COMMITTED' | 'CONFLICT'
  message: string
  /** 提交方期望基于的基线版本。 */
  baseVersion: number
  /** 落盘后的最新版本（冲突时为当前已提交版本）。 */
  currentVersion: number
  snapshot: ReviewSnapshot | null
}
