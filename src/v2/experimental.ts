import { useSyncExternalStore } from 'react';

/**
 * **实验功能开关**：还在验证中的功能统一挂在这里，默认**全部关闭**。
 *
 * 用意：新功能（如五线谱视图）先写在这道闸门后面——关着的时候
 * 代码路径根本不走，现有记谱 / 播放 / 导出的行为逐字节不变，
 * 可以放心改；等验证够了，再决定转正或删掉。
 *
 * 开关值存在 localStorage（键 `ws-exp`），只在需要时手动打开。
 */

export type ExpKey = 'staffView';

const STORAGE_KEY = 'ws-exp';

/** 所有实验项的出厂默认：一律 false */
const DEFAULTS: Record<ExpKey, boolean> = {
  staffView: false,
};

const listeners = new Set<() => void>();

let flags: Partial<Record<ExpKey, boolean>> = read();

function read(): Partial<Record<ExpKey, boolean>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<ExpKey, boolean>>) : {};
  } catch {
    return {};
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** 某个实验功能是否打开 */
export function isExpOn(k: ExpKey): boolean {
  return flags[k] ?? DEFAULTS[k];
}

/** 打开 / 关闭某个实验功能 */
export function setExp(k: ExpKey, v: boolean): void {
  flags = { ...flags, [k]: v };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    /* 隐私模式存不了就算了 */
  }
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 在组件里读写某个实验开关；开关变化时自动重渲染 */
export function useExp(k: ExpKey): [boolean, (v: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => isExpOn(k));
  return [on, (v: boolean) => setExp(k, v)];
}
