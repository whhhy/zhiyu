import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 把「这份产物是拿哪个 API 前缀构建的」写进产物本身
 * ------------------------------------------------------------
 * `VITE_API_BASE` 是**构建期**变量：子路径部署要
 *   `VITE_API_BASE=/knowledge npm run build`
 * 而 `src/lib/api.ts` 的 `apiBase()` 在拿不到它时返回 `''`，
 * 也就是**照常构建**出来的产物会把 API 请求打回站点根 `/api/...`。
 *
 * 于是有一对「单独看都正常、凑一起才出事」的组合（和 DEPLOY 里那个
 * nginx `/ws` 漏转发 X-Forwarded-For 同一类）：
 *
 *   ① 运维按文档用 `VITE_API_BASE=/knowledge` 构建，部署在 `/knowledge/` —— 正常；
 *   ② 之后任何人跑一次 `npm run build`，或者跑 `npm run test:all`
 *      （它在跑套件前**必定重新构建**）—— 产物被重建成根路径版本；
 *   ③ 全站 API 404，页面整个坏掉，而**没有任何一处提示**。
 *
 * 写这个标记文件不是为了防住谁，是为了**让这件事看得见**：
 * 服务启动时打一行「本产物构建时的 API 前缀 = X」，
 * 运维一眼就能发现「我明明部署在 /knowledge，怎么是空的」。
 */
function buildInfoMarker(): Plugin {
  return {
    name: 'yuque-buildinfo-marker',
    apply: 'build',
    closeBundle() {
      const apiBase = String(process.env.VITE_API_BASE || '').replace(/\/$/, '')
      const out = resolve(process.cwd(), 'dist', '.buildinfo.json')
      writeFileSync(out, JSON.stringify({ apiBase, builtAt: new Date().toISOString() }, null, 2), 'utf8')
    },
  }
}

export default defineConfig({
  plugins: [react(), buildInfoMarker()],
  /**
   * base —— **保持 `'./'`（相对路径）**。
   *
   * ⚠️⚠️ 2026-10-10 我在这里**改过一次，又改回来了**。记下来别再来一遍：
   *
   *   当时的「证据」：浏览器直接打开 `/book/b1/settings` 是**白屏**，
   *   network 里 JS 请求 200 但 `mimeType: text/html`。
   *   看起来很像「相对路径指错了地方」，于是把 base 改成 `'/'`。
   *
   *   结论**错了**，错在**根本没验路由机制**：
   *   本项目用的是 **`HashRouter`**（见 `src/main.tsx`），
   *   路由长这样：`/#/book/b1/settings`。
   *   所以 `/book/b1/settings` 里**根本不含路由信息** ——
   *   浏览器把它当成普通路径，服务端回 index.html，页面正常渲染工作台。
   *   而那次「白屏」发生在**上一次构建**期间：dist 刚被覆盖，
   *   index.html 指向的还是旧 hash 的 JS 文件名，那个文件已不存在，
   *   于是被 SPA 回退成 HTML。**是构建时序问题，不是 base 问题。**
   *
   * 为什么相对路径在这里是对的：
   *   HashRouter 下**路径部分永远停在 `/`**（后面全是 `#`），
   *   所以 `./assets/xxx.js` 永远解析成 `/assets/xxx.js`，
   *   不存在「跟着路由变深」的可能。这也是它能挂在任意子路径下的原因。
   *   换绝对路径 `'/'` 反而会把「整站挂到 /knowledge/ 下」这个能力弄坏。
   *
   * 怎么验证路由机制（下次别再凭推理下结论）：
   *   打开 `http://<host>/#/book/b1/settings` —— 带 `#` 才是本项目的真链接；
   *   不带 `#` 的一切路径都只是 index.html。
   *
   * ------------------------------------------------------------
   * 2026-10-12 又有人（就是我）把同一个结论**重新推错了一遍**，留个可复现的记录：
   *   现象：直接打开 `http://host/book/b1/settings` → 整页白屏，
   *         console 里一句
   *         `Failed to load module script: … MIME type of "text/html"`。
   *   成因（这次验到了）：index.html 里是 `./assets/index-xxx.js`，
   *         浏览器拿**当前路径**去解析 → 变成 `/book/b1/assets/…` → 那个文件不存在
   *         → 服务端的 SPA 回退把它换成了 index.html（`text/html`）→ 模块脚本被拒 → 白屏。
   *
   *   为什么它**不是**缺陷（差点为此改了 base）：
   *   · HashRouter 下应用自己产生的地址**一律带 `#`** ——
   *     唯一会被复制出去的是 `DocPage` 的「复制链接」，
   *     它拼的是 `${location.origin}/#/book/${bookId}/doc/${doc.id}`，带 `#`；
   *   · 其余全是 `navigate()` / `<Link to>`，那是客户端路由，不产生不带 `#` 的地址；
   *   · 所以**发链接、收藏、刷新**走的都是 `/#/…`，路径部分永远停在 `/`，
   *     `./assets/` 永远解析成 `/assets/`。
   *
   *   唯一会白屏的是**手打 / 手改**成不带 `#` 的路径。
   *   代价只是「白屏而不是跳回工作台」，不是功能坏了，所以仍然保持 `'./'`。
   */
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { host: '0.0.0.0', port: 5173 },
})
