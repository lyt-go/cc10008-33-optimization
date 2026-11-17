/**
 * 测试运行器：用 esbuild 把 tests/*.test.ts 打包成 Node 可执行的 ESM 临时包再运行。
 * 不走 vite/vitest，避免新增依赖；@ 别名在测试里用相对路径引入，无需额外解析。
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (!entry) {
  console.error('用法：node tests/run.mjs <test-file>')
  process.exit(2)
}

const dir = await mkdtemp(join(tmpdir(), 'review-test-'))
const outfile = join(dir, 'bundle.mjs')

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    sourcemap: false,
    logLevel: 'warning',
    alias: {
      '@': join(process.cwd(), 'src'),
    },
  })
  await import(pathToFileURL(outfile).href)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
