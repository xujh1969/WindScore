/**
 * 弹窗右上角的 × 关闭按钮：所有弹窗统一用这一个组件。
 *
 * 规矩（用户定的）：**所有弹窗的关闭按钮都是 ×，都放在窗口右上角**——
 * 不要再发明「关闭」「暂不」「完成」这类文字按钮当关闭用，
 * 位置也不许贴在标题旁边（.v2-exp-head 有 space-between，会把它推到最右）。
 */
export function ExpClose({ onClose, disabled, title = '关闭' }: { onClose: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="v2-exp-close" aria-label="关闭" title={title} onClick={onClose} disabled={disabled}>
      ×
    </button>
  );
}
