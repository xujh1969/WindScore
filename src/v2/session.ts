/**
 * 编辑会话持久化：把「上次改到哪儿」存在浏览器本地，重启后接着改。
 *
 * 存的是**内容**而不是文件路径，原因是两端的文件逻辑不一样、也还没定：
 *   - 浏览器出于安全拿不到真实路径，只有下载
 *   - 就算存了路径，文件被移动 / 删除后启动时去打开它会直接报错
 * 存内容两端都成立，也天然避开了「启动时打开一个不存在的文件」。
 *
 * 真实路径只在 Tauri 保存成功后记一下，仅用于顶部显示。
 */

const KEY = 'windscore.session.v1';

export interface Session {
  /** 当前编辑内容的 DSL 文本 */
  text: string;
  /** 来源名（内置曲名或文件名），只用于显示 */
  name: string;
  /** 上次保存过的真实路径；浏览器端或从未保存过时为 null */
  path: string | null;
  /** 写入时间戳 */
  at: number;
}

/**
 * 解析存下来的会话。纯函数，可单测。
 * 任何不合法的情况都返回 null——损坏的草稿宁可丢掉，也不能让编辑器起不来。
 */
export function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Session> | null;
    if (!v || typeof v !== 'object') return null;
    if (typeof v.text !== 'string') return null;
    return {
      text: v.text,
      name: typeof v.name === 'string' ? v.name : '上次编辑',
      path: typeof v.path === 'string' && v.path ? v.path : null,
      at: typeof v.at === 'number' ? v.at : 0,
    };
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  try {
    return parseSession(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveSession(s: { text: string; name: string; path: string | null }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, at: Date.now() }));
  } catch {
    /* 隐私模式 / 配额满：写不进去就算了，绝不能影响编辑 */
  }
}


