import { LocalMediaBase } from './LocalMedia'
import type { CardProps } from './types'
import type { LocalData } from './LocalMedia'

/** 本地视频：真的能播（data URL 塞进 <video>） */
export default function LocalVideoCard({ data, onChange, readOnly }: CardProps<LocalData>) {
  return (
    <LocalMediaBase
      data={data || {}}
      onChange={onChange}
      readOnly={readOnly}
      icon="🎬"
      title="本地视频"
      desc={data?.name || '选一个视频文件'}
      accept="video/*"
      emptyHint="选择 mp4 / webm，插入后可直接播放（文件大的话请改用网盘链接）"
      render={(d) => <video className="yq-kc-media" controls src={d.dataUrl} />}
    />
  )
}
