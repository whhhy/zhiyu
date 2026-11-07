/* ============================================================
   让服务端能直接 import 前端源码里的 @/ 别名
   ------------------------------------------------------------
   服务端想复用前端的种子数据（src/data/seed.ts）与类型，
   但那些文件写的是 `import ... from '@/types'`，
   Node 原生不认这个别名。

   这里注册一个**同步**解析钩子，把 `@/foo` 映射到 `<repo>/src/foo`，
   补上 `.ts` 扩展名。这样服务端不需要复制一份种子数据，
   也不会出现「前端改了种子、服务端还是旧数据」的双份维护。
   ============================================================ */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = resolvePath(SRC, specifier.slice(2))
      // 有扩展名就直接用，没有就依次试 .ts / .tsx / /index.ts
      const candidates = [base, `${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')]
      for (const c of candidates) {
        if (existsSync(c) && !c.endsWith('/')) {
          return { url: pathToFileURL(c).href, shortCircuit: true, format: 'module-typescript' }
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
