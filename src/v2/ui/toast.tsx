import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 通用提示浮层。
 *
 * 以前各处各写一套（绑定成功一个、保存一个），样式与淡出时序复制来复制去。
 * 这里统一成四种语气：
 *   progress — 进行中（转圈），一直显示到被 ok / fail / hide 收尾；
 *   success  — 成功（绿色对勾），自动淡出；
 *   error    — 出错 / 需核对（红色），停留更久，免得一闪而过；
 *   info     — 中性提示，只表示「有事发生了」。
 *
 * 用法：耗时的活儿 progress → ok，可能失败的一路 fail；
 * 一两秒内的轻量操作别用它，状态栏一行字就够了（弹多了反而烦）。
 */

export type ToastKind = 'progress' | 'success' | 'error' | 'info';

export interface ToastState {
  kind: ToastKind;
  /** 主标题，短（「正在打包…」「保存成功」） */
  text: string;
  /** 副标题：细节或分段耗时，可空 */
  body?: string;
  /** 淡出中（动画用，组件内部推进，外部不用管） */
  fade: boolean;
  /** 每次显示都换，用来重放入场动画 */
  key: number;
}

export interface ToastApi {
  toast: ToastState | null;
  /** 进行中：转圈，直到被收尾 */
  progress: (text: string, body?: string) => void;
  /** 成功：对勾后自动淡出 */
  ok: (text: string, body?: string) => void;
  /** 失败 / 警告：红色，停留更久 */
  fail: (text: string, body?: string) => void;
  /** 中性提示 */
  info: (text: string, body?: string) => void;
  hide: () => void;
}

/** 淡出动画时长，与 CSS .v2-toast.is-fade 的 transition 保持一致 */
const FADE_MS = 400;

export function useToast(): ToastApi {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timers = useRef<number[]>([]);
  const seq = useRef(0);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const fire = useCallback(
    (kind: ToastKind, text: string, body?: string) => {
      clearTimers();
      seq.current += 1;
      setToast({ kind, text, body, fade: false, key: seq.current });
      // 进行中不自动消失：等调用方用 ok / fail 收尾
      if (kind === 'progress') return;
      // 带副标题（通常是分段耗时）时多留一会儿，才来得及看清
      const hold = kind === 'error' ? 4000 : body ? 2200 : 1200;
      timers.current.push(
        window.setTimeout(() => setToast((p) => (p ? { ...p, fade: true } : null)), hold),
      );
      timers.current.push(window.setTimeout(() => setToast(null), hold + FADE_MS));
    },
    [clearTimers],
  );

  const hide = useCallback(() => {
    clearTimers();
    setToast(null);
  }, [clearTimers]);

  return {
    toast,
    progress: useCallback((text: string, body?: string) => fire('progress', text, body), [fire]),
    ok: useCallback((text: string, body?: string) => fire('success', text, body), [fire]),
    fail: useCallback((text: string, body?: string) => fire('error', text, body), [fire]),
    info: useCallback((text: string, body?: string) => fire('info', text, body), [fire]),
    hide,
  };
}

/** 浮层本体：一处渲染，四种语气只差一个 class */
export function ToastView({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss?: () => void;
}) {
  if (!toast) return null;
  const cls =
    'v2-toast' +
    (toast.fade ? ' is-fade' : '') +
    (toast.kind === 'progress' ? ' is-busy' : '') +
    (toast.kind === 'error' ? ' is-err' : '');
  const icon = toast.kind === 'error' ? '!' : toast.kind === 'success' ? '✓' : '';
  return (
    <div
      className={cls}
      key={toast.key}
      role="status"
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      {...(onDismiss ? { onClick: onDismiss } : {})}
    >
      <span className="v2-toast-icon" aria-hidden>
        {icon}
      </span>
      <span className="v2-toast-text">
        <b>{toast.text}</b>
        {toast.body ? <span>{toast.body}</span> : null}
      </span>
    </div>
  );
}
