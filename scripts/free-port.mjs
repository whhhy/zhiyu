/* ============================================================
   挑一个空闲端口
   ------------------------------------------------------------
   为什么要有这个：
   套件以前都**写死**端口（8111 / 8102 / 8124 …），于是
   「机器上碰巧有别的东西占着那个端口」就会把套件打挂。

   实测（2026-10-19 20:54）：`test-invite-e2e` 用 8111，
   而那台机器上有个 python 程序在 20:33 起了、正好占着 8111 ——
   套件起不来，runner 那边看到的是
   「没找到汇总行「结果：N 通过 / M 失败」，连逐项 PASS/FAIL 都没有」，
   **完全指不到真因**（真因是端口冲突，不是功能坏了）。

   而且写死的端口**彼此还重号**：8102（invite / sso）、
   8124（avatar-e2e / bookstats）、8153（attachaith / space-delete）、
   8163（bodyserver / imagelocal）、8222（ipwlchanges / offboardrole）、
   8109（ipwl-ui-e2e / team-stacks）……
   它们现在能跑，纯粹是因为 runner 顺序执行、且每个套件都收了摊。
   哪一次有一个套件没收干净，后面那个重号的就会挂。

   ⇒ 一律向操作系统要一个空闲端口（`listen(0)` 让系统分配），用完立刻释放。
   环境变量仍然可以指定（`YQ_E2E_PORT=…`），方便排查。
   ============================================================ */
import net from 'node:net'

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
