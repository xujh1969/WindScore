/**
 * 汉字 → 拼音首字母（动态谱首页右侧 A/B/C… 索引用）。
 *
 * 做法：**不查表，用 Intl 的拼音排序去探测**。给每个字母找一个已知首字母的
 * 探针字（阿=ā、八=bā、擦=cā…），按字母序问排序器「这个探针字排在这个字
 * 前面吗」，走到哪一位就是它的首字母。零数据、覆盖所有汉字——手写表一定有洞
 * （「茉莉花」的茉、莉就不在表里）。
 *
 * 多音字取**常见读音**（长→C、行→X、重→Z），只影响分组标签，不影响搜索与播放。
 * 环境不支持拼音排序（很老的 Safari）时返回 null，调用方归到 `#`。
 */

/** 每个字母一个探针字：顺序必须与 LETTERS 一致（I/U/V 没有常用首字，跳过） */
const PROBE_CHARS = '阿八擦搭蛾发该哈击卡垃妈拿欧趴七然撒他蛙西压匝';
const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';

const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'variant' });
/** 这个环境真的支持 -u-co-pinyin 吗（不支持会静默退回笔画序，那比没有还糟） */
const PINYIN_OK = /pinyin/i.test(collator.resolvedOptions().locale);

/** 汉字的拼音首字母；非汉字或环境不支持时返回 null */
export function pinyinInitial(ch: string): string | null {
  if (!PINYIN_OK) return null;
  // 假名 / 谚文排在汉字之后，不挡掉的话会一路走到最后一个字母
  if (!/\p{Script=Han}/u.test(ch)) return null;
  let hit = '#';
  for (let i = 0; i < PROBE_CHARS.length; i += 1) {
    if (collator.compare(PROBE_CHARS[i]!, ch) > 0) break;
    hit = LETTERS[i]!;
  }
  return hit;
}

/** 单个字符的首字母标签：拉丁字母取大写，数字与无法判定归 `#` */
export function initialOfChar(ch: string): string {
  const c = ch.trim();
  if (!c) return '#';
  if (/[A-Za-z]/.test(c)) return c.toUpperCase();
  if (/[0-9]/.test(c)) return '#';
  return pinyinInitial(c) ?? '#';
}

/** 名字的首字母标签（取第一个「有意义」的字符：忽略空格与标点） */
export function initialOfName(name: string): string {
  for (const ch of name.trim()) {
    if (/[\s·・.、,，'"“”‘’\-_()（）]/.test(ch)) continue;
    return initialOfChar(ch);
  }
  return '#';
}