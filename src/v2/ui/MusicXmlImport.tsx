import { useRef, useState } from 'react';
import { musicXmlSummary, musicXmlToJps, readMusicXmlFile, type MusicXmlSummary } from '../musicxml';
import { saveSession } from '../session';
import { ExpClose } from './ExpClose';
import { ThemeToggle } from './ThemeToggle';

/**
 * 乐谱导入（MusicXML 转译，实验性测试功能，2026-10-31）：
 * 拖入 / 选择 .musicxml / .xml / .mxl → 列出声部勾选（可全选，至少一个）→
 * 转译成 .jps → 预览 / 下载 / 交给编辑器打开。
 *
 * 布局锁：主流程三张卡（选择文件 → 选择声部 → 转换结果）前置，
 * 转录引导与记号支持说明作为参考资料后置；样式全走 v2 令牌，浅深主题自动成立。
 */
export function MusicXmlImport() {
  // 主题键与其他页统一（ws-theme：'dark'/'light'），旧键 ws-dark 只作迁移兜底
  const [dark, setDark] = useState(() => {
    const t = localStorage.getItem('ws-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return localStorage.getItem('ws-dark') === '1' || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  });
  const [fileName, setFileName] = useState('');
  const [summary, setSummary] = useState<MusicXmlSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ dsl: string; warnings: string[]; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggleDark = (d: boolean): void => {
    setDark(d);
    try {
      localStorage.setItem('ws-theme', d ? 'dark' : 'light');
    } catch {
      /* 隐私模式写不进就算了 */
    }
  };

  const pick = async (file: File): Promise<void> => {
    setBusy(true);
    setMsg('');
    setResult(null);
    try {
      const xml = await readMusicXmlFile(file);
      xmlCache.current = xml;
      const { summary: s, errors } = musicXmlSummary(xml);
      if (errors.length) {
        setMsg(`解析出错：${errors.join('；')}`);
        setSummary(null);
      } else if (!s.parts.length) {
        setMsg('这份 MusicXML 里没有找到声部（<part>）');
        setSummary(null);
      } else {
        setFileName(file.name);
        setSummary(s);
        setSelected(new Set(s.parts.map((p) => p.id)));
      }
    } catch (e) {
      setMsg(`读取失败：${String(e instanceof Error ? e.message : e)}`);
      setSummary(null);
    } finally {
      setBusy(false);
    }
  };

  // xml 原始文本放 ref 缓存（不参与渲染，不占 state）
  const xmlCache = useRef('');
  const xmlText = (): string => xmlCache.current;

  const convert = (): void => {
    if (!summary || selected.size === 0) return;
    // 转译是同步的纯计算；包一层 setTimeout 让按钮先画出按下态（大谱会有可感知的停顿）
    setTimeout(() => {
      try {
        setResult(musicXmlToJps(xmlText(), [...selected], { fallbackTitle: fileName.replace(/\.(musicxml|xml|mxl)$/i, '') }));
      } catch (e) {
        setMsg(`转换失败：${String(e instanceof Error ? e.message : e)}`);
      }
    }, 30);
  };

  const download = (): void => {
    if (!result?.dsl) return;
    const base = fileName.replace(/\.(musicxml|xml|mxl)$/i, '') || '导入谱面';
    const blob = new Blob([result.dsl], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}.jps`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openInEditor = (): void => {
    if (!result?.dsl) return;
    const base = fileName.replace(/\.(musicxml|xml|mxl)$/i, '') || '乐谱导入';
    saveSession({ text: result.dsl, name: base, path: null });
    window.location.href = './editor.html';
  };

  const pickFile = (f: File | undefined): void => {
    if (f) void pick(f);
  };

  const openPicker = (): void => {
    if (!busy) fileRef.current?.click();
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDrag(false);
    if (!busy) pickFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry="musicxml">
      {/* 与启动页同一张晨光草叶底图（深色换夜色底图），只作背景，卡片仍不透明 */}
      <div className="ws-xml-bg" aria-hidden="true" />
      <header className="v2-head">
        <a className="v2-home-btn" href="./index.html" title="回到首页">
          ← 返回首页
        </a>
        <span className="v2-brand-name">
          乐谱导入 <span className="v2-brand-tag">测试功能</span>
        </span>
        <div style={{ flex: 1 }} />
        <ThemeToggle dark={dark} onChange={toggleDark} />
      </header>
      <main className="ws-xml">
        {/* ── 选择文件：拖放区 / 已选文件条 ── */}
        <section className="ws-xml-card">
          <h2 className="ws-xml-step">选择文件</h2>
          {fileName ? (
            <div className="ws-xml-file">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z" />
                <path d="M13 3v6h6" />
                <path d="M9 17.5v-5l6-1.5v5" />
                <circle cx="7.6" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="13.6" cy="16" r="1.4" fill="currentColor" stroke="none" />
              </svg>
              <span className="ws-xml-file-name" title={fileName}>
                {fileName}
              </span>
              <button className="v2-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                更换文件
              </button>
            </div>
          ) : (
            <div
              className={`ws-xml-drop${drag ? ' is-drag' : ''}`}
              role="button"
              tabIndex={0}
              aria-disabled={busy}
              onClick={openPicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPicker();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z" />
                <path d="M13 3v6h6" />
                <path d="M10.4 17.2V7.6l6.2-1.5" />
                <circle cx="8.9" cy="17.2" r="1.5" fill="currentColor" stroke="none" />
              </svg>
              <p className="ws-xml-drop-title">{busy ? '正在读取文件…' : '把文件拖到这里，或点击选择'}</p>
              <p className="ws-xml-drop-sub">.musicxml / .xml / .mxl</p>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".musicxml,.xml,.mxl"
            style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </section>

        {msg ? <p className="v2-xml-err">{msg}</p> : null}

        {/* ── 选择声部与转换方式 ── */}
        {summary ? (
          <section className="ws-xml-card">
            <h2 className="ws-xml-step">选择声部</h2>
            <div className="v2-field">
              <span className="v2-field-label">
                要转换的声部（{selected.size}/{summary.parts.length}，至少一个）
              </span>
              <div className="v2-grace-bar">
                {summary.parts.map((p) => (
                  <label key={p.id} className={`v2-btn${selected.has(p.id) ? ' is-on' : ''}`} style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        setSelected(next);
                      }}
                      style={{ marginRight: 6, verticalAlign: '-1px' }}
                    />
                    {p.name}
                  </label>
                ))}
                <button
                  className="v2-btn"
                  onClick={() => setSelected(new Set(summary.parts.map((p) => p.id)))}
                  title="全选声部"
                >
                  全选
                </button>
              </div>
            </div>
            <button className="v2-btn v2-btn--primary ws-xml-convert" disabled={selected.size === 0 || busy} onClick={convert}>
              转换为 .jps
            </button>
          </section>
        ) : null}

        {/* ── 转换失败就地提示（成功走下方弹窗） ── */}
        {result && result.errors.length ? <p className="v2-xml-err">转换出错：{result.errors.join('；')}</p> : null}

        {/* ── 参考资料：转录引导 + 记号支持范围 ── */}
        <div className="ws-xml-tip">
          <strong>没有 MusicXML 谱子？先转录再导入：</strong>
          把音乐文件上传到{' '}
          <a href="https://muscriptor.kyutai.org/" target="_blank" rel="noreferrer">
            muscriptor.kyutai.org
          </a>{' '}
          进行 <em>Transcribe</em>（转写），下载 Sheet music 压缩包，解压后里面的{' '}
          <code>.musicxml</code> 就能直接导入本页（也接受 .mxl 压缩包）。动手能力强的话，
          也可以自己部署它的开源项目在本地转录，不用传网。
          <a
            className="ws-xml-tip-btn"
            href="https://muscriptor.kyutai.org/"
            target="_blank"
            rel="noreferrer"
          >
            打开 Muscriptor ↗
          </a>
        </div>
        <details className="ws-xml-more">
          <summary>支持的记号与已知限制</summary>
          <p>
            支持调号、拍号、速度、变音、高低八度、延音线、连线、连音、反复、房子、弱起、跳音、力度、
            渐强渐弱、8va/8vb、颤音、震音、琶音、打击乐（转 X 无音高音符）等常见记号；
            多声部层、跨拍连音、歌词、滑音线、跳转记号等暂不支持（会转成近似或跳过，并在转换后列出）。
          </p>
        </details>
      </main>

      {/* ── 转换完毕弹窗：不展示源码，只问「直接编辑还是保存」 ── */}
      {result && !result.errors.length ? (
        <div
          className="v2-exp-mask"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setResult(null);
          }}
        >
          <div
            className="v2-exp ws-xml-done"
            role="dialog"
            aria-modal="true"
            aria-label="转换完毕"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setResult(null);
            }}
          >
            <div className="v2-exp-head">
              <strong>转换完毕</strong>
              <ExpClose onClose={() => setResult(null)} />
            </div>
            <div className="v2-exp-body">
              <p className="ws-xml-done-msg">
                已转换为 .jps（{selected.size} 个声部）。
                {result.warnings.length ? `有 ${result.warnings.length} 条转换提示：` : '没有转换提示。'}
              </p>
              {result.warnings.length ? (
                <ul className="v2-xml-warn ws-xml-done-warn">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="v2-part-dialog-footer">
              <button className="v2-btn" onClick={download} title="把 .jps 文件下载到本地">
                保存 .jps
              </button>
              <button className="v2-btn v2-btn--primary" onClick={openInEditor} title="写入编辑会话并跳到简谱编辑">
                直接编辑
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
