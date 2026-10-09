import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import guide from '../../../docs/user-guide.md?raw';
import './help.css';

const ids = ['quick-start', 'editing', 'shortcuts', 'structure', 'ensemble', 'lyrics', 'alignment', 'library', 'playback', 'export', 'jps', 'faq'];
const topics = guide.split('\n## ').slice(1).map((part, i) => {
  const end = part.indexOf('\n');
  return { id: ids[i], title: part.slice(0, end).trim(), body: part.slice(end).trim() };
});

/** 本地手册使用的 Markdown 子集；直接输出 React 文本，不执行 HTML。 */
function inline(text: string): ReactNode {
  return text.replace(/\\\|/g, '|').split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}

function GuideText({ body }: { body: string }) {
  const lines = body.split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const key = i;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>); continue;
    }
    if (line.startsWith('### ')) { blocks.push(<h2 key={key}>{inline(line.slice(4))}</h2>); i++; continue; }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++].trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()));
      blocks.push(<div className="ws-help-table" key={key}><table><thead><tr>{rows[0].map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.slice(2).map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const ordered = /^\d+\. /.test(line);
    if (ordered || line.startsWith('- ')) {
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\d+\. / : /^- /;
      while (i < lines.length && pattern.test(lines[i])) items.push(<li key={i}>{inline(lines[i++].replace(pattern, ''))}</li>);
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    const paragraph: string[] = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(### |```|\||- |\d+\. )/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join(' '))}</p>);
  }
  return <>{blocks}</>;
}

export function HelpCenter({ initialTopic = 'quick-start', onClose, onSelect, tools }: { initialTopic?: string; onClose?: () => void; onSelect?: (id: string) => void; tools?: ReactNode }) {
  const [selected, setSelected] = useState(initialTopic);
  const [query, setQuery] = useState('');
  const article = useRef<HTMLElement>(null);
  const q = query.trim().toLocaleLowerCase();
  const matches = topics.filter((topic) => !q || `${topic.title}\n${topic.body}`.toLocaleLowerCase().includes(q));
  const topic = matches.find((item) => item.id === selected) ?? matches[0];
  const index = topic ? topics.indexOf(topic) : -1;
  useEffect(() => { article.current?.scrollTo(0, 0); }, [topic?.id]);
  const choose = (id: string): void => { setSelected(id); setQuery(''); onSelect?.(id); };
  return <div className="ws-help-center" onKeyDown={(e) => e.stopPropagation()}>
    <header className="ws-help-head"><div><strong>WindScore</strong><span>使用帮助</span></div><div className="ws-help-actions">{tools}{onClose ? <button className="v2-btn" onClick={onClose}>关闭帮助</button> : null}</div></header>
    <div className="ws-help-body">
      <aside className="ws-help-nav">
        <label className="ws-help-search"><span>搜索帮助</span><input autoFocus={!!onClose} type="search" placeholder="试试：歌词、锚点、反复" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <p className="ws-help-count" role="status">{q ? `找到 ${matches.length} 个相关分类` : '按制作流程查阅'}</p>
        <nav aria-label="帮助分类">{matches.map((item) => <button key={item.id} aria-current={item.id === topic?.id ? 'page' : undefined} onClick={() => choose(item.id)}>{item.title}</button>)}</nav>
        <p className="ws-help-local">本机帮助 · 可离线阅读</p>
      </aside>
      <article className="ws-help-article" ref={article} aria-label={topic?.title ?? '搜索结果'}>
        {topic ? <Fragment key={topic.id}><h1>{topic.title}</h1><GuideText body={topic.body} /><footer className="ws-help-pager">{index > 0 ? <button className="v2-btn" onClick={() => choose(topics[index - 1].id)}>← {topics[index - 1].title}</button> : <span />}{index < topics.length - 1 ? <button className="v2-btn" onClick={() => choose(topics[index + 1].id)}>{topics[index + 1].title} →</button> : null}</footer></Fragment> : <div className="ws-help-empty"><h1>没有找到相关内容</h1><p>换一个关键词，例如「拍号」「伴奏」或「保存」。</p><button className="v2-btn" onClick={() => setQuery('')}>查看全部分类</button></div>}
      </article>
    </div>
  </div>;
}

export function HelpDialog({ initialTopic, dark, onClose }: { initialTopic?: string; dark: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal(); el.querySelector<HTMLInputElement>('input')?.focus();
    return () => { el.close(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className="v2-app ws-help-dialog" data-theme={dark ? 'dark' : 'light'} aria-label="WindScore 使用帮助" onKeyDown={(e) => e.stopPropagation()} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
  }}><HelpCenter initialTopic={initialTopic} onClose={onClose} /></dialog>, document.body);
}

export function HelpPage() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const initialTopic = location.hash.slice(1) || 'quick-start';
  return <div className="v2-app ws-help-page" data-theme={dark ? 'dark' : 'light'}><HelpCenter initialTopic={initialTopic} onSelect={(id) => history.replaceState(null, '', `#${id}`)} tools={<><a className="v2-home-btn" href="./index.html">← 返回首页</a><button className="v2-btn" onClick={() => setDark(!dark)}>{dark ? '浅色' : '深色'}</button></>} /></div>;
}
