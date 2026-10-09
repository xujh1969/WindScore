import { Fragment, useRef, useState } from 'react';
import { assembleParts, scoreParts } from '../parts';
import { lyricTrackNames } from '../lyrics';
import { TrackDialog } from './TrackDialog';
import type { PartInfo, Score } from '../types';

interface Props {
  score: Score;
  activeId: string;
  total: boolean;
  readOnly?: boolean;
  lyricVerse?: number | null;
  onSelectLyrics?: (partId: string, verse: number | null) => void;
  onSelect: (id: string) => void;
  onTotal: (value: boolean) => void;
  onChange: (score: Score, activeId?: string, liveMix?: boolean) => void;
}

export function PartsPanel({ score, activeId, total, readOnly, lyricVerse, onSelectLyrics, onSelect, onTotal, onChange }: Props) {
  const parts = scoreParts(score);
  const part = parts.find((p) => p.id === activeId) ?? parts[0];
  const dragged = useRef<{ id: string; x: number; y: number; moved: boolean; target: string | null } | null>(null);
  const suppressClick = useRef(false);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [config, setConfig] = useState<PartInfo | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [trackDialog, setTrackDialog] = useState<{ partId: string; verse?: number; remove?: boolean } | null>(null);
  const removing = parts.find((p) => p.id === removeId);
  const closeDialog = () => { setConfig(null); setRemoveId(null); dialogTrigger.current?.focus(); };
  return (
    <section className="v2-parts" aria-label="重奏声部">
      <div className="v2-parts-top">
        <span className="v2-parts-label">{parts.length > 1 ? `${parts.length} 声部重奏` : '声部'}</span>
        <div className="v2-parts-tabs" role="tablist" aria-label="编辑声部">
          {parts.map((p, i) => <Fragment key={p.id}><div data-part-id={p.id} className={`v2-part-item ${p.id === part.id && lyricVerse == null ? 'is-on' : ''} ${overId === p.id ? 'is-drop' : ''}`}>
            <button role="tab" aria-selected={p.id === part.id && lyricVerse == null} className={`v2-part-tab ${!readOnly && parts.length > 1 ? 'is-draggable' : ''}`} onClick={() => { if (!suppressClick.current) onSelect(p.id); }}
              title={readOnly ? p.name : '拖拽到其他声部上可互换位置'}
              onPointerDown={(e) => {
                if (readOnly || parts.length < 2 || e.button !== 0) return;
                dragged.current = { id: p.id, x: e.clientX, y: e.clientY, moved: false, target: null };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const drag = dragged.current;
                if (!drag) return;
                if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) drag.moved = true;
                if (!drag.moved) return;
                const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-part-id]');
                drag.target = hit && e.currentTarget.closest('.v2-parts-tabs')?.contains(hit) && hit.dataset.partId !== drag.id ? hit.dataset.partId ?? null : null;
                setOverId(drag.target);
              }}
              onPointerUp={() => {
                const drag = dragged.current;
                const from = parts.findIndex((item) => item.id === drag?.id);
                const to = parts.findIndex((item) => item.id === drag?.target);
                if (drag?.moved) {
                  suppressClick.current = true;
                  window.setTimeout(() => { suppressClick.current = false; }, 0);
                  if (from >= 0 && to >= 0 && from !== to) {
                    const next = [...parts];
                    [next[from], next[to]] = [next[to], next[from]];
                    onChange(assembleParts(score, next));
                  }
                }
                dragged.current = null;
                setOverId(null);
              }}
              onPointerCancel={() => { dragged.current = null; setOverId(null); }}>
              <span className="v2-part-number">{i + 1}</span>{p.name}{p.muted ? <span className="v2-part-tag">静音</span> : p.solo ? <span className="v2-part-tag">独奏</span> : null}
            </button>
            {p.id === part.id && lyricVerse == null ? <div className="v2-part-actions">
              <button className="v2-part-icon" aria-label={`配置声部：${p.name}`} title="配置声部" onClick={(e) => { dialogTrigger.current = e.currentTarget; setConfig({ id: p.id, name: p.name, gain: p.gain, muted: p.muted, solo: p.solo }); }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              {!readOnly ? <button className="v2-part-icon v2-part-delete" disabled={parts.length === 1} aria-label={`删除声部：${p.name}`} title={parts.length === 1 ? '至少保留一个声部' : '删除声部'} onClick={(e) => { dialogTrigger.current = e.currentTarget; setRemoveId(p.id); }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg>
              </button> : null}
            </div> : null}
          </div>{!readOnly ? lyricTrackNames({ events: p.events, part: p }).map((name, verse) => <div key={`${p.id}:${verse}`} className={`v2-part-item v2-lyric-tab ${p.id === part.id && lyricVerse === verse ? 'is-on' : ''}`}>
            <button role="tab" aria-selected={p.id === part.id && lyricVerse === verse} className="v2-part-tab" title={`关联 ${p.name} · 点击在谱面输入歌词`} onClick={() => onSelectLyrics?.(p.id, verse)}><span className="v2-part-tag">词</span>{name}</button>
            {p.id === part.id && lyricVerse === verse ? <div className="v2-part-actions">
              <button className="v2-part-icon" aria-label={`配置歌词行：${name}`} title="配置歌词行" onClick={(e) => { dialogTrigger.current = e.currentTarget; setTrackDialog({ partId: p.id, verse }); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/></svg></button>
              <button className="v2-part-icon v2-part-delete" aria-label={`删除歌词行：${name}`} title="删除歌词行" onClick={(e) => { dialogTrigger.current = e.currentTarget; setTrackDialog({ partId: p.id, verse, remove: true }); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button>
            </div> : null}
          </div>) : null}</Fragment>)}
        </div>
        {!readOnly ? <button className="v2-btn" onClick={(e) => { dialogTrigger.current = e.currentTarget; setTrackDialog({ partId: activeId }); }}>＋ 新增声部</button> : null}
        {parts.length > 1 ? <div className="v2-view-switch">
          <button className={`v2-seg ${total ? 'is-on' : ''}`} onClick={() => onTotal(true)}>总谱</button>
          <button className={`v2-seg ${!total ? 'is-on' : ''}`} onClick={() => onTotal(false)}>当前分谱</button>
        </div> : null}
      </div>
      {trackDialog ? <TrackDialog score={score} {...trackDialog} onClose={() => { setTrackDialog(null); dialogTrigger.current?.focus(); }} onSave={(next, id, verse) => {
        onChange(next, id === activeId ? undefined : id); setTrackDialog(null); onSelectLyrics?.(id, verse);
        if (verse === null) dialogTrigger.current?.focus();
      }} /> : null}
      {config || removing ? <div className="v2-exp-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
        <div className="v2-exp v2-part-dialog" role="dialog" aria-modal="true" aria-label={config ? '配置声部' : '删除声部确认'} onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') closeDialog();
          if (e.key === 'Tab') {
            const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
          }
        }}>
          <div className="v2-exp-head"><strong>{config ? '配置声部' : '删除声部'}</strong><button className="v2-btn" onClick={closeDialog}>关闭</button></div>
          {config ? <form onSubmit={(e) => {
            e.preventDefault();
            const name = config.name.trim();
            if (!name) return;
            const original = parts.find((p) => p.id === config.id);
            onChange(assembleParts(score, parts.map((p) => p.id === config.id ? { ...p, ...config, name } : p)), undefined, name === original?.name);
            closeDialog();
          }}>
            <div className="v2-exp-body v2-part-settings">
              <label>声部名称<input autoFocus required disabled={readOnly} maxLength={32} value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} /></label>
              <label>音量<span className="v2-part-volume"><input autoFocus={readOnly} type="range" min="0" max="1" step="0.05" value={config.gain} onChange={(e) => setConfig({ ...config, gain: Number(e.target.value) })} /><span>{Math.round(config.gain * 100)}%</span></span></label>
              <label className="v2-part-check"><input type="checkbox" checked={!!config.solo} onChange={(e) => setConfig({ ...config, solo: e.target.checked })} />独奏此声部</label>
              <label className="v2-part-check"><input type="checkbox" checked={!!config.muted} onChange={(e) => setConfig({ ...config, muted: e.target.checked })} />静音此声部</label>
            </div>
            <div className="v2-part-dialog-footer"><button type="button" className="v2-btn" onClick={closeDialog}>取消</button><button className="v2-btn" type="submit" disabled={!config.name.trim()}>保存设置</button></div>
          </form> : removing ? <>
            <div className="v2-exp-body"><p>确定删除声部「{removing.name}」及其全部音符吗？</p><p className="v2-parts-hint">删除后可以使用撤销恢复。</p></div>
            <div className="v2-part-dialog-footer"><button autoFocus className="v2-btn" onClick={closeDialog}>取消</button><button className="v2-btn" onClick={() => {
              const index = parts.findIndex((p) => p.id === removing.id);
              const next = parts.filter((p) => p.id !== removing.id);
              onChange(assembleParts(score, next), next[Math.min(index, next.length - 1)].id);
              closeDialog();
            }}>确认删除</button></div>
          </> : null}
        </div>
      </div> : null}
    </section>
  );
}
