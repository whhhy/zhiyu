import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { useStore } from '@/store'
import { attachFileToDoc } from '@/components/cards/common'
import { resolveFileUrl } from '@/lib/attachment-store'
import { getMode } from '@/lib/api'
import { __debugCompare, __diffProbe, __resetDiffProbe } from '@/lib/sync'
import './styles/global.css'
import './styles/login.css'
import './styles/skeleton.css'

// 调试入口：便于自动化测试与控制台排查
;(window as any).__yqStore = useStore
// 附件上传的收口函数。附件卡片都从这里存文件，
// 测试直接调它就能验证真实上传路径，不必去点 file input。
// resolveFileUrl 一并暴露：它决定「这份附件还在不在」，
// 而「403 不该被说成文件丢了」这种判断只在它身上（见 test-attachgone）。
;(window as any).__yqAttach = { attachFileToDoc, resolveFileUrl }
;(window as any).__yqMode = getMode
;(window as any).__yqDebugCompare = __debugCompare
;(window as any).__yqDiffProbe = { get: __diffProbe, reset: __resetDiffProbe }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
