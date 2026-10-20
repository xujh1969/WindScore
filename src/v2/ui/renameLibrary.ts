import { clearAlign, loadAlign, saveAlignChecked, clearAlignChecked } from './alignStore';
import { flushLibraryWrites, normalizeName, readLibrary, renameLibraryItem } from './libraryStore';

/** 曲库名称也是标定索引；先复制关联，再改名，避免丢失伴奏引用。音频文件不用搬动。 */
export async function renameLibraryWithAssets(id: string, value: string): Promise<boolean> {
  const name = normalizeName(value);
  const items = readLibrary();
  const original = items.find(item => item.id === id);
  if (!original || !name || items.some(item => item.id !== id && item.name === name)) return false;
  if (original.name === name) return true;
  const align = loadAlign(original.name);
  const previous = loadAlign(name);
  let copied = false;
  try {
    if (align) await saveAlignChecked(name, align);
    else await clearAlignChecked(name); // 新名称可能遗留一份已删除曲目的标定。
    copied = true;
    const current = readLibrary().find(item => item.id === id);
    if (current?.name !== original.name || !renameLibraryItem(id, name)) throw new Error('曲库已变化或无法保存');
    await flushLibraryWrites();
    if (!readLibrary().some(item => item.name === original.name)) clearAlign(original.name);
    return true;
  } catch {
    if (readLibrary().find(item => item.id === id)?.name === name) {
      renameLibraryItem(id, original.name);
      await flushLibraryWrites().catch(() => undefined);
    }
    if (copied && !readLibrary().some(item => item.name === name)) {
      try {
        if (previous) await saveAlignChecked(name, previous);
        else await clearAlignChecked(name);
      } catch { /* 原名称及其标定仍保留，不能因清理失败报成功。 */ }
    }
    return false;
  }
}
