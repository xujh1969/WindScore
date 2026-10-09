import { useState } from 'react';
import { addPart, assembleParts, scoreParts } from '../parts';
import { addLyricTrack, configureLyricTrack, lyricTrackNames, removeLyricTrack } from '../lyrics';
import type { Score } from '../types';

export function TrackDialog({ score, partId, verse, remove, onClose, onSave }: {
  score: Score; partId: string; verse?: number; remove?: boolean;
  onClose: () => void; onSave: (score: Score, partId: string, verse: number | null) => void;
}) {
  const parts = scoreParts(score);
  const source = parts.find((p) => p.id === partId)!;
  const [type, setType] = useState<'part' | 'lyrics'>(verse === undefined ? 'part' : 'lyrics');
  const [targetId, setTargetId] = useState(partId);
  const [name, setName] = useState(verse === undefined ? `声部 ${parts.length + 1}` : lyricTrackNames({ events: source.events, part: source })[verse]);
  const [error, setError] = useState('');
  const target = parts.find((p) => p.id === targetId)!;
  const names = lyricTrackNames({ events: target.events, part: target });
  const full = type === 'lyrics' && names.length >= 6 && !(verse !== undefined && targetId === partId);
  const title = remove ? '删除歌词行' : verse === undefined ? '新增声部' : '配置歌词行';
  return <div className="v2-exp-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="v2-exp v2-part-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
        const first = fields[0], last = fields[fields.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="v2-exp-head"><strong>{title}</strong><button className="v2-btn" onClick={onClose}>关闭</button></div>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (remove && verse !== undefined) { onSave(removeLyricTrack(score, partId, verse), partId, null); return; }
        if (!name.trim() || full) return;
        if (type === 'part') {
          const next = addPart(score);
          const added = scoreParts(next);
          const id = added[added.length - 1].id;
          onSave(assembleParts(next, added.map((p) => p.id === id ? { ...p, name: name.trim() } : p)), id, null);
        } else if (verse === undefined) onSave(addLyricTrack(score, targetId, name.trim()), targetId, names.length);
        else {
          const result = configureLyricTrack(score, partId, verse, name.trim(), targetId);
          if (result.error) { setError(result.error); return; }
          onSave(result.score, targetId, result.verse);
        }
      }}>
        <div className="v2-exp-body v2-part-settings">
          {remove ? <p>确定删除「{name}」及这一行的全部歌词吗？删除后可以撤销恢复。</p> : <>
            {verse === undefined ? <label>类型<select autoFocus aria-label="声部类型" value={type} onChange={(e) => {
              const next = e.target.value as 'part' | 'lyrics';
              setType(next); setError('');
              setName(next === 'lyrics' ? `第 ${names.length + 1} 段歌词` : `声部 ${parts.length + 1}`);
            }}><option value="part">演奏声部</option><option value="lyrics">歌词</option></select></label> : null}
            <label>{type === 'lyrics' ? '歌词行名称' : '声部名称'}<input autoFocus={verse !== undefined} required maxLength={32} value={name} onChange={(e) => setName(e.target.value)} /></label>
            {type === 'lyrics' ? <>
              <label>关联声部<select value={targetId} onChange={(e) => { setTargetId(e.target.value); setError(''); }}>{parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <p className="v2-parts-hint">歌词跟随关联声部的音符，不参与发声。{verse !== undefined ? '更换声部后按主音顺序对应。' : '添加后可直接点击谱面的歌词格开始输入。'}</p>
            </> : null}
            {full ? <p className="v2-exp-err" role="alert">此声部已有六条歌词行，请选择其他声部。</p> : null}
            {error ? <p className="v2-exp-err" role="alert">{error}</p> : null}
          </>}
        </div>
        <div className="v2-part-dialog-footer"><button autoFocus={remove} type="button" className="v2-btn" onClick={onClose}>取消</button><button className="v2-btn v2-btn--primary" type="submit" disabled={!remove && (!name.trim() || full)}>{remove ? '确认删除' : verse === undefined ? '添加' : '保存设置'}</button></div>
      </form>
    </div>
  </div>;
}
