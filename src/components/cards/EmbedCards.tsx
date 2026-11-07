import { EmbedCardBase, type EmbedProvider } from './EmbedCard'
import type { CardProps } from './types'
import type { EmbedData } from './EmbedCard'

/* ============================================================
   六个第三方服务的 URL → 嵌入地址解析
   规则：能拿到官方 player 域名的就给真 iframe；
   拿不到的（掘金 / 高德需要 JS key）就退化成占位框 + 原文链接，不假装能嵌。
   ============================================================ */

const youku: EmbedProvider = {
  id: 'youku',
  icon: '📺',
  name: '优酷',
  hint: '粘贴优酷分享链接',
  example: 'https://v.youku.com/v_show/id_XNTg4NzQy.html',
  note: '优酷的播放器需要联网；如果被优酷的防盗链拦住，会显示空白，点下面链接在新标签看。',
  parse: (url) => {
    const m = url.match(/id_([A-Za-z0-9=_-]+)/)
    if (!m) return null
    return { src: `https://player.youku.com/embed/${m[1]}`, link: url, label: `优酷视频 ${m[1].slice(0, 12)}…` }
  },
}

const bilibili: EmbedProvider = {
  id: 'bilibili',
  icon: '📺',
  name: '哔哩哔哩',
  hint: '粘贴 B 站视频链接',
  example: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  note: 'B 站官方播放器 iframe，需要联网。B 站也可能对未登录的嵌入做限制，空白时点链接新标签打开。',
  parse: (url) => {
    const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/) || url.match(/[?&]bvid=(BV[0-9A-Za-z]+)/)
    if (bv) return { src: `https://player.bilibili.com/player.html?bvid=${bv[1]}&autoplay=0&high_quality=1`, link: url, label: `B 站 ${bv[1]}` }
    const av = url.match(/\/video\/av(\d+)/i) || url.match(/[?&]aid=(\d+)/)
    if (av) return { src: `https://player.bilibili.com/player.html?aid=${av[1]}&autoplay=0`, link: url, label: `B 站 av${av[1]}` }
    return null
  },
}

const netease: EmbedProvider = {
  id: 'netease',
  icon: '🎵',
  name: '网易云音乐',
  hint: '粘贴网易云音乐链接',
  example: 'https://music.163.com/#/song?id=1824045033',
  note: '网易云的官方外链播放器，需要联网。歌单链接（playlist）同样支持。',
  parse: (url) => {
    const m = url.match(/[?&]id=(\d+)/) || url.match(/\/(song|playlist|album)\/(\d+)/)
    if (!m) return null
    const id = m[2] || m[1]
    return { src: `https://music.163.com/outreach/player?id=${id}&autoPlay=false`, link: url, label: `网易云 ${id}` }
  },
}

const amap: EmbedProvider = {
  id: 'amap',
  icon: '🗺',
  name: '高德地图',
  hint: '粘贴高德地图链接（含地点名 / 坐标）',
  example: 'https://m.amap.com/search/mapview/keywords=西湖',
  note:
    '高德官方地图嵌入需要申请 JS API key（个人密钥有配额限制），本地复刻没有 key。' +
    '这里嵌的是高德移动端公开搜索页，同样需要联网。',
  parse: (url) => {
    const q = decodeURIComponent(url.match(/[?&]q=([^&]+)/)?.[1] || url.match(/keywords=([^/?#]+)/)?.[1] || '')
    if (q) {
      return {
        src: `https://m.amap.com/search/mapview/keywords=${encodeURIComponent(q)}`,
        link: url,
        label: `高德地图「${q}」`,
      }
    }
    if (/amap\.com/.test(url)) return { src: null, link: url, label: '高德地图链接' }
    return null
  },
}

const figma: EmbedProvider = {
  id: 'figma',
  icon: '🎨',
  name: 'Figma',
  hint: '粘贴 Figma 文件链接',
  example: 'https://www.figma.com/file/abc123/My-Design',
  note: 'Figma 官方 embed，需要联网，并且文件本身要开「任何有链接的人可查看」。私有文件会显示空白。',
  parse: (url) => {
    const m = url.match(/figma\.com\/(file|design|board|proto|slides)\/([A-Za-z0-9]+)/)
    if (!m) return null
    return {
      src: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`,
      link: url,
      label: `Figma ${m[1]} ${m[2].slice(0, 8)}…`,
    }
  },
}

const juejin: EmbedProvider = {
  id: 'juejin',
  icon: '⛏',
  name: '码上掘金',
  hint: '粘贴掘金文章链接',
  example: 'https://juejin.cn/post/7309335877025186322',
  note: '掘金没有对外的 iframe 嵌入接口（文章页禁止被嵌），所以这里只给一个带原文链接的占位框。',
  parse: (url) => {
    const m = url.match(/juejin\.cn\/post\/([0-9a-zA-Z]+)/)
    if (!m) return null
    return { src: null, link: url, label: `掘金文章 ${m[1]}` }
  },
}

export function YoukuCard(p: CardProps<EmbedData>) {
  return <EmbedCardBase {...p} provider={youku} />
}
export function BilibiliCard(p: CardProps<EmbedData>) {
  return <EmbedCardBase {...p} provider={bilibili} />
}
export function NeteaseCard(p: CardProps<EmbedData>) {
  return <EmbedCardBase {...p} provider={netease} />
}
export function AmapCard(p: CardProps<EmbedData>) {
  return <EmbedCardBase {...p} provider={amap} />
}
export function FigmaCard(p: CardProps<EmbedData>) {
  return <EmbedCardBase {...p} provider={figma} />
}
export function JuejinCard(p: CardProps<EmbedData>) {
  return <EmbedCardBase {...p} provider={juejin} />
}
