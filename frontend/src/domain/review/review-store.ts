/**
 * 异常标签待复核清单的本地持久化与并发控制。
 *
 * 并发模型（浏览器单进程内的并发写入请求）：
 * - runExclusive：Promise 互斥链，同一时刻只允许一个“读取-复算-提交”流程进入临界区；
 *   并发请求在链上串行，第二个请求进入临界区时基线版本已被抬升。
 * - 版本号乐观校验：commitSnapshot 比对 baseVersion 与当前落盘版本，不一致即回执 CONFLICT，
 *   不会把后到结果重放成新增（保证“并发写入只写入一份清单，另一回执标记冲突”）。
 */

import { emptySnapshot } from './convergence'
import type { ArbitrationAxis, ReviewSnapshot, ReviewWriteReceipt } from './types'

const STORAGE_KEY = 'behavior-event-trace-hub:anomaly-review'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

/** 读取当前落盘快照；不存在或损坏时回退为空快照并回填。 */
export function loadSnapshot(fallbackAxis: ArbitrationAxis = 'window'): ReviewSnapshot {
  const fallback = emptySnapshot(fallbackAxis)
  if (!hasStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as ReviewSnapshot
    if (!parsed.items || typeof parsed.version !== 'number') {
      throw new Error('invalid snapshot')
    }
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

/**
 * 提交一份新快照（乐观版本校验）。
 * @param candidate 已在内存中复算好的候选快照（version 仍为基线版本）
 * @param baseVersion 提交方依据的基线版本
 */
export function commitSnapshot(
  candidate: ReviewSnapshot,
  baseVersion: number,
): ReviewWriteReceipt {
  const current = loadSnapshot(candidate.arbitrationAxis)
  // 乐观版本校验：基线已被其他流程抬升则驳回，不写盘、不重放为新增。
  if (current.version !== baseVersion) {
    return {
      ok: false,
      status: 'CONFLICT',
      message: `版本冲突：基线版本 ${baseVersion} 已过期，当前版本 ${current.version}，本次写入被驳回`,
      baseVersion,
      currentVersion: current.version,
      snapshot: null,
    }
  }

  const committed: ReviewSnapshot = {
    ...clone(candidate),
    version: current.version + 1,
  }
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(committed))
  }
  return {
    ok: true,
    status: 'COMMITTED',
    message: `复核清单已提交，版本 ${current.version} -> ${committed.version}`,
    baseVersion,
    currentVersion: committed.version,
    snapshot: committed,
  }
}

/**
 * 异步串行化写入：把“读取-复算-提交”整体放入互斥链。
 * 前一个写入未完成时，后一个请求排队；进入临界区后仍由 commitSnapshot 做版本校验，
 * 基线过期者拿到 CONFLICT，而不会覆盖先提交的清单。
 */
export function runExclusive<T>(task: () => T | Promise<T>): Promise<T> {
  const run = writeMutex.then(() => Promise.resolve().then(task))
  // 吞掉前序失败，避免一条链中断后后续任务全部拒绝。
  writeMutex = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

let writeMutex: Promise<unknown> = Promise.resolve()

/** 重置清单（演示/测试用）。 */
export function resetSnapshot(axis: ArbitrationAxis = 'window'): ReviewSnapshot {
  const fresh = emptySnapshot(axis)
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
  }
  return fresh
}

export function reviewStorageKey(): string {
  return STORAGE_KEY
}
