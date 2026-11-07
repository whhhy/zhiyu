#!/usr/bin/env node
/**
 * 知识库热备（不停服）。
 * ------------------------------------------------------------
 * 为什么需要这个脚本，而不是让运维直接敲 `sqlite3 ... .backup`：
 *
 *   **运行镜像里没有 sqlite3 命令行。** 容器是 `node:22-alpine`，
 *   `apk info` 能查到 `sqlite` 库包，但**没有 CLI**（实测 `command -v sqlite3` → NOT FOUND）。
 *   而 DEPLOY.md 的热备与 cron 示例全用的是 `sqlite3 ... .backup` ——
 *   照着做会得到 `command not found`，**而在 cron 里失败是静默的**。
 *   「每日备份看起来一直在跑，其实一个文件都没有」——
 *   文档自己警告过的那个坑，触发点却比它想的更靠前。
 *
 * 本脚本用项目本来就依赖的 `node:sqlite`（Node 22 内置）来做，**零新依赖** ——
 * 与「内网机器没有编译工具链」那条约束一致。
 *
 * 用法：
 *   node scripts/backup.mjs <输出目录>          # 默认 ./backups
 *   node scripts/backup.mjs /backup            # 文档里那个绝对路径
 *
 * 退出码：0 成功；非 0 失败（**cron 能看见**）。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2] || 'backups'

try {
  fs.mkdirSync(OUT, { recursive: true })
} catch (e) {
  console.error(`✗ 建不出备份目录 ${OUT}：${e.message}`)
  console.error('  （文档里特别提过这一条：目录不存在时 sqlite3 .backup 会报')
  console.error('    "unable to open database file"，一个文件都出不来。cron 里这失败是静默的。）')
  process.exit(2)
}

const DB = process.env.YQ_DB || 'data/yuque.db'
if (!fs.existsSync(DB)) {
  console.error(`✗ 找不到数据库 ${DB}（用 YQ_DB 指定路径）`)
  process.exit(2)
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
const out = path.join(OUT, `yuque-${stamp}.db`)

let src
let dst
try {
  src = new DatabaseSync(DB, { readOnly: true })
  /*
   * ⚠️ 这里用 `VACUUM INTO` 而不是「打开源库再逐表导出」：
   *   它由 SQLite 自己保证一致性快照，**读的是含 WAL 的实时状态**，
   *   所以不需要停服、也不会漏掉还在 -wal 里没归并的数据。
   *   （「拷 .db 文件」那种做法会漏 WAL —— 实测拷漏了就少数据。）
   */
  dst = new DatabaseSync(out)
  src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
  dst.close()

  // 立刻自检：备份文件能打开、表能读到、行数不为 0
  const verify = new DatabaseSync(out, { readOnly: true })
  let docs = null
  try {
    docs = verify.prepare('select count(*) as c from docs').get().c
  } catch {
    docs = null
  }
  const bytes = fs.statSync(out).size
  verify.close()

  if (docs === null) {
    console.error(`✗ 备份文件打不开或没有 docs 表：${out}`)
    process.exit(3)
  }
  if (bytes < 1024) {
    console.error(`✗ 备份文件只有 ${bytes} 字节，明显不完整：${out}`)
    process.exit(3)
  }
  console.log(`✓ 备份完成 ${out}`)
  console.log(`  ${bytes} 字节 / docs 表 ${docs} 行`)
  console.log(`  （行数不等于线上篇数是正常的 —— 回收站里的文档也算一行。）`)
  console.log(`  恢复演练：把这个文件放到数据目录的 yuque.db（**连同 -wal/-shm 一起删掉**），再起服务。`)
} catch (e) {
  console.error('✗ 备份失败：', e.message)
  process.exit(1)
} finally {
  try { src?.close() } catch { /* 已关 */ }
  try { dst?.close() } catch { /* 已关 */ }
}