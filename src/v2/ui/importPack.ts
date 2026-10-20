import { audioKey, clearAlign, putAudio, saveAlignChecked, type AlignPersist } from './alignStore';
import { flushLibraryWrites, importLibrary, metaOfText, readLibrary, uniqueName } from './libraryStore';
import { readPack } from './packBundle';
import { ensureMp3 } from '../mp3';

/** 上传顺序消费，不同时展开多个大包；手机实际保存成功才返回最终曲名。 */
export async function importUploadedPack(bytes: Uint8Array, isActive: () => boolean): Promise<string> {
  const check = () => { if (!isActive()) throw new Error('上传服务已停用，导入已取消'); };
  check();
  const pack = await readPack(bytes, true);
  if (metaOfText(pack.text).broken) throw new Error('谱面内容无法解析');
  const audio: AlignPersist['audio'] = [];
  for (const stem of pack.stems) {
    check();
    const file = await ensureMp3(stem.file);
    check();
    const key = audioKey(file);
    await putAudio(key, file, true);
    audio.push({ key, name: file.name });
  }
  check();
  const name = uniqueName(pack.name, readLibrary().map(item => item.name));
  const align: AlignPersist = pack.align ? { ...pack.align, audio } : {
    version: 1, audio, tempoDraft: { bpm: metaOfText(pack.text).bpm ?? 120, phaseSec: 0, originBeat: 0 }, anchors: [], override: null, playSource: audio.length ? 'audio' : 'synth',
  };
  try {
    await saveAlignChecked(name, align);
    check();
    const item = importLibrary(name, pack.text);
    if (!item) throw new Error('曲库无法保存，请检查手机剩余空间');
    await flushLibraryWrites();
    return item.name;
  } catch (error) {
    // 未建立曲库条目的标定无需保留；不删除可能被其他曲目引用的伴奏。
    if (!readLibrary().some(item => item.name === name)) clearAlign(name);
    throw error;
  }
}
