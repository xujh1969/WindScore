/**
 * 曲库存储后端的纯逻辑测试（文件后端的数据格式不变量）：
 *   - audio 键 → 文件名 → 回读 → File 名，一路可逆（迁移就是拷文件夹，编码错了就找不到音频）
 *   - align.json 的校验（坏条目跳过，不炸整库）
 *   - 曲库清单文档的校验口径与 localStorage 版一致
 */
import {
  alignMapFrom,
  audioFileOf,
  audioKey,
  audioNameOf,
  type AlignPersist,
} from '../src/v2/ui/alignStore';
import { isItem, mergeLibrary, sortLibrary, type LibraryItem } from '../src/v2/ui/libraryStore';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  XX  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

console.log('[存储后端 · 音频文件名编码]');
{
  // 键里的 `:` / 中文 / 空格在 Windows 上都是非法或麻烦字符，必须编码干净
  const keys = [
    audioKey({ name: '灰姑娘.mp3', size: 12345 }),
    audioKey({ name: 'a b(c)歌.v1.mp3', size: 1 }),
    audioKey({ name: '名字:带冒号.mp3', size: 0 }), // macOS 允许冒号，也得处理
  ];
  check(
    '编码后不含任何文件系统危险字符（只查文件名，audio/ 的斜杠不算）',
    keys.every((k) => {
      const base = audioFileOf(k).split('/').pop() ?? '';
      return !/[\\/:*?"<>|\s]/.test(base);
    }),
    keys.map(audioFileOf).join(' '),
  );
  check(
    '路径都收在 audio/ 下且可逆',
    keys.every((k) => decodeURIComponent(audioFileOf(k).slice('audio/'.length)) === k),
  );
  check('名字从键里还原（冒号分隔的末段是字节数）', audioNameOf(keys[0]!) === '灰姑娘.mp3');
  check(
    '名字本身带冒号时也不破（取最后一个冒号之前）',
    audioNameOf(keys[2]!) === '名字:带冒号.mp3',
    audioNameOf(keys[2]!),
  );
}

console.log('[存储后端 · align.json 校验]');
{
  const good: AlignPersist = {
    version: 1,
    audio: [{ key: 'a.mp3:12', name: 'a.mp3' }],
    tempoDraft: { bpm: 96, phaseSec: 0.2, originBeat: 1 },
    anchors: [],
    override: null,
    playSource: 'audio',
  };
  const map = alignMapFrom({
    灰姑娘: good,
    坏条目: { version: 2 },
    '更坏': 'not even an object',
    好的2: { ...good, audio: [] },
  });
  check('坏条目被跳过、好的收进', map.size === 2, `${map.size}`);
  check('非对象文档（null / 数组）给空表，不炸', alignMapFrom(null).size === 0 && alignMapFrom([1]).size === 0);
  check('undefined 同样给空表', alignMapFrom(undefined).size === 0);
}

console.log('[存储后端 · library.json 校验口径]');
{
  const item: LibraryItem = {
    id: 'lib-1',
    name: '灰姑娘',
    text: '@beat 4/4\n\n1 2 3 4 ||',
    updatedAt: 5,
    meta: { title: '灰姑娘', key: '1=C', beat: '4/4', bpm: 120, measures: 1, notes: 4, broken: false },
    favorite: true,
  };
  check('好条目通过校验', isItem(item));
  check('坏条目拦下（缺 text / 坏 meta）', !isItem({ ...item, text: 5 }) && !isItem({ ...item, meta: 'x' }));
  check('null / 非对象拦下', !isItem(null) && !isItem('x'));
  const sorted = sortLibrary([{ ...item, updatedAt: 1, name: '甲' }, { ...item, updatedAt: 2 }]);
  check('排序：新的在前', sorted[0]!.name === '灰姑娘' && sorted[1]!.name === '甲');
}

console.log('[存储后端 · 断连后合并]');
{
  const mk = (id: string, name: string, updatedAt: number): LibraryItem => ({
    id,
    name,
    text: `@beat 4/4\n\n1 2 3 4 ||`,
    updatedAt,
    meta: { title: name, key: '1=C', beat: '4/4', bpm: 120, measures: 1, notes: 4, broken: false },
  });
  // 场景：文件夹授权失效 → 那段时间导入的歌写进了 localStorage → 重连后要救回来
  const folder = [mk('a', '灰姑娘', 10), mk('b', '青花瓷', 20)];
  const local = [
    mk('b', '青花瓷', 20), // 两边都有且一样：不重复
    mk('c', '七里香', 30), // 只在本地（断连期间导入的）：要补进文件夹
    mk('a', '灰姑娘', 5), // 本地更旧：不动文件夹里的
  ];
  const { merged, added } = mergeLibrary(folder, local);
  check('合并后恰好多出一首', added === 1, `${added}`);
  check('合并后共三首、顺序仍按新到旧', merged.length === 3 && merged[0]!.name === '七里香');
  check('两边都有时保留更新的', merged.find((it) => it.id === 'a')!.updatedAt === 10);
  check('本地是文件夹的子集时不写盘（added = 0）', mergeLibrary(folder, [mk('b', '青花瓷', 20)]).added === 0);
  check('本地更旧不会倒退', mergeLibrary([mk('a', '灰姑娘', 10)], [mk('a', '灰姑娘', 5)]).merged[0]!.updatedAt === 10);
}

console.log(failed === 0 ? '\n存储后端测试全部通过' : `\n存储后端测试失败 ${failed} 项`);
if (failed > 0) process.exit(1);
