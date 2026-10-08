/**
 * 曲库界面（独立的顶层界面，不是弹窗）。
 *
 * 为什么要单独一屏：曲库管的是**一批谱**，记谱 / 对轨管的是**一首谱**——
 * 任务粒度完全不同。挤在弹窗里只能做「挑一首打开」，而曲库要做的
 * 是收、发、备份：导入别人给的压缩包建库、把整首（谱面 + 伴奏 + 标定）
 * 打包发出去。这些动作铺得开才好用。
 *
 * 入口分工：
 *   记谱界面 → 新建 / 打开 / 保存（只动谱面 .jps）
 *   对轨界面 → 打包（谱面 + 伴奏 + 标定 → 一个 .wspack）
 *   曲库界面 → 导入压缩包建库 / 打开 / 打包导出 / 重命名 / 删除
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { saveBytesAsFile } from '../io';
import { audioKey, getAudio, loadAlign, putAudio, saveAlign } from './alignStore';
import { ensureMp3 } from '../mp3';
import { buildPack, packFileName, readPack } from './packBundle';
import {
  describeMeta,
  importLibrary,
  removeLibraryItem,
  renameLibraryItem,
  searchLibrary,
  useLibraryItems,
  type LibraryItem,
} from './libraryStore';
import {
  currentBackend,
  folderName,
  isPending,
  libraryRootPath,
  onStoreBackendChange,
} from './storeBackend';
import { pickAndConnectFolder, reconnectFolder } from './storeInit';

interface Props {
  /** 点一首 = 进**播放界面**（只放不编） */
  onOpen: (item: LibraryItem) => void;
  /** 进对轨编辑这首（配伴奏 / 调标定） */
  onEdit: (item: LibraryItem) => void;
  onNotify: (msg: string) => void;
  /** 全局消息（导入 / 打包的结果就显示在这）：编辑器的底栏这一屏看不到，得自己带一条 */
  msg?: string;
  /**
   * 只读（play.html 的「曲库查询」）：不导入 / 不打包 / 不重命名 / 不删除，
   * 只能搜、只能点开播放。查询页不该有编辑权——误触一次就是数据没了。
   */
  readOnly?: boolean;
  /** play.html 的只读模式：点左上角回到动态谱首页 */
  onBackHome?: () => void;
}

export function LibraryScreen({ onOpen, onEdit, onNotify, msg, readOnly, onBackHome }: Props) {
  /** 订阅式曲库：水合完成 / 任何写入（包括别的页面改的）都会让这里重读 */
  const items = useLibraryItems();
  // 后端状态（连接 / 待授权）变化时重渲染，让存储位置的徽标跟上
  const [, bumpStore] = useState(0);
  useEffect(() => onStoreBackendChange(() => bumpStore((v) => v + 1)), []);
  const storePending = isPending();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const packRef = useRef<HTMLInputElement>(null);
  const jpsRef = useRef<HTMLInputElement>(null);


  const visible = useMemo(() => searchLibrary(items, query), [items, query]);

  /** 打包导出：谱面 + 标定 + 伴奏（wav 一律压成 mp3 后进包，见 buildPack） */
  const handlePack = async (item: LibraryItem): Promise<void> => {
    setBusy(true); // wav → mp3 压缩要几秒，锁住按钮防重复打包
    try {
      const align = loadAlign(item.name);
      const stems: { name: string; file: File }[] = [];
      for (const ref of align?.audio ?? []) {
        const f = await getAudio(ref.key);
        if (f) stems.push({ name: ref.name, file: f });
      }
      const bytes = await buildPack({ name: item.name, text: item.text, align, stems });
      const r = await saveBytesAsFile(bytes, packFileName(item.name));
      onNotify(
        !r.ok
          ? '打包取消'
          : `已打包 ${packFileName(item.name)}：` +
              (stems.length ? `谱面 + ${stems.length} 条伴奏（mp3）+ 标定` : '只有谱面（这首还没对过轨）'),
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * 导入打包：谱面进曲库 + 伴奏入库 + 标定写回。
   * 伴奏一律以 mp3 落库——老包里带着 wav 的，入库前先压掉
   * （键 = mp3 文件名:mp3 字节数，与之后播放 / 打包时对得上）。
   */
  const handleImportPack = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setBusy(true);
    let ok = 0;
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const b = await readPack(new Uint8Array(await f.arrayBuffer()));
        const item = importLibrary(b.name, b.text);
        if (!item) {
          bad.push(`${f.name}（写不进曲库）`);
          continue;
        }
        if (b.align) {
          const audio: { key: string; name: string }[] = [];
          for (const s of b.stems) {
            const mp3 = await ensureMp3(s.file);
            const key = audioKey({ name: mp3.name, size: mp3.size });
            await putAudio(key, mp3);
            audio.push({ key, name: mp3.name });
          }
          saveAlign(item.name, { ...b.align, audio });
        }
        ok += 1;
      } catch (e) {
        bad.push(`${f.name}（${(e as Error).message}）`);
      }
    }
    setBusy(false);
    onNotify(
      bad.length === 0
        ? `已导入 ${ok} 个打包（谱面 + 伴奏 + 标定）`
        : `已导入 ${ok} 个；失败：${bad.join('、')}`,
    );
  };

  /** 直接收 .jps 谱面（没有伴奏与标定，只有谱） */
  const handleImportJps = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    let ok = 0;
    for (const f of Array.from(files)) {
      if (importLibrary(f.name, await f.text())) ok += 1;
    }
    onNotify(`已收录 ${ok} 份谱面（只有谱，没有伴奏与标定）`);
  };

  const commitRename = (id: string): void => {
    const value = renameValue.trim();
    if (!value) {
      setRenaming(null);
      return;
    }
    if (!renameLibraryItem(id, value)) {
      onNotify(`改不了：已经有叫「${value}」的谱了`);
      return;
    }
    setRenaming(null);
  };

  return (
    <div className="v2-lib-screen">
      <header className="v2-lib-head">
        <span className="v2-lib-title">
        {readOnly ? '曲库查询' : '曲库'}
        <span className="v2-lib-count">{items.length} 首</span>
      </span>
        {readOnly && onBackHome ? (
          <button className="v2-btn" onClick={onBackHome} title="回到动态谱首页">
            ← 动态谱
          </button>
        ) : null}
      <input
          className="v2-lib-search"
          value={query}
          placeholder="搜名字 / 标题"
          onChange={(e) => setQuery(e.target.value)}
        />
        {/*
          曲库存储位置：文件后端（exe / Web 文件夹）下曲库 = 一个文件夹，
          整库迁移 = 拷走它。local 兜底时给一个升级入口；
          文件夹待授权（浏览器重启后）给「重新连接」。
        */}
        {/*
          曲库存储位置：文件后端（exe / Web 文件夹）下曲库 = 一个文件夹，
          整库迁移 = 拷走它。位置要**亮出来**（exe 显示完整路径 + 一键打开），
          别让人猜「到底存哪了」；local 兜底时给升级入口；
          文件夹待授权（浏览器重启后）给「重新连接」。
        */}
        {readOnly ? null : currentBackend() === 'folder' ? (
          <span className="v2-lib-store" title="曲库在这个文件夹里，拷贝它 = 迁移整个曲库">
            📁 {folderName || '曲库文件夹'}
          </span>
        ) : currentBackend() === 'tauri' ? (
          <>
            <span className="v2-lib-store" title={libraryRootPath() ?? '曲库所在目录'}>
              📁 {libraryRootPath() ?? '应用数据目录'}
            </span>
            <button
              className="v2-btn"
              title="在资源管理器里打开曲库文件夹"
              onClick={() => {
                void import('@tauri-apps/api/shell')
                  .then((s) => s.open(libraryRootPath() ?? '.'))
                  .catch((e) => onNotify(`打不开文件夹：${(e as Error).message}`));
              }}
            >
              打开文件夹
            </button>
          </>
        ) : storePending ? (
          <button className="v2-btn" onClick={() => void reconnectFolder()}>
            重新连接曲库文件夹
          </button>
        ) : (
          <button
            className="v2-btn"
            disabled={busy}
            title="把曲库放进一个真实文件夹：迁移 = 拷贝文件夹（现有歌会自动迁入）"
            onClick={() => {
              pickAndConnectFolder()
                .then(() => onNotify('曲库已放入文件夹——以后迁移只需拷贝它'))
                .catch((e) => onNotify(`没能连接文件夹：${(e as Error).message}`));
            }}
          >
            把曲库放进文件夹
          </button>
        )}
        {readOnly ? null : (
          <>
            <button
              className="v2-btn"
              disabled={busy}
              title="导入 .wspack：谱面 + 伴奏 + 对轨标定一起进曲库（别人分享的也能用）"
              onClick={() => packRef.current?.click()}
            >
              {busy ? '导入中…' : '导入打包'}
            </button>
            <button
              className="v2-btn"
              title="只收录 .jps 谱面（不含伴奏与标定）"
              onClick={() => jpsRef.current?.click()}
            >
              导入 .jps
            </button>
          </>
        )}
        <input
          ref={packRef}
          type="file"
          accept=".wspack,.zip"
          multiple
          hidden
          onChange={(e) => {
            void handleImportPack(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={jpsRef}
          type="file"
          accept=".jps,.txt"
          multiple
          hidden
          onChange={(e) => {
            void handleImportJps(e.target.files);
            e.target.value = '';
          }}
        />
      </header>

      {msg ? (
        <p className="v2-hint v2-lib-msg" role="status">
          {msg}
        </p>
      ) : null}

      <div className="v2-lib-list">
        {items.length === 0 ? (
          <p className="v2-hint">
            {readOnly
              ? '本机曲库还是空的。去「曲库制作」导入一个 .wspack（谱面 + 伴奏 + 标定），或在对轨界面配好伴奏后点「打包」。'
              : '曲库还是空的。点「导入打包」收进一个 .wspack（谱面 + 伴奏 + 标定就都有了），或「导入 .jps」只收谱面。在对轨界面配好伴奏后点「打包」，就能得到 .wspack。'}
          </p>
        ) : null}
        {items.length > 0 && visible.length === 0 ? (
          <p className="v2-hint">没有匹配「{query}」的谱面。</p>
        ) : null}

        {visible.map((it) => {
          const align = loadAlign(it.name);
          const hasAudio = (align?.audio?.length ?? 0) > 0;
          return (
            <div className="v2-lib-row" key={it.id}>
              {renaming === it.id ? (
                <input
                  className="v2-lib-rename"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(it.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button className="v2-lib-open" onClick={() => onOpen(it)} title="进播放界面（只放不编）">
                  <span className="v2-lib-name">
                    {it.name}
                    {it.meta.broken ? <span className="v2-lib-broken">无法解析</span> : null}
                    {hasAudio ? <span className="v2-lib-tag">有伴奏</span> : null}
                  </span>
                  <span className="v2-lib-meta">{describeMeta(it.meta)}</span>
                </button>
              )}

              {readOnly ? null : confirming === it.id ? (
                <span className="v2-lib-actions">
                  <span className="v2-lib-confirm">删除？</span>
                  <button
                    className="v2-btn is-danger"
                    onClick={() => {
                      removeLibraryItem(it.id);
                      setConfirming(null);
                    }}
                  >
                    是
                  </button>
                  <button className="v2-btn" onClick={() => setConfirming(null)}>
                    否
                  </button>
                </span>
              ) : (
                <span className="v2-lib-actions">
                  {readOnly ? null : (
                    <>
                      <button
                        className="v2-btn"
                        title="进对轨：配伴奏 / 调标定"
                        onClick={() => onEdit(it)}
                      >
                        对轨
                      </button>
                      <button
                        className="v2-btn"
                        title="谱面 + 伴奏 + 标定打包成一个 .wspack（可分享）"
                        onClick={() => void handlePack(it)}
                      >
                        打包
                      </button>
                    </>
                  )}
                  {readOnly ? null : (
                    <>
                      <button
                        className="v2-btn"
                        onClick={() => {
                          setRenaming(it.id);
                          setRenameValue(it.name);
                        }}
                      >
                        重命名
                      </button>
                      <button className="v2-btn" onClick={() => setConfirming(it.id)}>
                        删除
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="v2-hint v2-lib-foot-note">
        {readOnly
          ? '这里是查询页：曲库只读，不能导入 / 打包 / 删除。要改内容请去「曲库制作」。'
          : '谱面、伴奏、标定都存本机浏览器里（清缓存会丢）。要长期留存或分享给别人，用「打包」导出 .wspack——对方在曲库界面「导入打包」即可完整还原。'}
      </p>
    </div>
  );
}
