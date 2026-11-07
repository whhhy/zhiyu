/* ============================================================
   导入：格式选择 + 五个格式弹窗 + 整库数据包（2026-10-18 从 Settings.tsx 搬出来）
   ------------------------------------------------------------
   搬出来的原因只有一条：**入口该长在知识库侧栏的 ＋ 菜单里**（2026-10-16 实测语雀），
   而点下去应该在**原地**弹出格式选择，不是把用户扔去设置页。

   原来的做法是侧栏「＋ → 导入…」跳 /settings?tab=data&import=1。
   那是**回避**而不是解决：语雀点一下就在当前知识库里弹框，我们却换了个页面，
   用户手里的上下文（他正要往哪个库里搬东西）整个丢了。

   所以整套搬成一个组件，**目录树与设置页渲染的是同一份** ——
   抄两遍就是下一处「同一份逻辑两处、必漏一处」。
   ============================================================ */

import { useState, useRef, useEffect } from 'react'
import { Button, Modal, Tag, Radio, Empty, Select, Input } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import { getMode } from '@/lib/api'
import { hydrate } from '@/lib/sync'
import { applyBundle } from '@/lib/io'
import { planImport, countDocs, treeDepth, previewBlocks, type ImportPlan, type ImportPlanNode, type ImportFile } from '@/lib/import-markdown'
import { readDocx } from '@/lib/docx'
import type { DocSheetData, SheetTab } from '@/types'
import { zipToImportFiles, readXlsx, parseCsv, decodeCsvBytes, sheetDataFromRows, isSpreadsheetName } from '@/lib/import-office'
import { parseLakebook, type LakebookParse } from '@/lib/lakebook'
import { markdownToBlocks, useStore } from '@/store'

/** 导入的六种格式（选择器里逐项列出） */
export type ImportKind = 'md' | 'zip' | 'docx' | 'sheet' | 'lake' | 'bundle'

/**
 * 导入对话框。目录树与设置页共用这一份。
 *
 * @param open      从外面点开入口；打开时先弹格式选择器（语雀就是这一步）
 * @param onClose   整个对话框结束
 * @param onResult  导入结果文案。设置页拿它显示在「导入」那一行下面，
 *                  目录树那边不传 —— 那边靠 toast，不需要第二处常驻文案。
 */
export function ImportDialog({ open, onClose, onResult, targetBookId }: {
  open: boolean
  onClose: () => void
  onResult?: (info: string) => void
  targetBookId?: string
}) {
  const { toast, books } = useStore()
  /** 结果往上抛；调用方没接就只走 toast */
  const report = (s: string) => { onResult?.(s) }

  /**
   * 目标库的名字，显示在选择器顶上。
   *
   * ⚠️ `books` 是**数组**（`Book[]`），不是按 id 索引的字典。
   * 写成 `books[targetBookId]` 查不到任何东西 —— 而如果顺手给个
   * `'未命名'` 之类的兜底，界面就会**自信地显示一个假名字**：
   * 真机实测就是这么翻车的（这本书明明叫「导入的 Word 文档」，
   * 提示却写「导入到当前知识库『未命名』」）。
   *
   * 一个写死的兜底比没有兜底更坏 —— 没有的时候至少知道自己没查到。
   */
  const targetBook = targetBookId ? books.find((b) => b.id === targetBookId) : undefined
  const targetHint = targetBookId
    ? targetBook
      ? `导入到当前知识库「${targetBook.name}」`
      : '导入到当前知识库（它的名字读不到了 —— 这一本可能刚被删除，导入会失败）'
    /*
     * ⚠️ 用户可见文案里**不写**「语雀在这里会让你选一个已有库」。
     * 那句是给开发者看的对照说明，而它出现在产品界面上有三个坏处：
     *   ① 品牌守卫只放行「源格式说明」这一类，它是第三类 → 每次都要加白名单，
     *      而白名单加多了，守卫就等于没有；
     *   ② 用户要的是「会新建一个知识库」这一句事实，对照说明对他没用；
     *   ③ 内网部署的终端用户不知道语雀是什么。
     * 对照写在这里（注释会被剥掉，也不会进产物）。
     */
    : '这次会新建一个知识库 —— 设置页那个入口没有库上下文'

  /**
   * 导入落到哪个知识库。
   *
   * 目录树那个入口带着 `targetBookId`（它就在某个库的目录里）——
   * 直接导进**当前这个库**，和语雀一致：官方 Lake 文档第 2 步写的就是
   * 「选择知识库的导入」，侧栏那个 ＋ 本来就长在某个库的目录中，
   * 导完东西当然还在这个库里。
   *
   * ⚠️ 之前这里是**无条件新建一个知识库**（`spaces[0]`）——
   * 于是「在书 A 的侧栏点导入，内容落进书 B」，界面在 A、动作在 B。
   * 那不只是别扭：新建库要**空间管理员**，而普通成员是有 A 的写权限的，
   * 于是他在自己正在编辑的库里点导入，一路走完到落库那一刻才被拒。
   *
   * 设置页那个入口没有库上下文（用户不在某个目录树里），才退回新建一个，
   * 并且由选择器把这句话**写在界面上**（见 `targetHint`）。
   */
  const resolveTarget = (title: string, desc: string): string => {
    if (targetBookId) return targetBookId
    const st = useStore.getState()
    const spaceId = st.spaces[0]?.id
    if (!spaceId) throw new Error('没有可用的空间')
    const id = st.createBook(spaceId, title, desc)
    /*
     * ⚠️ 必须判这个空串。`createBook` 在**不是空间管理员**时返回 `''`
     * （服务端 `denyReason` 的 books 分支只放行空间管理员）。
     *
     * 而下面拿它去 `createDoc(bookId, ...)` —— 空 bookId 过不了任何一道门：
     * `bookCreateBlocked('')` 读到的是 `null`（空 id → 「没问过」）→ 放行，
     * 于是建出一批 `bookId: ''` 的**孤儿文档**：同步不上去（服务端悬空外键），
     * 界面上也归不到任何库。而入口会照常报「导入完成，共 N 篇」+ 绿色成功 ——
     * 也就是说它一边说成功，一边往你的库里倒垃圾。
     *
     * 抛出即可：三个调用点都已经有 `catch` 会把这句话如实弹出来。
     */
    if (!id) throw new Error('你不是这个空间的管理员，没法在里面建知识库，导入没有开始（一个文档也没建）')
    return id
  }

  const [importMode, setImportMode] = useState<'replace' | 'merge'>('merge')
  const [importOpen, setImportOpen] = useState(false)
  const [mdOpen, setMdOpen] = useState(false)
  const [mdPlan, setMdPlan] = useState<ImportPlan | null>(null)
  const [mdBusy, setMdBusy] = useState(false)
  // docx 导入复用 Markdown 那条流水线：先解成 markdown，再交给 planImport，
  // 所以预览 / 确认 / 落库 / 权限判定全都不需要第二套实现。
  const [docxOpen, setDocxOpen] = useState(false)
  // zip 与 docx 一样：拆成一批带相对路径的文件 → planImport → runImport，
  // 预览/确认/落库/权限判定**全部复用**，不新开一条通路。
  const [zipOpen, setZipOpen] = useState(false)
  // 表格走的是另一条路：它不是 Markdown，落库时要写 sheetData 而不是正文块。
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetBusy, setSheetBusy] = useState(false)
  /* `items[].fileName` 是**原始文件名**（带扩展名），
     确认落库时按它去 `sheetRaw` 里找字节 ——
     `items[].name` 是给人看的短名（去掉了扩展名，多工作表还带 ` · 表名`），
     拿它去匹配原始文件名**永远匹配不上**，那正是「导入完成，共 0 篇」的成因。 */
  const [sheetPlan, setSheetPlan] = useState<{ title: string; items: { name: string; fileName: string; sheetName: string; rows: number; cols: number }[]; skipped: { name: string; reason: string }[] } | null>(null)
  /**
   * 原始字节暂存在这里（不进 state：它可能有几百 KB，
   * 放 state 会让每次输入都触发一轮深比较）。确认导入那一刻再读一次，
   * 免得预览和确认之间用户换了文件。
   */
  const sheetRaw = useRef<{ name: string; bytes: Uint8Array }[]>([])
  /**
   * 导入格式选择（2026-10-16 照语雀的形态改的）。
   *
   * 原来是设置页里**一排 5 个导入按钮**，而语雀是「一个入口 → 选格式」。
   * 一排按钮的问题不只是难看：每加一种格式就多一个按钮，
   * 而用户面对「Markdown / zip / Word / Excel / 语雀库 / 数据包」六个平级按钮
   * 根本不知道该点哪个 —— **入口多不等于好找**。
   */
  const [pickOpen, setPickOpen] = useState(false)

  /**
   * 导入进度（2026-10-16 照语雀补的）。
   *
   * 语雀是 5 态：等待中（并发 2，其余排队）/ 上传中（百分比）/ 处理中 / 失败 / 成功。
   * 我们**没有「上传」这一态** —— 解析在浏览器里做，文件根本没离开本机；
   * 照抄一个「上传 xx%」就是**说一个不存在的过程**（同一类假动作）。
   *
   * 所以对应成能说真话的那几态：
   *   解析中  解 zip / 读 xlsx —— 真在算，而且慢（大表格能卡几秒）
   *   写入中  一篇一篇建文档，报 N/M
   *   成功 / 失败
   */
  const [prog, setProg] = useState<{ phase: '解析中' | '写入中'; done: number; total: number } | null>(null)
  const [lakeOpen, setLakeOpen] = useState(false)
  const [lakeParsed, setLakeParsed] = useState<LakebookParse | null>(null)
  const [lakeBusy, setLakeBusy] = useState(false)

  /**
   * 从外面点开时先弹格式选择器。
   *
   * 语雀那个 `＋ → 导入…` 点下去**直接就是选格式**，
   * 中间没有别的页面、更没有别的页签 —— 这里保持一致。
   *
   * 只在 open 由 false 变 true 时重置：否则用户选了一个格式、弹窗盖住选择器时，
   * 父组件任何一次重渲染都会把选择器顶回来（他刚选的那一步就白做了）。
   */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setPickOpen(true)
    wasOpen.current = open
  }, [open])

  /**
   * 真正落库。
   *
   * 刻意**走已有的 store action**，不新开导入接口：
   * 这样导入出来的内容自动享有同一套能力 —— 服务端同步、权限、
   * 历史版本、回收站、跨设备可见，一样都不用额外做。
   * 另开一条导入通道的代价是这些能力全得再写一遍，且很容易漏。
   */
  const runImport = async (plan: ImportPlan, onProgress?: (done: number, total: number) => void): Promise<number> => {
    const st = useStore.getState()
    const bookId = resolveTarget(plan.title, `从 Markdown 导入，共 ${plan.fileCount} 篇`)

    let made = 0
    const total = countDocs(plan.tree)
    const walk = async (nodes: ImportPlanNode[], parentId: string | null) => {
      for (const n of nodes) {
        if (n.blocks) {
          const id = st.createDoc(bookId, parentId, n.title)
          // createDoc 之后要重新取 state：commit 是 set()，旧的 s 上没有新文档
          const cur = useStore.getState().docs[id]
          if (cur) {
            useStore.getState().setDocBlocks(id, [
              { id: `bk_h1_${Date.now().toString(36)}`, type: 'h1', text: n.title },
              ...n.blocks,
            ])
            made++
            onProgress?.(made, total)
          }
        } else if (n.title) {
          const gid = st.createNode(bookId, parentId, 'group')
          st.renameNode(gid, n.title)
          await walk(n.children, gid)
        } else {
          // 顶层：目录本身就是第一层分组
          await walk(n.children, parentId)
        }
      }
    }
    await walk(plan.tree, null)
    return made
  }

  /**
   * 表格落库。每个文件一篇**表格文稿**（`createDoc(..., 'sheet')`），
   * 内容写进 `sheetData`，不是正文块。
   *
   * 空 bookId 的护栏在 `resolveTarget` 里（三个落库函数共用一条）。
   *
   * ⚠️ 元素类型是 `SheetTab`，**不是** `DocSheetData['sheets']`：
   * 后者是 `{ sheets: SheetTab[]; activeId: string }` 这个对象本身，
   * 少写一层索引就等于在标注一个从来不存在的东西 ——
   * 运行时这批 `p.data` 是一个个塞进 `sheets: [...]` 的（见下面）。
   */
  const runSheetImport = async (plan: NonNullable<typeof sheetPlan>, payloads: { name: string; data: SheetTab }[], onProgress?: (done: number, total: number) => void): Promise<number> => {
    const st = useStore.getState()
    const bookId = resolveTarget(plan.title, `从表格导入，共 ${payloads.length} 篇`)

    let made = 0
    for (const p of payloads) {
      const id = st.createDoc(bookId, null, p.name, 'sheet')
      if (!id) continue
      // createDoc 之后要重新取 state：commit 是 set()，旧的 s 上没有新文档
      const cur = useStore.getState().docs[id]
      if (!cur) continue
      useStore.getState().updateDoc(id, {
        /*
         * ⚠️ 这里原来写的是 `sheets: [p.data], activeId: p.data.id` ——
         *   把**数组**塞进了 `sheets`，而 `SheetData` 期望的是
         *   `{ sheets: SheetTab[]; activeId: string }` 这个**对象**。
         *
         *   运行时 SheetView 走 `useDocSection(doc.id, 'sheets')`，
         *   它把 `doc.sheetData.sheets` 当 `SheetData` 用
         *   （`activeTab(data)` 会在里面 `.find()`）。
         *   也就是说**从 Excel / CSV 导进来的表格，打开是坏的** ——
         *   而解析器那一层完全正确（`test-import-office` 29 项全绿），
         *   所以没有任何一条断言会红。
         *
         *   是 `tsc` 抓到的：类型检查第一次把这个形状错误顶了出来。
         *   而在那之前 `npm run build` 一直是坏的，所以没人跑过这一步。
         */
        sheetData: {
          ...(cur.sheetData || {}),
          sheets: {
            ...(cur.sheetData?.sheets || { sheets: [] }),
            sheets: [p.data],
            activeId: p.data.id,
          },
        },
      })
      made++
      onProgress?.(made, payloads.length)
    }
    return made
  }

  /**
   * 落库语雀 .lakebook。
   *
   * 和 Markdown 导入一样**走已有的 store action**：权限、历史版本、回收站、
   * 跨设备同步全都自动继承。语雀的目录是「扁平列表 + level」，
   * 这里按 level 还原成树：level 变深就往下开一个分组，回浅就回到对应层级。
   */
  const runLakeImport = async (parsed: LakebookParse): Promise<number> => {
    const st = useStore.getState()
    const bookId = resolveTarget(parsed.title, `从语雀 .lakebook 导入，共 ${parsed.docs.length} 篇`)

    // 按 depth 记住「这一层对应的分组 id」
    const groupAt: (string | null)[] = [null]
    let made = 0
    for (const item of parsed.tree) {
      const depth = Math.max(0, item.depth)
      while (groupAt.length <= depth) groupAt.push(null)
      const parentId = groupAt[depth] ?? null
      if (item.depth > 0) {
        const gid = st.createNode(bookId, parentId, 'group')
        st.renameNode(gid, item.title)
        groupAt[depth] = gid
      }
      const did = st.createDoc(bookId, parentId, item.title)
      const cur = useStore.getState().docs[did]
      if (cur) {
        useStore.getState().setDocBlocks(did, [
          { id: `bk_h1_${Date.now().toString(36)}`, type: 'h1', text: item.title },
          ...item.doc.blocks,
        ])
        made++
      }
    }
    return made
  }

  return (
    <>
      <Modal
        open={mdOpen}
        onClose={() => setMdOpen(false)}
        title="导入 Markdown 文件夹"
        width={560}
        footer={
          <>
            <Button variant="text" onClick={() => setMdOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={!mdPlan || mdBusy}
              onClick={async () => {
                if (!mdPlan) return
                setMdBusy(true)
                setProg({ phase: '写入中', done: 0, total: countDocs(mdPlan.tree) })
                try {
                  const n = await runImport(mdPlan, (done, total) => setProg({ phase: '写入中', done, total }))
                  report(
                    `已导入「${mdPlan.title}」：${n} 篇文档（含 ${mdPlan.skipped.length} 个文件被跳过）`,
                  )
                  toast(`导入完成，共 ${n} 篇`, 'success')
                  setMdOpen(false)
                  setMdPlan(null)
                } catch (e: any) {
                  toast(e?.message || '导入失败', 'error')
                } finally {
                  setMdBusy(false)
                  setProg(null)
                }
              }}
            >
              {mdBusy ? '导入中…' : `确认导入 ${mdPlan ? countDocs(mdPlan.tree) : 0} 篇`}
            </Button>
          </>
        }
      >
        <div className="yq-import">
          <label className="yq-import-drop">
            <input
              type="file"
              multiple
              // 目录选择：非标准属性，主流浏览器都支持；不支持时可退化为多选文件
              {...({ webkitdirectory: '', directory: '' } as any)}
              onChange={async (e) => {
                const picked = Array.from(e.target.files || []) as any[]
                if (!picked.length) return
                setMdBusy(true)
                try {
                  const files = await Promise.all(
                    picked.filter((f) => /\.(md|markdown|mdown|txt)$/i.test(f.name))
                      .slice(0, 500)
                      .map(async (f) => ({
                        name: f.name,
                        webkitRelativePath: f.webkitRelativePath,
                        text: await f.text(),
                      })),
                  )
                  if (!files.length) { toast('没找到 Markdown 文件', 'error'); return }
                  setMdPlan(planImport(files, files[0].webkitRelativePath?.split('/')[0] || '导入的文档'))
                } catch (err: any) {
                  toast(err?.message || '读取文件失败', 'error')
                } finally {
                  setMdBusy(false)
                  e.target.value = ''
                }
              }}
            />
            <span>点击选择包含 .md 的文件夹（也可以多选文件）</span>
          </label>

          <ImportProgress prog={prog} />
          {mdPlan && (
            <div className="yq-mdplan">
              <div className="yq-mdplan-head">
                将创建知识库「{mdPlan.title}」：<b>{countDocs(mdPlan.tree)}</b> 篇文档，
                目录最深 {treeDepth(mdPlan.tree)} 层
              </div>
              <div className="yq-mdplan-tree">
                {mdPlan.tree.map((n, i) => <MdTreeNode key={i} node={n} depth={0} />)}
              </div>
              {!!mdPlan.skipped.length && (
                <div className="yq-mdplan-skip">
                  已跳过 {mdPlan.skipped.length} 个：{mdPlan.skipped.slice(0, 3).map((s) => s.name).join('、')}
                  {mdPlan.skipped.length > 3 ? ' 等' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ImportPicker
        open={pickOpen}
        /*
         * ⚠️ 这里**必须**往上报 `onClose()`，不能只 `setPickOpen(false)`。
         *
         * 真实翻过的车（2026-10-18 真机实测）：
         * 只关自己的话，调用方的 `open` 会一直停在 `true`，
         * 而本组件的 `wasOpen.current` 也停在 `true`。
         * 于是用户下一次点「导入…」时 `setImpOpen(true)` 是个**空操作** ——
         * `open` 没变、effect 不跑，弹窗再也不开。
         * 症状是「第一次能开，之后永远没反应」，而界面上没有任何报错。
         *
         * 选完格式时也一样：ImportPicker 内部是 `onClose(); onPick(...)`，
         * onClose 走的是这条路径（它只会把 impOpen 清掉，不影响 mdOpen 那些）。
         */
        onClose={() => { setPickOpen(false); onClose() }}
        targetHint={targetHint}
        onPick={(w) => {
          if (w === 'md') setMdOpen(true)
          else if (w === 'zip') setZipOpen(true)
          else if (w === 'docx') setDocxOpen(true)
          else if (w === 'sheet') setSheetOpen(true)
          else if (w === 'lake') setLakeOpen(true)
          else setImportOpen(true)
        }}
      />

      <Modal
        open={docxOpen}
        onClose={() => { setDocxOpen(false); setMdPlan(null) }}
        title="导入 Word（.docx）"
        width={560}
        footer={
          <>
            <Button variant="text" onClick={() => { setDocxOpen(false); setMdPlan(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={!mdPlan || mdBusy}
              onClick={async () => {
                if (!mdPlan) return
                setMdBusy(true)
                setProg({ phase: '写入中', done: 0, total: countDocs(mdPlan.tree) })
                try {
                  const n = await runImport(mdPlan, (done, total) => setProg({ phase: '写入中', done, total }))
                  report(
                    `已导入「${mdPlan.title}」：${n} 篇文档` +
                    (mdPlan.skipped.length ? `（${mdPlan.skipped.length} 个文件被跳过）` : ''),
                  )
                  toast(`导入完成，共 ${n} 篇`, 'success')
                  setDocxOpen(false)
                  setMdPlan(null)
                } catch (e: any) {
                  toast(e?.message || '导入失败', 'error')
                } finally {
                  setMdBusy(false)
                  setProg(null)
                }
              }}
            >
              {mdBusy ? '导入中…' : `确认导入 ${mdPlan ? countDocs(mdPlan.tree) : 0} 篇`}
            </Button>
          </>
        }
      >
        <div className="yq-import">
          <label className="yq-import-drop">
            <input
              type="file"
              multiple
              accept=".docx"
              onChange={async (e) => {
                const picked = Array.from(e.target.files || []) as any[]
                if (!picked.length) return
                setMdBusy(true)
                try {
                  /**
                   * 逐个解，**逐个报错**而不是整批失败。
                   * 公司里常见的是「一批 Word 里有一个是 .doc 老格式」，
                   * 整批黄了等于这批都白选。
                   */
                  const files: ImportFile[] = []
                  const bad: string[] = []
                  for (const f of picked.filter((x) => /\.docx$/i.test(x.name)).slice(0, 200)) {
                    try {
                      const buf = new Uint8Array(await f.arrayBuffer())
                      const { title, markdown } = readDocx(buf)
                      if (!markdown.trim()) { bad.push(`${f.name}（内容是空的）`); continue }
                      files.push({
                        name: `${title || f.name.replace(/\.docx$/i, '')}.md`,
                        webkitRelativePath: f.name,
                        text: markdown,
                      })
                    } catch (err: any) {
                      bad.push(`${f.name}（${err?.message || '解析失败'}）`)
                    }
                  }
                  if (!files.length) {
                    toast(bad.length ? `没一个能读：${bad.slice(0, 2).join('；')}` : '没找到 .docx 文件', 'error')
                    return
                  }
                  const plan = planImport(files, '导入的 Word 文档')
                  if (bad.length) {
                    plan.skipped.push(...bad.map((b) => ({ name: b, reason: '不是可读的 .docx' })))
                    toast(`${files.length} 个可读，${bad.length} 个跳过`, 'info')
                  }
                  setMdPlan(plan)
                } catch (err: any) {
                  toast(err?.message || '读取文件失败', 'error')
                } finally {
                  setMdBusy(false)
                  e.target.value = ''
                }
              }}
            />
            <span>点击选择 .docx 文件（可多选；每个文件一篇文档）</span>
          </label>

          <ImportProgress prog={prog} />
          {mdPlan && (
            <div className="yq-mdplan">
              <div className="yq-mdplan-head">
                将创建知识库「{mdPlan.title}」：<b>{countDocs(mdPlan.tree)}</b> 篇文档
              </div>
              <div className="yq-mdplan-tree">
                {mdPlan.tree.map((n, i) => <MdTreeNode key={i} node={n} depth={0} />)}
              </div>
              {!!mdPlan.skipped.length && (
                <div className="yq-mdplan-skip">
                  已跳过 {mdPlan.skipped.length} 个：{mdPlan.skipped.slice(0, 3).map((s) => s.name).join('、')}
                  {mdPlan.skipped.length > 3 ? ' 等' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* zip 导入 —— 和 docx 一样复用 mdPlan / runImport 那条流水线 */}
      <Modal
        open={zipOpen}
        onClose={() => { setZipOpen(false); setMdPlan(null) }}
        title="导入 zip（Markdown + 目录结构）"
        width={560}
        footer={
          <>
            <Button variant="text" onClick={() => { setZipOpen(false); setMdPlan(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={!mdPlan || mdBusy}
              onClick={async () => {
                if (!mdPlan) return
                setMdBusy(true)
                setProg({ phase: '写入中', done: 0, total: countDocs(mdPlan.tree) })
                try {
                  const n = await runImport(mdPlan, (done, total) => setProg({ phase: '写入中', done, total }))
                  report(`已导入「${mdPlan.title}」：${n} 篇文档` + (mdPlan.skipped.length ? `（${mdPlan.skipped.length} 个文件被跳过）` : ''))
                  toast(`导入完成，共 ${n} 篇`, 'success')
                  setZipOpen(false)
                  setMdPlan(null)
                } catch (err: any) {
                  toast(err?.message || '导入失败', 'error')
                } finally {
                  setMdBusy(false)
                  setProg(null)
                }
              }}
            >
              {mdBusy ? '导入中…' : `确认导入 ${mdPlan ? countDocs(mdPlan.tree) : 0} 篇`}
            </Button>
          </>
        }
      >
        <div>
          <label className="yq-md-drop">
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={async (e) => {
                const f = (e.target.files || [])[0] as any
                e.target.value = ''
                if (!f) return
                setMdBusy(true)
                try {
                  const { files, skipped } = await zipToImportFiles(new Uint8Array(await f.arrayBuffer()))
                  if (!files.length) {
                    toast(skipped.length ? `包里没有可导入的 Markdown：${skipped.slice(0, 2).map((s) => s.name).join('；')}` : '这个 zip 里没有 .md 文件', 'error')
                    return
                  }
                  const plan = planImport(files, f.name.replace(/\.zip$/i, ''))
                  plan.skipped.push(...skipped)
                  setMdPlan(plan)
                } catch (err: any) {
                  toast(err?.message || '读取 zip 失败', 'error')
                } finally {
                  setMdBusy(false)
                  setProg(null)
                }
              }}
            />
            <span>点击选择 .zip 文件（包里的 .md 会按目录层级变成目录树）</span>
          </label>

          <ImportProgress prog={prog} />
          {mdPlan && (
            <div className="yq-mdplan">
              <div className="yq-mdplan-head">
                将创建知识库「{mdPlan.title}」：<b>{countDocs(mdPlan.tree)}</b> 篇文档，
                目录最深 {treeDepth(mdPlan.tree)} 层
              </div>
              <div className="yq-mdplan-tree">
                {mdPlan.tree.map((n, i) => <MdTreeNode key={i} node={n} depth={0} />)}
              </div>
              {!!mdPlan.skipped.length && (
                <div className="yq-mdplan-skip">
                  已跳过 {mdPlan.skipped.length} 个：{mdPlan.skipped.slice(0, 3).map((s) => s.name).join('、')}
                  {mdPlan.skipped.length > 3 ? ' 等' : ''}
                  <div style={{ marginTop: 4, color: 'var(--yq-text-3)' }}>
                    {mdPlan.skipped.find((s) => s.reason.includes('图片'))?.reason || ''}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* Excel / CSV 导入 —— 落成表格文稿，不是 Markdown 文档 */}
      <Modal
        open={sheetOpen}
        onClose={() => { setSheetOpen(false); setSheetPlan(null) }}
        title="导入 Excel / CSV"
        width={560}
        footer={
          <>
            <Button variant="text" onClick={() => { setSheetOpen(false); setSheetPlan(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={!sheetPlan || sheetBusy || !sheetPlan.items.length}
              onClick={async () => {
                if (!sheetPlan) return
                setSheetBusy(true)
                try {
                  /* 这里重新读一遍文件：预览阶段已经读过，但那是异步的，
                     预览和确认之间用户可能已经换过选择 —— 与其信一份
                     内存里的旧结果，不如确认这一刻再读一次。 */
                  setSheetBusy(true)
                  setProg({ phase: '解析中', done: 0, total: sheetPlan.items.length })
                  const payloads: { name: string; data: any }[] = []
                  for (const it of sheetPlan.items) {
                    /* 按**原始文件名**找（item 上那一列），不是按显示用的短名 */
                    const src = (sheetRaw.current || []).find((x) => x.name === it.fileName)
                    if (!src) continue
                    const rows = /\.csv$/i.test(src.name) ? parseCsv(decodeCsvBytes(src.bytes)) : await readXlsx(src.bytes).then((s) => s.find((x) => x.name === it.sheetName)?.rows || [])
                    const data = sheetDataFromRows(it.sheetName, rows)
                    payloads.push({ name: it.name, data })
                  }
                  setProg({ phase: '写入中', done: 0, total: payloads.length })
                  const n = await runSheetImport(sheetPlan, payloads, (done, total) => setProg({ phase: '写入中', done, total }))
                  report(`已导入「${sheetPlan.title}」：${n} 篇表格`)
                  toast(`导入完成，共 ${n} 篇表格`, 'success')
                  setSheetOpen(false)
                  setSheetPlan(null)
                  sheetRaw.current = []
                } catch (err: any) {
                  toast(err?.message || '导入失败', 'error')
                } finally {
                  setSheetBusy(false)
                  setProg(null)
                }
              }}
            >
              {sheetBusy ? '导入中…' : `确认导入 ${sheetPlan?.items.length || 0} 篇表格`}
            </Button>
          </>
        }
      >
        <div>
          <label className="yq-md-drop">
            <input
              type="file"
              multiple
              accept=".xlsx,.csv"
              onChange={async (e) => {
                const picked = Array.from(e.target.files || []) as any[]
                e.target.value = ''
                if (!picked.length) return
                setSheetBusy(true)
                try {
                  const items: NonNullable<typeof sheetPlan>['items'] = []
                  const skipped: { name: string; reason: string }[] = []
                  const raw: { name: string; bytes: Uint8Array }[] = []
                  for (const f of picked.slice(0, 200)) {
                    if (!isSpreadsheetName(f.name)) {
                      skipped.push({ name: f.name, reason: /\.(doc|xls)$/i.test(f.name) ? '老格式（.doc / .xls）是二进制私有格式，本项目不支持' : '不是 .xlsx / .csv' })
                      continue
                    }
                    try {
                      const bytes = new Uint8Array(await f.arrayBuffer())
                      const sheets = /\.csv$/i.test(f.name)
                        ? [{ name: f.name.replace(/\.csv$/i, ''), rows: parseCsv(decodeCsvBytes(bytes)) }]
                        : await readXlsx(bytes)
                      if (!sheets.length) { skipped.push({ name: f.name, reason: '里面没有数据' }); continue }
                      for (const sh of sheets) {
                        items.push({
                          name: sheets.length > 1 ? `${f.name.replace(/\.[^.]+$/, '')} · ${sh.name}` : f.name.replace(/\.[^.]+$/, ''),
                          /**
                           * ⚠️ 这一列是新加的，而且**不是可有可无**。
                           *
                           * 原来确认时是 `sheetRaw.find((x) => x.name === it.name)` ——
                           * 而 `it.name` 是**去掉扩展名**的（`表格夹具`），
                           * `x.name` 是**带扩展名**的（`表格夹具.csv`）。
                           * 于是这个 find **永远找不到**，payloads 恒为空，
                           * `runSheetImport` 返回 0，界面还弹一个**绿色的**
                           * 「导入完成，共 0 篇表格」。
                           *
                           * 也就是说 **Excel / CSV 导入从来没真正落过库** ——
                           * 而 `test-import-office` 29 项全绿，因为它验的是
                           * 「能不能把 xlsx 读成 SheetTab」，**不验读出来的东西
                           * 有没有被正确地存回去**。
                           *
                           * 多工作表那条（`名称 · Sheet1`）更是对不上任何文件名。
                           * 改成记下原始文件名，按它找。
                           */
                          fileName: f.name,
                          sheetName: sh.name,
                          rows: sh.rows.length,
                          cols: Math.max(...sh.rows.map((r) => r.length)),
                        })
                      }
                      raw.push({ name: f.name, bytes })
                    } catch (err: any) {
                      skipped.push({ name: f.name, reason: err?.message || '解析失败' })
                    }
                  }
                  sheetRaw.current = raw
                  if (!items.length) {
                    toast(skipped.length ? `没一个能读：${skipped.slice(0, 2).map((s) => `${s.name}（${s.reason}）`).join('；')}` : '没找到 .xlsx / .csv', 'error')
                    return
                  }
                  setSheetPlan({ title: '导入的表格', items, skipped })
                  if (skipped.length) toast(`${items.length} 个可读，${skipped.length} 个跳过`, 'info')
                } catch (err: any) {
                  toast(err?.message || '读取文件失败', 'error')
                } finally {
                  setSheetBusy(false)
                }
              }}
            />
            <span>点击选择 .xlsx / .csv 文件（可多选；每个工作表一篇表格文稿）</span>
          </label>

          <p className="yq-settings-hint" style={{ marginTop: 8 }}>
            只取单元格的值：公式、合并单元格、样式、日期格式都不还原（日期会显示成序列号）。
          </p>

          <ImportProgress prog={prog} />
          {sheetPlan && (
            <div className="yq-mdplan">
              <div className="yq-mdplan-head">
                将创建知识库「{sheetPlan.title}」：<b>{sheetPlan.items.length}</b> 篇表格
              </div>
              <div className="yq-mdplan-tree">
                {sheetPlan.items.map((it, i) => (
                  <div key={i} style={{ fontSize: 13, padding: '3px 0' }}>
                    {it.name} —— {it.rows} 行 × {it.cols} 列
                  </div>
                ))}
              </div>
              {!!sheetPlan.skipped.length && (
                <div className="yq-mdplan-skip">
                  已跳过 {sheetPlan.skipped.length} 个：{sheetPlan.skipped.slice(0, 3).map((s) => `${s.name}（${s.reason}）`).join('、')}
                  {sheetPlan.skipped.length > 3 ? ' 等' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={lakeOpen}
        onClose={() => { setLakeOpen(false); setLakeParsed(null) }}
        title="导入语雀知识库（.lakebook）"
        width={560}
        footer={
          <>
            <Button variant="text" onClick={() => { setLakeOpen(false); setLakeParsed(null) }}>取消</Button>
            <Button
              variant="primary"
              disabled={!lakeParsed || lakeBusy}
              onClick={async () => {
                if (!lakeParsed) return
                setLakeBusy(true)
                try {
                  const n = await runLakeImport(lakeParsed)
                  report(
                    `已导入「${lakeParsed.title}」：${n} 篇文档` +
                    (lakeParsed.warnings.length ? `（${lakeParsed.warnings.length} 条提示见导入时说明）` : ''),
                  )
                  toast(`导入完成，共 ${n} 篇`, 'success')
                  setLakeOpen(false)
                  setLakeParsed(null)
                } catch (e: any) {
                  toast(e?.message || '导入失败', 'error')
                } finally {
                  setLakeBusy(false)
                }
              }}
            >
              {lakeBusy ? '导入中…' : `确认导入 ${lakeParsed ? lakeParsed.docs.length : 0} 篇`}
            </Button>
          </>
        }
      >
        <div className="yq-import">
          <label className="yq-import-drop">
            <input
              type="file"
              accept=".lakebook,application/octet-stream,application/gzip"
              onChange={async (e) => {
                const f = (e.target.files || [])[0] as any
                e.target.value = ''
                if (!f) return
                setLakeBusy(true)
                try {
                  const buf = await f.arrayBuffer()
                  setLakeParsed(await parseLakebook(buf, markdownToBlocks))
                } catch (err: any) {
                  setLakeParsed(null)
                  toast(err?.message || '解析失败', 'error')
                } finally {
                  setLakeBusy(false)
                }
              }}
            />
            <span>点击选择从语雀「知识库设置 → 导出」得到的 .lakebook 文件</span>
          </label>

          {lakeParsed && (
            <div className="yq-mdplan">
              <div className="yq-mdplan-head">
                将创建知识库「<b>{lakeParsed.title}</b>」：<b>{lakeParsed.docs.length}</b> 篇文档，
                目录最深 {Math.max(0, ...lakeParsed.tree.map((t) => t.depth)) + 1} 层
              </div>
              <div className="yq-mdplan-tree">
                {lakeParsed.tree.map((t, i) => (
                  <div key={i} className="yq-bset-member" style={{ paddingLeft: 8 + t.depth * 18 }}>
                    <span className="yq-bset-member-id">{t.depth > 0 ? '└ ' : ''}{t.title}</span>
                    <span className="yq-bset-member-role">
                      {t.doc.kind !== '文档' ? `${t.doc.kind}（会降级）` : `${t.doc.blocks.length} 块`}
                    </span>
                    <span />
                  </div>
                ))}
              </div>
              {!!lakeParsed.warnings.length && (
                <div className="yq-mdplan-skip">
                  {lakeParsed.warnings.slice(0, 5).map((w, i) => <div key={i}>· {w}</div>)}
                  {lakeParsed.warnings.length > 5 ? `…共 ${lakeParsed.warnings.length} 条` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="导入数据包"
        footer={<Button variant="text" onClick={() => setImportOpen(false)}>关闭</Button>}
      >
        <div className="yq-import">
          <Radio
            checked={importMode === 'merge'}
            onChange={() => setImportMode('merge')}
            name="import-mode"
          >
            合并到当前数据（同名条目以导入包为准，其他保留）
          </Radio>
          <Radio
            checked={importMode === 'replace'}
            onChange={() => setImportMode('replace')}
            name="import-mode"
          >
            整体替换（当前所有内容会被清空）
          </Radio>

          <label className="yq-import-drop">
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                const text = await f.text()
                /*
                 * ⚠️ 「整体替换」必须再确认一次。
                 * 它是**这个库里唯一一个由一次点击就触发、又不可撤销**的操作：
                 * 选文件的那一下 `onChange` 直接就导入了，而红色警告只是**静态文字**。
                 * 误选一个文件 = 全库的书和节点被硬删（文档进回收站还能救）。
                 *
                 * 语义说明（别再照着旧注释以为它是安全的）：
                 * 它删的是「包里没有的行」，收窄范围的只有 `deleteRow` 的逐条判权 ——
                 * 普通成员删不动别人的东西，而**平台 owner 会把全库删干净**
                 *（`denyReason` 对 owner 早退放行，见 server/sync.ts 的 importBundle）。
                 *
                 * 和 purge、删知识库那些地方一样，这里也用原生 confirm ——
                 * 不引入新组件，行为和全项目其它不可撤销操作保持一致。
                 */
                if (importMode === 'replace' && !confirm(
                  `整体替换会清空本实例里**这个数据包没有的内容**。\n` +
                  `知识库、目录、评论会被直接删除（文档进回收站，30 天后清除）。此操作不可撤销。\n\n` +
                  `确定继续导入「${f.name}」吗？`,
                )) {
                  e.target.value = ''
                  return
                }
                try {
                  if (getMode() === 'server') {
                    /**
                     * 服务端形态下必须走服务端导入。
                     * 客户端那条路只改本地 store，而它只有元信息 ——
                     * 「整体替换」会把这些空壳推上去，等于清空全库正文。
                     * 交给服务端还有个好处：逐条判权限，普通成员覆盖不了别人的东西。
                     */
                    const raw = JSON.parse(text)
                    const { serverImport } = await import('@/lib/api')
                    const r = await serverImport(raw, importMode)
                    const c = r.counts || {}
                    report(
                      `导入成功（${importMode === 'merge' ? '合并' : '替换'}）：` +
                      `${c.spaces || 0} 个空间 / ${c.books || 0} 个知识库 / ${c.docs || 0} 篇文档` +
                      (r.rejected ? `，${r.rejected} 条因权限被跳过` : ''),
                    )
                    toast('数据包已导入', 'success')
                    await hydrate()
                    setImportOpen(false)
                    e.target.value = ''
                    return
                  }
                  const r = applyBundle(text, importMode)
                  if (r.ok) {
                    report(
                      `导入成功（${r.mode === 'merge' ? '合并' : '替换'}）：` +
                      `${r.counts!.spaces} 个空间 / ${r.counts!.books} 个知识库 / ${r.counts!.docs} 篇文档`,
                    )
                    toast('数据包已导入', 'success')
                    setImportOpen(false)
                  } else {
                    report('导入失败：' + r.error)
                  }
                } catch (err: any) {
                  report('导入失败：' + (err?.message || '文件不是合法的 JSON'))
                }
                e.target.value = ''
              }}
            />
            <span>点击选择 .json 数据包文件</span>
          </label>

          <p className="yq-settings-hint">
            数据包格式由本页「导出整个工作台」生成。换浏览器、换设备、或把文档带给同事，都走这条路。
            {importMode === 'replace' && <b style={{ color: 'var(--yq-danger)' }}> 当前数据会被清空且不可撤销。</b>}
          </p>
        </div>
      </Modal>

    </>
  )
}

/**
 * 导入格式选择（2026-10-16 照语雀「一个入口 → 选格式」的形态；
 *  2026-10-18 跟着整套搬进 ImportDialog，目录树也用它）。
 *
 * 关键点是**只有一个按钮**，不是把按钮藏进下拉 ——
 * 语雀那个 `＋` 下面本来就是一串新建项，导入是其中一项。
 *
 * 每一项只做一件事：关掉自己、打开对应那个已有的弹窗。
 * **不复用任何导入逻辑** —— 那几个弹窗各自已经跑通了，
 * 这里只做路由，抄一遍就等于多一份会腐烂的实现。
 *
 * 顶上那行 `targetHint` 是**必须**的：这个框在「某个库里面」和「设置页里」
 * 两处都会出现，而两处的落点不同（当前库 / 新建一个库）。
 * 不写出来，用户就只能靠导完之后翻遍知识库列表才知道东西去哪了。
 */
function ImportPicker({ open, onClose, onPick, targetHint }: {
  open: boolean
  onClose: () => void
  onPick: (which: 'md' | 'zip' | 'docx' | 'sheet' | 'lake' | 'bundle') => void
  /** 落到哪个库 —— 必须写在界面上，而不是让用户自己猜 */
  targetHint: string
}) {
  const ITEMS: { k: 'md' | 'zip' | 'docx' | 'sheet' | 'lake' | 'bundle'; icon: string; name: string; ext: string; desc: string }[] = [
    { k: 'md', icon: '📝', name: 'Markdown 文件夹', ext: '.md', desc: '文件夹结构变成目录树，源码自动转成块' },
    { k: 'zip', icon: '🗜️', name: 'zip 压缩包', ext: '.zip', desc: '包里按目录层级还原；⚠️ 图片不跟着上传' },
    { k: 'docx', icon: '📘', name: 'Word 文档', ext: '.docx', desc: '可多选，每个文件一篇文档' },
    { k: 'sheet', icon: '📊', name: 'Excel / CSV', ext: '.xlsx .csv', desc: '每个工作表一篇表格；⚠️ 公式与样式不还原' },
    { k: 'lake', icon: '🪺', name: '语雀知识库', ext: '.lakebook', desc: '整库的目录树与文档一起搬进来；⚠️ 尚未用真实导出验证过，第一次先拿一个不重要的库试' },
    { k: 'bundle', icon: '📦', name: '本系统数据包', ext: '.json', desc: '整体替换或与当前数据合并' },
  ]
  return (
    <Modal open={open} onClose={onClose} title="选择要导入的格式" width={520}
      footer={<Button variant="text" onClick={onClose}>取消</Button>}>
      <div className="yq-imppick">
        <div className="yq-imppick-target" data-testid="import-target">导入到哪里：{targetHint}</div>
        {ITEMS.map((it) => (
          <button
            key={it.k}
            className="yq-imppick-item"
            onClick={() => { onClose(); onPick(it.k) }}
          >
            <span className="yq-imppick-icon">{it.icon}</span>
            <span className="yq-imppick-main">
              <span className="yq-imppick-name">
                {it.name}
                <code className="yq-imppick-ext">{it.ext}</code>
              </span>
              <span className="yq-imppick-desc">{it.desc}</span>
            </span>
          </button>
        ))}
        <p className="yq-settings-hint" style={{ marginTop: 12 }}>
          暂不支持：<b>.doc</b>、<b>.xls</b>（老二进制格式）、<b>Evernote 导出包</b>。
          原因见设置页下面那段说明。选到这些文件会被直接拒绝并说清原因，不会导入出半份内容。
        </p>
      </div>
    </Modal>
  )
}

/**
 * 导入进度条。语雀那 5 态里我们只说能说真话的（见 `prog` 的注释）。
 *
 * 刻意**不给「上传」**：文件没离开本机，报一个上传百分比是在说谎。
 */
function ImportProgress({ prog }: { prog: { phase: '解析中' | '写入中'; done: number; total: number } | null }) {
  if (!prog) return null
  const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0
  return (
    <div className="yq-impprog" data-testid="import-progress">
      <div className="yq-impprog-head">
        <span>
          {prog.phase}
          {prog.phase === '写入中' && prog.total > 0 ? ` ${prog.done}/${prog.total}` : ''}
        </span>
        <span className="yq-impprog-pct">{prog.phase === '写入中' ? `${pct}%` : ''}</span>
      </div>
      <div className="yq-impprog-track">
        <div
          className="yq-impprog-bar"
          style={{ width: prog.phase === '解析中' ? '100%' : `${pct}%` }}
          data-indeterminate={prog.phase === '解析中' ? '1' : '0'}
        />
      </div>
    </div>
  )
}

/** 导入预览里的目录树节点。叶子顺带show出转换后的前几行，确认没跑偏。 */
function MdTreeNode({ node, depth }: { node: ImportPlanNode; depth: number }) {
  const [open, setOpen] = useState(true)
  if (node.blocks) {
    return (
      <div className="yq-mdplan-leaf" style={{ paddingLeft: depth * 14 }}>
        <span className="yq-mdplan-doc">📄 {node.title}</span>
        <pre className="yq-mdplan-preview">{previewBlocks(node.blocks)}</pre>
      </div>
    )
  }
  if (!node.title) {
    return <>{node.children.map((c, i) => <MdTreeNode key={i} node={c} depth={depth} />)}</>
  }
  return (
    <div className="yq-mdplan-dir" style={{ paddingLeft: depth * 14 }}>
      <button type="button" className="yq-mdplan-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} 📁 {node.title}
        <span className="yq-mdplan-count">{countDocs([node])} 篇</span>
      </button>
      {open && node.children.map((c, i) => <MdTreeNode key={i} node={c} depth={depth + 1} />)}
    </div>
  )
}


export default ImportDialog
