import { LocalMediaBase } from './LocalMedia'
import type { CardProps } from './types'
import type { LocalData } from './LocalMedia'

/** 本地音频：真的能播（data URL 塞进 <audio>） */
export default function LocalAudioCard({ data, onChange, readOnly }: CardProps<LocalData>) {
  return (
    <LocalMediaBase
      data={data || {}}
      onChange={onChange}
      readOnly={readOnly}
      icon="🎵"
      title="本地音频"
      desc={data?.name || '选一个音频文件'}
      accept="audio/*"
      emptyHint="选择 mp3 / wav / ogg，插入后可直接播放"
      render={(d) => <audio className="yq-kc-media" controls src={d.dataUrl} />}
    />
  )
}
