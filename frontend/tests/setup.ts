/**
 * Node 测试环境桩：提供最小 localStorage / window，让 review-store 可在 Node 下运行。
 * 仅测试代码加载，业务源码不直接依赖 DOM。
 */

class MemoryStorage {
  private map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
// review-store 通过 typeof window !== 'undefined' && window.localStorage 判定。
;(globalThis as Record<string, unknown>).window = { localStorage: storage }
;(globalThis as Record<string, unknown>).localStorage = storage

export { storage }
