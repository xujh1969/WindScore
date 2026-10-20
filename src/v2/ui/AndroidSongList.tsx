import { memo, useLayoutEffect, useRef, useState } from 'react';
import { AndroidIcon } from './AndroidComponents';
import type { LibraryItem } from './libraryStore';

interface Props {
  items: LibraryItem[];
  hasAudio: (item: LibraryItem) => boolean;
  onOpen: (item: LibraryItem) => void;
  onMenu: (item: LibraryItem) => void;
}

const SongRow = memo(function SongRow({ item, index, count, hasAudio, onOpen, onMenu }: Omit<Props, 'items'> & { item: LibraryItem; index: number; count: number }) {
  return <article className={`an-song ${index % 3 === 1 ? 'an-song-alt' : ''}`} role="listitem" aria-posinset={index + 1} aria-setsize={count}>
    <button className="an-song-open" onClick={() => onOpen(item)}><span className="an-song-art"><AndroidIcon name="music"/></span><span className="an-song-copy"><strong>{item.name}</strong><span>{[item.meta.key, item.meta.beat, item.meta.bpm ? `${item.meta.bpm} BPM` : ''].filter(Boolean).join(' · ') || '动态乐谱'}</span>{hasAudio(item) && <span className="an-accompaniment">有伴奏</span>}</span></button>
    <span className={`an-favorite-indicator ${item.favorite ? 'is-on' : ''}`} role="img" aria-label={item.favorite ? '已收藏' : '未收藏'}><AndroidIcon name="star" filled={item.favorite}/></span>
    <button className="an-icon-button" aria-label={`${item.name}的更多操作`} onClick={() => onMenu(item)}><AndroidIcon name="more"/></button>
  </article>;
});

/** 数据完整保留，DOM 仅保留视口及上下各四行；沿用主页面的滚动容器。 */
export function AndroidSongList({ items, ...actions }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ start: 0, end: 16, height: 112 });
  useLayoutEffect(() => {
    const node = root.current!;
    const scroll = node.parentElement!;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = parseFloat(getComputedStyle(node).getPropertyValue('--an-song-height'));
      const top = node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      const first = Math.max(0, Math.floor((scroll.scrollTop - top) / height));
      const start = Math.min(Math.max(0, items.length - 1), Math.max(0, first - 4));
      const end = Math.min(items.length, Math.max(start + 1, Math.ceil((scroll.scrollTop - top + scroll.clientHeight) / height) + 4));
      setWindow(old => old.start === start && old.end === end && old.height === height ? old : { start, end, height });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll); observer.observe(node);
    scroll.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); scroll.removeEventListener('scroll', schedule); };
  }, [items]);
  const start = Math.min(window.start, Math.max(0, items.length - 1));
  const end = Math.min(items.length, Math.max(start + 1, window.end));
  return <div ref={root} className="an-song-list" role="list" aria-label={`乐谱列表，共 ${items.length} 首`}>
    <div aria-hidden="true" style={{ height: `calc(${start} * var(--an-song-height))` }}/>
    {items.slice(start, end).map((item, i) => <SongRow key={item.id} item={item} index={start + i} count={items.length} {...actions}/>)}
    <div aria-hidden="true" style={{ height: `calc(${items.length - end} * var(--an-song-height))` }}/>
  </div>;
}
