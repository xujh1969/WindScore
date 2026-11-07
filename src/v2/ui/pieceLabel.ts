/**
 * 工具栏「示例乐谱」下拉里「当前谱面」那一格的状态。
 *
 * 曲谱属性改的是谱面 @title（score.meta.title），而 active 是打开时的
 * 文件名 / 曲库条目名，两者是两个独立状态源：只认 active 就会出现
 * 「改了曲名、左上角下拉框还挂着旧名」。反过来也不能无脑显示 @title：
 * 内置示例曲的下拉名与谱里 @title 本来就不同（如「生日快乐（3/4 拍）」
 * 的 @title 是「生日快乐」），那样内置曲会不再选中自己的选项。
 * 所以用「载入时的 @title」做基线，只有用户确实改过标题才换成新名。
 */
export interface PieceSelectState {
  /** 「当前谱面」项显示的文字 */
  label: string;
  /** select 的 value：内置示例名 = 选中内置项；'' = 选中「当前谱面」项 */
  value: string;
}

export function pieceSelectState(
  title: string | undefined,
  loadedTitle: string,
  active: string,
  builtinNames: readonly string[],
): PieceSelectState {
  const next = (title ?? '').trim();
  // 清空标题不算改名：没名字就继续显示打开时的名字，别让下拉框空着
  const renamed = next.length > 0 && next !== loadedTitle;
  const builtin = !renamed && builtinNames.includes(active);
  return {
    label: renamed ? next : (active || '（当前谱面）'),
    value: builtin ? active : '',
  };
}
