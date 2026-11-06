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

/** 网络传入的纯谱面（.jps）：无伴奏、无标定，直接入库，播放走合成音。 */
export async function importUploadedJps(bytes: Uint8Array, name: string, isActive: () => boolean): Promise<string> {
  const check = () => { if (!isActive()) throw new Error('上传服务已停用，导入已取消'); };
  check();
  const text = new TextDecoder('utf-8').decode(bytes);
  if (metaOfText(text).broken) throw new Error('谱面内容无法解析');
  check();
  // importLibrary 内部会去掉 .jps 后缀并自动避开同名曲目
  const item = importLibrary(name, text);
  if (!item) throw new Error('曲库无法保存，请检查手机剩余空间');
  await flushLibraryWrites();
  return item.name;
}
