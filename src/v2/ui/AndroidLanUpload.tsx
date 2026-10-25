import { useCallback, useEffect, useRef, useState } from 'react';
import { importUploadedPack } from './importPack';
import { AndroidIcon } from './AndroidComponents';

type JobState = 'waiting' | 'receiving' | 'queued' | 'importing' | 'success' | 'error';
interface UploadJob { id: string; name: string; size: number; received: number; state: JobState; song: string; error: string }
interface ServiceState { running: boolean; connected: boolean; connectedBefore: boolean; message: string; url: string; jobs: UploadJob[] }
interface UploadBridge {
  startUploadService(): string; stopUploadService(): string; getUploadServiceStatus(): string; copyUploadAddress?(): boolean;
  takeNextUpload(): string; isUploadActive(id: string): boolean; completeUpload(result: string): void;
}
const idle: ServiceState = { running: false, connected: false, connectedBefore: false, message: '服务未启动', url: '', jobs: [] };
const labels: Record<JobState, string> = { waiting: '等待上传', receiving: '接收中', queued: '等待校验', importing: '校验并导入中', success: '已导入', error: '未导入' };

/** 消费任务属于应用层，切换曲库/我的或进入播放页不会卸载它。 */
export function useLanUpload(enabled: boolean, onImported: (message: string) => void) {
  const bridge = (window as unknown as { WindScoreAndroid?: UploadBridge }).WindScoreAndroid;
  const native = typeof bridge?.startUploadService === 'function';
  const [state, setState] = useState<ServiceState>(idle);
  const imported = useRef(onImported); imported.current = onImported;
  const processing = useRef(false);
  const stop = useCallback(() => {
    try { setState(native ? JSON.parse(bridge!.stopUploadService()) : idle); }
    catch { setState({ ...idle, message: '上传服务已停止' }); }
  }, [bridge, native]);
  useEffect(() => {
    if (!native || !enabled) return;
    let disposed = false;
    const poll = async () => {
      try {
        const current = JSON.parse(bridge!.getUploadServiceStatus()) as ServiceState;
        if (!disposed) setState(current);
        if (!current.running || processing.current || disposed) return;
        const job = JSON.parse(bridge!.takeNextUpload()) as { id: string; name: string } | null;
        if (!job) return;
        processing.current = true;
        try {
          const response = await fetch(`/lan-upload/${encodeURIComponent(job.id)}`, { cache: 'no-store' });
          if (!response.ok) throw new Error('暂存文件已失效，请重新上传');
          const song = await importUploadedPack(new Uint8Array(await response.arrayBuffer()), () => !disposed && bridge!.isUploadActive(job.id));
          bridge!.completeUpload(JSON.stringify({ id: job.id, song, error: '' }));
          if (!disposed) imported.current(`已从电脑导入：${song}`);
        } catch (error) {
          bridge!.completeUpload(JSON.stringify({ id: job.id, song: '', error: error instanceof Error ? error.message : '导入失败，请检查手机存储后重试' }));
        } finally { processing.current = false; }
      } catch {
        if (!disposed) setState(old => ({ ...old, running: false, url: '', message: '无法连接手机上传服务，请重新启动' }));
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1000);
    const stop = () => { bridge!.stopUploadService(); };
    addEventListener('pagehide', stop);
    return () => { disposed = true; clearInterval(timer); removeEventListener('pagehide', stop); stop(); };
  }, [native, enabled, bridge]);
  const toggle = () => {
    try {
      if (native) setState(JSON.parse(state.running ? bridge!.stopUploadService() : bridge!.startUploadService()));
      else setState(state.running ? idle : { ...idle, running: true, message: '界面演示：等待电脑连接（需在安卓 App 中使用真实服务）' });
    } catch { setState({ ...idle, message: '服务启动失败，请检查网络后重试' }); }
  };
  return { state, native, toggle, stop };
}

export function AndroidLanUpload({ service, disabled, onNotice }: { service: ReturnType<typeof useLanUpload>; disabled: boolean; onNotice: (message: string) => void }) {
  const { state, native, toggle } = service;
  const active = state.jobs.find(job => job.state === 'receiving' || job.state === 'importing');
  const completed = state.jobs.length > 0 && state.jobs.every(job => job.state === 'success' || job.state === 'error');
  // 服务开着但电脑迟迟连不上：20 秒后给出「设备隔离 / 热点」提示（公司网络最常见）
  const [stuckTip, setStuckTip] = useState(false);
  useEffect(() => {
    setStuckTip(false);
    if (!state.running || state.connected) return;
    const id = setTimeout(() => setStuckTip(true), 20_000);
    return () => clearTimeout(id);
  }, [state.running, state.connected]);
  const status = !state.running ? state.message : active ? `${labels[active.state]}：${active.name}` : completed
    ? `本批完成：成功 ${state.jobs.filter(job => job.state === 'success').length} 首，失败 ${state.jobs.filter(job => job.state === 'error').length} 首`
    : state.connected ? '电脑已连接，等待上传' : state.connectedBefore ? '等待电脑重新连接' : !native ? '等待电脑连接 · 预览' : state.message;
  const copy = async () => {
    try {
      const bridge = (window as unknown as { WindScoreAndroid?: UploadBridge }).WindScoreAndroid;
      if (bridge?.copyUploadAddress) { if (!bridge.copyUploadAddress()) throw new Error('复制失败'); }
      else await navigator.clipboard.writeText(state.url);
      onNotice('地址已复制，请在电脑浏览器打开');
    } catch { onNotice('复制失败，请长按地址复制'); }
  };
  return <section className="an-lan" aria-labelledby="an-lan-heading">
    <div className={`an-transfer-visual ${state.running ? 'is-running' : ''}`} aria-label="电脑与手机处于同一局域网（同一 Wi-Fi 或手机热点）">
      <div className="an-transfer-device"><AndroidIcon name="computer"/><span>电脑</span></div>
      <div className="an-transfer-link"><AndroidIcon name="wifi"/><i/><span>同一局域网</span></div>
      <div className="an-transfer-device an-transfer-phone"><AndroidIcon name="phone"/><span>手机</span></div>
    </div>
    <div className="an-lan-heading"><h2 id="an-lan-heading">局域网传曲</h2><div className="an-transfer-limits"><span>.wspack</span><span>每批 ≤ 9 个</span></div></div>
    <p className={`an-lan-status ${state.running ? 'is-running' : ''}`} role="status"><i/>{status}</p>
    <ol className="an-transfer-steps" aria-label="传曲步骤">{['启动服务', '电脑打开地址', '上传乐曲'].map((label, i) => <li key={label} className={(i === 0 && state.running || i === 1 && state.connected || i === 2 && completed) ? 'is-done' : ''}><span>{i + 1}</span>{label}</li>)}</ol>
    {state.running && <>
      <div className="an-lan-address"><label htmlFor="an-lan-url">电脑浏览器地址</label><input id="an-lan-url" readOnly value={state.url || '安卓 App 中显示连接地址'} onFocus={e => e.target.select()}/><button className="an-secondary" disabled={!state.url} onClick={() => { void copy(); }}><AndroidIcon name="copy"/>复制地址</button></div>
      {stuckTip && !state.connected && <div className="an-lan-hotspot" role="note">
        <p><strong>电脑一直连不上？</strong>当前 Wi-Fi 可能开启了「设备隔离」（公司网络常见：同一 Wi-Fi 的设备互相不可见）。</p>
        <p>改用手机热点：手机开个人热点 → 电脑连这个热点 → 停用后重新启动乐曲服务 → 用新地址打开。</p>
      </div>}
      <div className="an-transfer-notes"><p><AndroidIcon name="sun"/>传输时保持双端亮屏</p><p><AndroidIcon name="chevron"/>可切到聊天软件发地址，返回本页完成导入</p><p><AndroidIcon name="chevron"/>公司 Wi-Fi 常开设备隔离，连不上时可用手机热点让电脑接入</p></div>
      {!native && <p className="an-lan-demo">界面预览，不启动网络服务 · <a href="windscore-upload.html?demo=1" target="_blank" rel="noreferrer">电脑上传页</a></p>}
    </>}
    <button className={state.running ? 'an-secondary' : 'an-primary'} onClick={toggle} disabled={disabled && !state.running}>{state.running ? '停用乐曲服务' : '启动乐曲服务'}</button>
    <p className="an-transfer-exit">切到曲库或社区将停用服务</p>
    {state.jobs.length > 0 && <ul className="an-lan-results" aria-label="上传导入结果">{state.jobs.map(job => <li key={job.id}>
      <strong>{job.state === 'success' ? job.song : job.name}</strong><span className={job.state === 'error' ? 'is-error' : ''}>{labels[job.state]}{job.state === 'receiving' ? ` ${Math.round(job.received / job.size * 100)}%` : ''}{job.error ? `：${job.error}` : ''}</span>
    </li>)}</ul>}
  </section>;
}
