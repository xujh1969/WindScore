/**
 * 动态谱首页（play.html 的首屏）。
 *
 * 一屏里给五件事：最新动态、我的收藏、最近搜索、搜索结果、全部曲目（右侧 A/B/C 索引）。
 * 数据全部来自本机曲库（localStorage），没有账号也没有服务端——收藏与历史
 * 都是「这台机器上的我」，所以离线可用、刷新不丢。
 *
 * 点任意一首 = 直接进播放界面（只放不编）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { describeMeta, setFavorite, useLibraryItems, type LibraryItem } from './libraryStore';
import { loadAlign } from './alignStore';
import {
  displayNameOf,
  favoriteItems,
  groupByInitial,
  initialsOf,
  recentItems,
  searchItems,
} from './discoverModel';
import { normalizeQuery, pushRecent, readRecent, removeRecent, writeRecent } from './recentSearch';

interface Props {
  onOpen: (item: LibraryItem) => void;
  /** 回落地首页的链接（index.html）；不传则不显示这个入口 */
  homeHref?: string;
  onHelp?: () => void;
  msg?: string;
}

interface RowProps {
  item: LibraryItem;
  onOpen: (it: LibraryItem) => void;
  onToggleFav: (id: string, on: boolean) => void;
}

/** 收藏按钮：卡片与列表行共用 */
function FavButton({ item, onToggleFav }: { item: LibraryItem } & Pick<RowProps, 'onToggleFav'>) {
  return (
    <button
      className={item.favorite ? 'v2-dc-fav is-on' : 'v2-dc-fav'}
      onClick={() => onToggleFav(item.id, !item.favorite)}
      title={item.favorite ? '取消收藏' : '收藏'}
    >
      {item.favorite ? '★' : '☆'}
    </button>
  );
}

/** 一首歌的小卡片（最新动态 / 收藏共用） */
function SongCard({ item, onOpen, onToggleFav }: RowProps) {
  const hasAudio = (loadAlign(item.name)?.audio?.length ?? 0) > 0;
  return (
    <div className="v2-dc-card">
      <button className="v2-dc-card-main" onClick={() => onOpen(item)} title={describeMeta(item.meta)}>
        <span className="v2-dc-card-name">{displayNameOf(item)}</span>
        <span className="v2-dc-card-meta">
          {hasAudio ? <span className="v2-dc-tag">有伴奏</span> : null}
          {describeMeta(item.meta) || '—'}
        </span>
      </button>
      <FavButton item={item} onToggleFav={onToggleFav} />
    </div>
  );
}

/** 列表里的一行（搜索结果与全部曲目共用） */
function SongRow({ item, onOpen, onToggleFav }: RowProps) {
  const hasAudio = (loadAlign(item.name)?.audio?.length ?? 0) > 0;
  return (
    <div className="v2-dc-row">
      <button className="v2-dc-row-main" onClick={() => onOpen(item)}>
        <span className="v2-dc-row-name">
          {displayNameOf(item)}
          {item.meta.broken ? <span className="v2-dc-tag is-bad">无法解析</span> : null}
          {hasAudio ? <span className="v2-dc-tag">有伴奏</span> : null}
        </span>
        <span className="v2-dc-row-meta">{describeMeta(item.meta)}</span>
      </button>
      <FavButton item={item} onToggleFav={onToggleFav} />
    </div>
  );
}
export function DiscoverScreen({ onOpen, homeHref, onHelp, msg }: Props) {
  /** 订阅式曲库：文件夹后端水合完成、或别处收藏/改名后，这里自动重读 */
  const items = useLibraryItems();
  const [recents, setRecents] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const groupRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => setRecents(readRecent()), []);

  const recent = useMemo(() => recentItems(items, 6), [items]);
  const favorites = useMemo(() => favoriteItems(items), [items]);
  const results = useMemo(() => (searched ? searchItems(items, searched) : []), [items, searched]);
  const groups = useMemo(() => groupByInitial(items), [items]);
  const initials = useMemo(() => initialsOf(groups), [groups]);

  const toggleFav = (id: string, on: boolean): void => {
    setFavorite(id, on); // 写入后 store 会广播，订阅让它自动刷新
  };

  const runSearch = (raw: string): void => {
    const q = normalizeQuery(raw);
    setSearched(q);
    setQuery(q);
    if (!q) return;
    const next = pushRecent(recents, q);
    setRecents(next);
    writeRecent(next);
  };

  const dropRecent = (q: string): void => {
    const next = removeRecent(recents, q);
    setRecents(next);
    writeRecent(next);
    if (searched === q) setSearched('');
  };

  /** 右侧索引：滚到那一组的标题 */
  const jumpTo = (initial: string): void => {
    groupRefs.current.get(initial)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div className="v2-dc">
      <header className="v2-dc-head">
        {/*
          回落地首页的入口。play.html 的顶栏整行不显示（独立入口），
          所以这个箭头得长在页面里，否则进来了就没路回首页。
        */}
        {homeHref ? (
          <a className="v2-home-btn" href={homeHref} title="回到首页">
            ← 返回首页
          </a>
        ) : null}
        <div className="v2-dc-head-left">
          <h1 className="v2-dc-title">动态谱</h1>
          <p className="v2-dc-sub">本机曲库 {items.length} 首 · 点一首直接进播放</p>
        </div>
        <div className="v2-dc-search">
          <input
            className="v2-dc-input"
            value={query}
            placeholder="搜歌名 / 标题，回车搜索"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(query);
              if (e.key === 'Escape') {
                setQuery('');
                setSearched('');
              }
            }}
          />
          <button className="v2-btn v2-btn--primary" onClick={() => runSearch(query)}>
            搜索
          </button>
        </div>
        {onHelp ? <button className="v2-btn" aria-haspopup="dialog" onClick={onHelp}>帮助</button> : null}
      </header>

      {msg ? <p className="v2-dc-msg">{msg}</p> : null}

      <div className="v2-dc-body">
        {/*
          曲库管理只属于曲库页（主程序里）：这里不放假曲库入口，
          空库也只说明状态、不做「去曲库」的跳转引导——
          play.html 是纯查询/播放页，导入打包不是它的职责
        */}
        {items.length === 0 ? (
          <div className="v2-dc-empty">
            <p>本机曲库还是空的。</p>
            <p className="v2-dc-empty-sub">
              在主程序的「曲库」页导入打包后，曲子会出现在这里。
            </p>
          </div>
        ) : null}

        {/*
          三栏布局（左中右，不上下堆）：
          左 = 最新动态 + 我的收藏；中 = 搜索结果 + 全部曲目（主内容，最宽）；
          右 = 最近搜索。首字母索引仍贴在全部曲目的右缘。
        */}
        <div className="v2-dc-grid">
          <div className="v2-dc-col">
            {recent.length > 0 ? (
              <section className="v2-dc-block">
                <h2 className="v2-dc-h2">最新动态</h2>
                <div className="v2-dc-cards">
                  {recent.map((it) => (
                    <SongCard key={it.id} item={it} onOpen={onOpen} onToggleFav={toggleFav} />
                  ))}
                </div>
              </section>
            ) : null}
            <section className="v2-dc-block">
              <h2 className="v2-dc-h2">我的收藏</h2>
              {favorites.length === 0 ? (
                <p className="v2-dc-hint">还没收藏。在「全部曲目」里点 ☆ 收藏，常用的就置顶了。</p>
              ) : (
                <div className="v2-dc-cards">
                  {favorites.map((it) => (
                    <SongCard key={it.id} item={it} onOpen={onOpen} onToggleFav={toggleFav} />
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="v2-dc-col v2-dc-col--main">

        {searched ? (
          <section className="v2-dc-block">
            <h2 className="v2-dc-h2">
              搜索结果「{searched}」
              <span className="v2-dc-count">{results.length} 首</span>
            </h2>
            {results.length === 0 ? (
              <p className="v2-dc-hint">没找到。换个词试试——搜索只看曲名和谱面标题。</p>
            ) : (
              <div className="v2-dc-list">
                {results.map((it) => (
                  <SongRow key={it.id} item={it} onOpen={onOpen} onToggleFav={toggleFav} />
                ))}
              </div>
            )}
          </section>
        ) : null}

        <section className="v2-dc-block v2-dc-all">
          <h2 className="v2-dc-h2">
            全部曲目
            <span className="v2-dc-count">{items.length} 首</span>
          </h2>
          <div className="v2-dc-allwrap">
            <div className="v2-dc-groups">
              {groups.map((g) => (
                <div
                  key={g.initial}
                  className="v2-dc-group"
                  ref={(el) => {
                    if (el) groupRefs.current.set(g.initial, el);
                    else groupRefs.current.delete(g.initial);
                  }}
                >
                  <div className="v2-dc-group-h">{g.initial}</div>
                  {g.items.map((it) => (
                    <SongRow key={it.id} item={it} onOpen={onOpen} onToggleFav={toggleFav} />
                  ))}
                </div>
              ))}
            </div>
            <nav className="v2-dc-index" aria-label="首字母索引">
              {initials.map((c) => (
                <button
                  key={c}
                  className="v2-dc-index-b"
                  onClick={() => jumpTo(c)}
                  title={`跳到 ${c}`}
                >
                  {c}
                </button>
              ))}
            </nav>
          </div>
        </section>
          </div>

          {/* 右栏：最近搜索（窄栏放 chips 正合适） */}
          <div className="v2-dc-col v2-dc-col--side">
            {recents.length > 0 ? (
              <section className="v2-dc-block">
                <h2 className="v2-dc-h2">
                  最近搜索
                  <button
                    className="v2-dc-link"
                    onClick={() => {
                      setRecents([]);
                      writeRecent([]);
                    }}
                  >
                    清空
                  </button>
                </h2>
                <div className="v2-dc-chips">
                  {recents.map((q) => (
                    <span key={q} className="v2-dc-chip">
                      <button className="v2-dc-chip-main" onClick={() => runSearch(q)}>
                        {q}
                      </button>
                      <button className="v2-dc-chip-x" onClick={() => dropRecent(q)} title="删掉这条">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
