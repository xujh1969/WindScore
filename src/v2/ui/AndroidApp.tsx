import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorApp } from './EditorApp';
import { AndroidSongList } from './AndroidSongList';
import { AndroidLanUpload, useLanUpload } from './AndroidLanUpload';
import { AndroidBrand, AndroidDialog, AndroidIcon, type AndroidIconName } from './AndroidComponents';
import { importLibrary, metaOfText, normalizeName, onLibraryChange, readLibrary, removeLibraryItem, searchLibrary, setFavorite, uniqueName, type LibraryItem } from './libraryStore';
import { renameLibraryWithAssets } from './renameLibrary';
import { readPack } from './packBundle';
import { audioKey, loadAlign, putAudio, saveAlign } from './alignStore';
import { initStore } from './storeInit';
import { ensureMp3 } from '../mp3';
import molihua from '../../scores/molihua-repeat.jps?raw';
import songbie from '../../scores/songbie.jps?raw';
import qinghuaci from '../../scores/qinghuaci.jps?raw';
import huanlesong from '../../scores/huanlesong.jps?raw';
import xiaoxingxing from '../../scores/xiaoxingxing.jps?raw';
import ensembleDemo from '../../scores/ensemble-demo.jps?raw';
import './android.css';

type Tab = 'library' | 'community' | 'my';
const tabs: { id: Tab; label: string; icon: AndroidIconName }[] = [{ id: 'library', label: '曲库', icon: 'music' }, { id: 'community', label: '社区', icon: 'community' }, { id: 'my', label: '我的', icon: 'user' }];
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true });
function samples(): LibraryItem[] {
  return [['茉莉花', molihua], ['送别', songbie], ['青花瓷', qinghuaci], ['欢乐颂', huanlesong], ['小星星', xiaoxingxing], ['重奏练习', ensembleDemo]].map(([name, text], i) => ({ id: `preview-${i}`, name, text, updatedAt: 0, meta: metaOfText(text, name), favorite: i === 0 || i === 2 }));
}
const preview = new URLSearchParams(location.search).get('preview') === '1';
function initialTheme(): boolean {
  try { const t = localStorage.getItem('ws-android-theme'); if (t) return t === 'dark'; } catch { /* 系统偏好兜底 */ }
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function username(): string {
  if (preview) return '106820';
  try { const saved = localStorage.getItem('ws-android-user'); if (saved) return saved; } catch { /* 仍可展示 */ }
  const id = String(Math.floor(100000 + Math.random() * 900000));
  try { localStorage.setItem('ws-android-user', id); } catch { /* 本次会话可用 */ }
  return id;
}
export function AndroidApp() {
  const [dark, setDark] = useState(initialTheme);
  const [ready, setReady] = useState(preview);
  const [error, setError] = useState('');
  const [items, setItems] = useState<LibraryItem[]>(() => preview ? samples() : readLibrary());
  const [tab, setTab] = useState<Tab>('library');
  const [uploadPage, setUploadPage] = useState(false);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [menu, setMenu] = useState<LibraryItem | null>(null);
  const [deleting, setDeleting] = useState<LibraryItem | null>(null);
  const [renaming, setRenaming] = useState<LibraryItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lan = useLanUpload(ready && !preview, setNotice);
  const [user] = useState(username);
  const [appBuild] = useState(() => {
    try { return (window as unknown as { WindScoreAndroid?: { getAppBuildInfo?: () => string } }).WindScoreAndroid?.getAppBuildInfo?.() ?? ''; }
    catch { return ''; }
  });
  const file = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLElement>(null);
  const libraryScroll = useRef(0);
  const previewItems = useRef(items);
  const previewPacks = useRef(new Map<string, Awaited<ReturnType<typeof readPack>>>());
  useEffect(() => {
    if (!renaming) return;
    const frame = requestAnimationFrame(() => { renameInput.current?.focus(); renameInput.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, [renaming]);
  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = tab === 'library' ? libraryScroll.current : 0;
  }, [selected, tab, ready, uploadPage]);
  useEffect(() => {
    if (preview) return;
    const off = onLibraryChange(() => setItems(readLibrary()));
    void initStore().then(() => { setItems(readLibrary()); setReady(true); }).catch(e => setError(String(e)));
    return off;
  }, []);
  useEffect(() => {
    try { localStorage.setItem('ws-android-theme', dark ? 'dark' : 'light'); } catch { /* 不影响切换 */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151d19' : '#f6f7f2');
  }, [dark]);
  useEffect(() => {
    history.replaceState({ windscoreAndroid: true, tab: 'library', song: null }, '');
    const pop = (event: PopStateEvent) => { setTab(event.state?.tab ?? 'library'); setUploadPage(event.state?.tab === 'my' && event.state?.upload === true); setSelected(event.state?.song ?? null); setMenu(null); setDeleting(null); setRenaming(null); };
    addEventListener('popstate', pop); return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(id); }, [notice]);
  useEffect(() => {
    if (tab !== 'my' && lan.state.running) { lan.stop(); setNotice('曲库上传服务已停用'); }
  }, [tab, lan.state.running, lan.stop]);
  const navigate = (next: Tab, song: LibraryItem | null = null, upload = false) => { setTab(next); setSelected(song); setUploadPage(upload); history.pushState({ windscoreAndroid: true, tab: next, song, upload }, ''); };
  const sorted = useMemo(() => [...items].sort((a, b) => collator.compare(a.name, b.name)), [items]);
  const visible = useMemo(() => searchLibrary(sorted, query).filter(it => !favorites || it.favorite), [sorted, query, favorites]);
  const resetScroll = () => { libraryScroll.current = 0; if (main.current) main.current.scrollTop = 0; };
  const updatePreview = (next: LibraryItem[]) => { previewItems.current = next; setItems(next); };
  const toggleFavorite = (item: LibraryItem) => {
    if (preview) updatePreview(previewItems.current.map(it => it.id === item.id ? { ...it, favorite: !it.favorite } : it));
    else if (!setFavorite(item.id, !item.favorite)) setNotice('收藏未能保存，请检查设备存储后重试。');
    setMenu(null);
  };
  const deleteItem = () => {
    if (!deleting) return;
    if (preview) { updatePreview(previewItems.current.filter(it => it.id !== deleting.id)); previewPacks.current.delete(deleting.id); }
    else if (!removeLibraryItem(deleting.id)) setNotice('删除失败，请重试。');
    setDeleting(null);
  };
  const commitRename = async () => {
    if (!renaming || renameBusy) return;
    const name = normalizeName(renameValue);
    if (!name) { setRenameError('请输入乐谱名称'); return; }
    const current = preview ? previewItems.current : readLibrary();
    if (current.some(item => item.id !== renaming.id && item.name === name)) { setRenameError('曲库中已有这个名称，请换一个'); return; }
    if (lan.state.running) { setRenameError('请先停用上传服务，再重命名'); return; }
    setRenameBusy(true); setRenameError('');
    try {
      if (preview) updatePreview(previewItems.current.map(item => item.id === renaming.id ? { ...item, name, updatedAt: Date.now() } : item));
      else if (!await renameLibraryWithAssets(renaming.id, name)) { setRenameError('重命名未能保存，请检查名称和设备存储后重试'); return; }
      setRenaming(null); setNotice(`已重命名为“${name}”`);
    } catch { setRenameError('重命名失败，请稍后重试'); }
    finally { setRenameBusy(false); }
  };
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    if (lan.state.running) { setNotice('请先停用上传服务，再从设备导入乐谱'); return; }
    setBusy(true); let ok = 0; const bad: string[] = [];
    for (const picked of Array.from(files)) {
      try {
        if (!picked.name.toLowerCase().endsWith('.wspack')) throw new Error('请选择 .wspack 乐谱包');
        const pack = await readPack(new Uint8Array(await picked.arrayBuffer()));
        if (metaOfText(pack.text).broken) throw new Error('谱面内容无法解析');
        if (preview) {
          const name = uniqueName(pack.name, previewItems.current.map(it => it.name));
          const item = { id: `preview-import-${Date.now()}-${ok}`, name, text: pack.text, updatedAt: Date.now(), meta: metaOfText(pack.text, name) };
          previewPacks.current.set(item.id, pack); updatePreview([...previewItems.current, item]);
        } else {
          const item = importLibrary(pack.name, pack.text); if (!item) throw new Error('设备存储无法写入');
          if (pack.align) {
            const audio = [];
            for (const stem of pack.stems) { const mp3 = await ensureMp3(stem.file); const key = audioKey(mp3); await putAudio(key, mp3); audio.push({ key, name: mp3.name }); }
            saveAlign(item.name, { ...pack.align, audio });
          }
        }
        ok++;
      } catch (e) { bad.push(`${picked.name}：${e instanceof Error ? e.message : e}`); }
    }
    setBusy(false); setNotice(`已导入 ${ok} 首${preview ? '（仅本次预览）' : ''}${bad.length ? `；${bad.join('；')}` : '，现在可以开始演奏了。'}`);
    if (ok) { resetScroll(); setQuery(''); setFavorites(false); navigate('library'); }
  };
  return <div className="an-app" data-theme={dark ? 'dark' : 'light'}>
    {!ready ? <div className="an-splash"><AndroidBrand/><h1>WindScore</h1><p>随时看谱，练习演出更从容</p><p role="status">{error ? `曲库加载失败：${error}` : '正在准备你的曲库…'}</p></div> : selected ?
      <EditorApp key={selected.id} entry="android-player" androidItem={selected} androidDark={dark} androidPreview={preview} androidPack={previewPacks.current.get(selected.id)} onAndroidBack={() => history.back()} /> : <>
      <header className={`an-top ${uploadPage ? 'an-transfer-top' : ''}`}>{uploadPage ? <><button className="an-icon-button" aria-label="返回我的" onClick={() => history.back()}><AndroidIcon name="back"/></button><h1>从网络传入乐曲</h1></> : <a className="an-wordmark" href="#" onClick={e => { e.preventDefault(); if (tab !== 'library') navigate('library'); }}><AndroidBrand/><h1>WindScore-{tabs.find(t => t.id === tab)!.label}</h1></a>}<button className="an-icon-button" onClick={() => setDark(!dark)} aria-label={dark ? '切换浅色模式' : '切换深色模式'}><AndroidIcon name={dark ? 'sun' : 'moon'}/></button></header>
      <main className="an-main" ref={main} onScroll={e => { if (tab === 'library') libraryScroll.current = e.currentTarget.scrollTop; }}>
        {uploadPage ? <AndroidLanUpload service={lan} disabled={busy} onNotice={setNotice}/> : tab === 'library' ? <>
          <div className="an-search-row"><label className="an-search"><AndroidIcon name="search"/><input type="search" placeholder="搜索曲名、拼音或首字母" value={query} onChange={e => { resetScroll(); setQuery(e.target.value); }} aria-label="搜索乐谱"/></label><button className={`an-favorite-filter ${favorites ? 'is-on' : ''}`} aria-label="我的收藏" aria-pressed={favorites} onClick={() => { resetScroll(); setFavorites(!favorites); }}><AndroidIcon name="star" filled={favorites}/><span>我的收藏</span></button></div>
          <div className="an-list-caption"><span>{favorites ? '收藏的乐谱' : '全部乐谱'}<small className="an-song-count">{visible.length} 首</small></span><span>{query ? '搜索结果' : '按拼音排序'}</span></div>
          {visible.length ? <AndroidSongList items={visible} hasAudio={item => preview ? (previewPacks.current.get(item.id)?.stems.length ?? 0) > 0 : (loadAlign(item.name)?.audio?.length ?? 0) > 0} onOpen={item => { if (item.meta.broken) setNotice('这份谱面无法打开，请删除后重新导入。'); else navigate('library', item); }} onMenu={setMenu}/> : <section className="an-empty"><AndroidIcon name={query ? 'search' : favorites ? 'star' : 'music'}/><h2>{query ? `没有找到“${query}”` : favorites ? '还没有收藏乐谱' : '从第一首乐谱开始'}</h2><p>{query ? '试试其他曲名、拼音或首字母' : favorites ? '打开曲目菜单，将喜欢的乐谱收入收藏。' : '导入 .wspack 乐谱包，开启你的演奏。'}</p>{!query && !favorites && <button className="an-primary" onClick={() => file.current?.click()}><AndroidIcon name="upload"/>导入乐谱</button>}</section>}
          {preview && <p className="an-preview-note">浏览器预览 · 示例曲库，操作仅在本次预览生效</p>}
        </> : tab === 'community' ? <section className="an-coming"><span className="an-empty-art"><AndroidIcon name="community"/></span><h1>社区即将开放</h1><p>期待与更多热爱音乐的人相遇。</p><button className="an-text-button" onClick={() => navigate('library')}>回曲库练一曲<AndroidIcon name="chevron"/></button></section> : <section className="an-profile"><div className="an-user"><span className="an-avatar"><AndroidIcon name="user"/></span><div><h2>{user}</h2><p>本地个人资料</p></div></div><button className="an-management" onClick={() => file.current?.click()} disabled={busy || lan.state.running}><span className="an-management-icon"><AndroidIcon name="upload"/></span><span><strong>从本地导入乐曲</strong><small>选择设备中的 .wspack 文件</small></span><AndroidIcon name="chevron"/></button><button className="an-management" onClick={() => navigate('my', null, true)}><span className="an-management-icon"><AndroidIcon name="wifi"/></span><span><strong>从网络传入乐曲</strong><small>{lan.state.running ? '服务运行中 · 点击查看' : '电脑通过同一 Wi-Fi 上传'}</small></span><AndroidIcon name="chevron"/></button><p className="an-local-note">乐谱和个人资料保存在当前设备。</p></section>}
      </main>
      {tab === 'my' && !uploadPage && appBuild && <p className="an-build-info">安卓版 {appBuild}</p>}
      {!uploadPage && <nav className="an-nav" aria-label="主导航">{tabs.map(t => <button key={t.id} className={tab === t.id ? 'is-on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => { if (t.id !== tab) navigate(t.id); }}><span><AndroidIcon name={t.icon}/></span>{t.label}</button>)}</nav>}
    </>}
    <input ref={file} type="file" accept=".wspack" multiple hidden onChange={e => { void importFiles(e.target.files); e.target.value = ''; }}/>
    {menu && <AndroidDialog title={menu.name} onClose={() => setMenu(null)} className="an-action-sheet"><button className="an-menu-action" onClick={() => toggleFavorite(menu)}><AndroidIcon name="star"/>{menu.favorite ? '取消收藏' : '收藏乐谱'}</button><button className="an-menu-action" onClick={() => { setRenameValue(menu.name); setRenameError(''); setRenaming(menu); setMenu(null); }} disabled={busy || lan.state.running}><AndroidIcon name="rename"/>重命名</button>{lan.state.running && <p className="an-setting-hint">停用上传服务后可重命名。</p>}<button className="an-menu-action an-danger" onClick={() => { setDeleting(menu); setMenu(null); }}><AndroidIcon name="trash"/>从曲库删除</button></AndroidDialog>}
    {renaming && <AndroidDialog title="重命名乐谱" onClose={() => { if (!renameBusy) setRenaming(null); }}><form onSubmit={e => { e.preventDefault(); void commitRename(); }}>
      <label className="an-rename-field" htmlFor="an-rename-input">乐谱名称<input ref={renameInput} id="an-rename-input" value={renameValue} onChange={e => { setRenameValue(e.target.value); setRenameError(''); }} disabled={renameBusy} autoComplete="off" enterKeyHint="done" aria-invalid={!!renameError} aria-describedby={renameError ? 'an-rename-error' : undefined}/></label>
      {renameError && <p id="an-rename-error" className="an-rename-error" role="alert">{renameError}</p>}
      <div className="an-dialog-actions"><button type="button" className="an-secondary" onClick={() => setRenaming(null)} disabled={renameBusy}>取消</button><button type="submit" className="an-primary" disabled={renameBusy}>{renameBusy ? '正在保存…' : '保存名称'}</button></div>
    </form></AndroidDialog>}
    {deleting && <AndroidDialog title="删除乐谱？" onClose={() => setDeleting(null)}><p className="an-dialog-copy">将从当前曲库删除“{deleting.name}”。原始 .wspack 文件不受影响。</p><div className="an-dialog-actions"><button className="an-secondary" onClick={() => setDeleting(null)}>取消</button><button className="an-primary an-delete" onClick={deleteItem}>删除</button></div></AndroidDialog>}
    {notice && <div className="an-notice" role="status">{notice}<button className="an-icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><AndroidIcon name="close"/></button></div>}
    {busy && <div className="an-busy" role="status"><span className="an-spinner"/>正在导入乐谱与伴奏，请稍候…</div>}
  </div>;
}
