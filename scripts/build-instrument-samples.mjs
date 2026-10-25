// 真采样抽取管线（gleitz/midi-js-soundfonts 的预渲染逐音 MP3）：
//   → 逐音解码降混 → 可用音区扫描（静音音剔除）
//   → 每 2-3 半音选一个采样点 → 起音对齐 → 循环段检测（包络自相关找颤音/震音周期，
//     电平对齐稳态平台，避免偏向衰减尾部）
//   → 循环段自身交叉淡化（平铺无缝）→ 循环段电平整形（颤音深谷收拢，
//     长音平铺后不再周期性「断一下」）→ 拼接编码单件 MP3 + 清单 JSON
//
// 两种产出：
//   ① 默认：public/instrument-samples/{patch}.mp3 + .json（内置音色，打进程序包）
//   ② --bank=名字：额外（或只）打成 .wsbank 音色包，与程序本体分离、用户按需导入
//
// 许可（务必跟着产出走）：
//   FluidR3_GM  → CC BY 3.0（Frank Wen）；可内置
//   MusyngKite  → CC BY-SA 3.0（1.75GB 源音源，音质明显更好）；
//                 有传染性共享条款，**只做成独立的音色包，不并进主程序**
//
// 用法：
//   node scripts/build-instrument-samples.mjs
//   node scripts/build-instrument-samples.mjs --src=MusyngKite --bank=WindScore-高保真音色包
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import decode from 'audio-decode';
import { Mp3Encoder } from '@breezystack/lamejs';

/** store（不压缩）模式的 zip 打包：与 src/v2/pack.ts 的 zipStore 同算法，
 *  这里复制一份是因为 node 脚本没法直接 import .ts。 */
function crc32(bytes) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const when = new Date();
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() / 2)) & 0xffff;
  const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, Buffer.from(e.data));
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBytes]));
    offset += local.length + nameBytes.length + e.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBuf, eocd]));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** 命令行：--src=FluidR3_GM|MusyngKite、--bank=包名字、--only-bank（不打内置） */
const ARG = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(k.length + 3);
const SRC_NAME = ARG('src') || 'FluidR3_GM';
const BANK_NAME = ARG('bank') || '';
const ONLY_BANK = process.argv.includes('--only-bank');
/** --per-instrument：每件乐器单独出一个 .wsbank（用户按需挑着导入，而不是整包全收） */
const PER_INSTRUMENT = process.argv.includes('--per-instrument');
/** --out=相对路径：包的输出目录（相对项目根），默认 artifacts/releases */
const OUT_REL = ARG('out') || 'artifacts/releases';
/**
 * --patches=0-63 / --patches=0,21,40：只抽这些 GM 号（128 件分批跑用，免得单次跑太久）。
 * 支持逗号分隔的单号与 a-b 区间混写。
 */
const PATCH_FILTER = ARG('patches')
  ? ARG('patches').split(',').flatMap((s) => {
      const [a, b] = s.split('-').map(Number);
      return Number.isFinite(b) ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
    })
  : null;
const SRC_LICENSE = SRC_NAME === 'MusyngKite'
  ? 'Musyng Kite soundfont (CC BY-SA 3.0)，经 gleitz/midi-js-soundfonts 预渲染'
  : 'FluidR3_GM (c) Frank Wen, CC BY 3.0，经 gleitz/midi-js-soundfonts 预渲染';

const SRC_DIR = join(ROOT, '.tmp-sf2');
const OUT_DIR = join(ROOT, 'public/instrument-samples');
const SR = 44100;
const KBPS = 96;
/** 采样点间隔（半音）：每 2 个半音一个点（管弦乐音色随音高变化平缓，够用） */
const STRIDE = 2;
/** 静音判定：整段峰值低于此视为该键无采样 */
const SILENCE_PEAK = 0.005;
/** 循环段目标长度（秒）：包络自相关会取它的整数倍周期。留够长才装得下颤音 / 簧片起伏 */
const LOOP_TARGET = 1;
/** 循环段两侧交叉淡化（秒）：循环段与自身拼接处等功率淡化 */
const XFADE = 0.02;
/** 起音前的保留余量（秒）：别把起音瞬态削掉 */
const ATTACK_GUARD = 0.01;
/** 每个采样点的归一目标峰值：与钢琴合成渲染的输出量级一致（混音不跳变） */
const TARGET_PEAK = 0.35;
/**
 * MP3 编解码的**固定延迟**（样本）：编码 → 解码后整个信号会被推后这么多，
 * 末尾还会多出一段填充。清单里的偏移是按源 PCM 算的，必须加上它才能对上解码后的数据。
 * 不补的后果：每个采样点的「起音」实际读到的是上一个点稳态段的尾巴（另一个音高），
 * 听起来是每个音前面先「咚 / 铛」一下（用户实测 0.2.183）。
 * 经典值是 1105（576 编码 + 529 解码），但 lamejs 版本 / 参数都可能变，
 * 所以**每次构建实测一次**（见 measureMp3Delay），不写死。
 */
let MP3_DELAY = 0;

const INSTRUMENTS = [
  { patch: 0, file: 'acoustic_grand_piano-mp3.js', name: 'acoustic_grand_piano', label: '三角钢琴' },
  { patch: 1, file: 'bright_acoustic_piano-mp3.js', name: 'bright_acoustic_piano', label: '亮音钢琴' },
  { patch: 2, file: 'electric_grand_piano-mp3.js', name: 'electric_grand_piano', label: '三角电钢琴' },
  { patch: 3, file: 'honkytonk_piano-mp3.js', name: 'honkytonk_piano', label: '酒吧钢琴' },
  { patch: 4, file: 'electric_piano_1-mp3.js', name: 'electric_piano_1', label: '电钢琴1' },
  { patch: 5, file: 'electric_piano_2-mp3.js', name: 'electric_piano_2', label: '电钢琴2' },
  { patch: 6, file: 'harpsichord-mp3.js', name: 'harpsichord', label: '羽管键琴' },
  { patch: 7, file: 'clavinet-mp3.js', name: 'clavinet', label: '克拉维琴' },
  { patch: 8, file: 'celesta-mp3.js', name: 'celesta', label: '钢片琴' },
  { patch: 9, file: 'glockenspiel-mp3.js', name: 'glockenspiel', label: '钟琴' },
  { patch: 10, file: 'music_box-mp3.js', name: 'music_box', label: '八音盒' },
  { patch: 11, file: 'vibraphone-mp3.js', name: 'vibraphone', label: '颤音琴' },
  { patch: 12, file: 'marimba-mp3.js', name: 'marimba', label: '马林巴' },
  { patch: 13, file: 'xylophone-mp3.js', name: 'xylophone', label: '木琴' },
  { patch: 14, file: 'tubular_bells-mp3.js', name: 'tubular_bells', label: '管钟' },
  { patch: 15, file: 'dulcimer-mp3.js', name: 'dulcimer', label: '洋琴' },
  { patch: 16, file: 'drawbar_organ-mp3.js', name: 'drawbar_organ', label: '拉杆风琴' },
  { patch: 17, file: 'percussive_organ-mp3.js', name: 'percussive_organ', label: '敲击风琴' },
  { patch: 18, file: 'rock_organ-mp3.js', name: 'rock_organ', label: '摇滚风琴' },
  { patch: 19, file: 'church_organ-mp3.js', name: 'church_organ', label: '教堂风琴' },
  { patch: 20, file: 'reed_organ-mp3.js', name: 'reed_organ', label: '簧风琴' },
  { patch: 21, file: 'accordion-mp3.js', name: 'accordion', label: '手风琴' },
  { patch: 22, file: 'harmonica-mp3.js', name: 'harmonica', label: '口琴' },
  { patch: 23, file: 'tango_accordion-mp3.js', name: 'tango_accordion', label: '探戈手风琴' },
  { patch: 24, file: 'acoustic_guitar_nylon-mp3.js', name: 'acoustic_guitar_nylon', label: '尼龙弦吉他' },
  { patch: 25, file: 'acoustic_guitar_steel-mp3.js', name: 'acoustic_guitar_steel', label: '钢弦吉他' },
  { patch: 26, file: 'electric_guitar_jazz-mp3.js', name: 'electric_guitar_jazz', label: '爵士电吉他' },
  { patch: 27, file: 'electric_guitar_clean-mp3.js', name: 'electric_guitar_clean', label: '清音电吉他' },
  { patch: 28, file: 'electric_guitar_muted-mp3.js', name: 'electric_guitar_muted', label: '闷音电吉他' },
  { patch: 29, file: 'overdriven_guitar-mp3.js', name: 'overdriven_guitar', label: '过载吉他' },
  { patch: 30, file: 'distortion_guitar-mp3.js', name: 'distortion_guitar', label: '失真吉他' },
  { patch: 31, file: 'guitar_harmonics-mp3.js', name: 'guitar_harmonics', label: '吉他和声' },
  { patch: 32, file: 'acoustic_bass-mp3.js', name: 'acoustic_bass', label: '原声贝斯' },
  { patch: 33, file: 'electric_bass_finger-mp3.js', name: 'electric_bass_finger', label: '指弹贝斯' },
  { patch: 34, file: 'electric_bass_pick-mp3.js', name: 'electric_bass_pick', label: '拨片贝斯' },
  { patch: 35, file: 'fretless_bass-mp3.js', name: 'fretless_bass', label: '无品贝斯' },
  { patch: 36, file: 'slap_bass_1-mp3.js', name: 'slap_bass_1', label: '拍打贝斯1' },
  { patch: 37, file: 'slap_bass_2-mp3.js', name: 'slap_bass_2', label: '拍打贝斯2' },
  { patch: 38, file: 'synth_bass_1-mp3.js', name: 'synth_bass_1', label: '合成贝斯1' },
  { patch: 39, file: 'synth_bass_2-mp3.js', name: 'synth_bass_2', label: '合成贝斯2' },
  { patch: 40, file: 'violin-mp3.js', name: 'violin', label: '小提琴' },
  { patch: 41, file: 'viola-mp3.js', name: 'viola', label: '中提琴' },
  { patch: 42, file: 'cello-mp3.js', name: 'cello', label: '大提琴' },
  { patch: 43, file: 'contrabass-mp3.js', name: 'contrabass', label: '低音提琴' },
  { patch: 44, file: 'tremolo_strings-mp3.js', name: 'tremolo_strings', label: '颤音弦乐' },
  { patch: 45, file: 'pizzicato_strings-mp3.js', name: 'pizzicato_strings', label: '拨弦弦乐' },
  { patch: 46, file: 'orchestral_harp-mp3.js', name: 'orchestral_harp', label: '竖琴' },
  { patch: 47, file: 'timpani-mp3.js', name: 'timpani', label: '定音鼓' },
  { patch: 48, file: 'string_ensemble_1-mp3.js', name: 'string_ensemble_1', label: '弦乐合奏1' },
  { patch: 49, file: 'string_ensemble_2-mp3.js', name: 'string_ensemble_2', label: '弦乐合奏2' },
  { patch: 50, file: 'synth_strings_1-mp3.js', name: 'synth_strings_1', label: '合成弦乐1' },
  { patch: 51, file: 'synth_strings_2-mp3.js', name: 'synth_strings_2', label: '合成弦乐2' },
  { patch: 52, file: 'choir_aahs-mp3.js', name: 'choir_aahs', label: '人声合唱' },
  { patch: 53, file: 'voice_oohs-mp3.js', name: 'voice_oohs', label: '人声喔音' },
  { patch: 54, file: 'synth_choir-mp3.js', name: 'synth_choir', label: '合成人声' },
  { patch: 55, file: 'orchestra_hit-mp3.js', name: 'orchestra_hit', label: '乐队重击' },
  { patch: 56, file: 'trumpet-mp3.js', name: 'trumpet', label: '小号' },
  { patch: 57, file: 'trombone-mp3.js', name: 'trombone', label: '长号' },
  { patch: 58, file: 'tuba-mp3.js', name: 'tuba', label: '大号' },
  { patch: 59, file: 'muted_trumpet-mp3.js', name: 'muted_trumpet', label: '弱音小号' },
  { patch: 60, file: 'french_horn-mp3.js', name: 'french_horn', label: '圆号' },
  { patch: 61, file: 'brass_section-mp3.js', name: 'brass_section', label: '铜管合奏' },
  { patch: 62, file: 'synth_brass_1-mp3.js', name: 'synth_brass_1', label: '合成铜管1' },
  { patch: 63, file: 'synth_brass_2-mp3.js', name: 'synth_brass_2', label: '合成铜管2' },
  { patch: 64, file: 'soprano_sax-mp3.js', name: 'soprano_sax', label: '高音萨克斯' },
  { patch: 65, file: 'alto_sax-mp3.js', name: 'alto_sax', label: '中音萨克斯' },
  { patch: 66, file: 'tenor_sax-mp3.js', name: 'tenor_sax', label: '次中音萨克斯' },
  { patch: 67, file: 'baritone_sax-mp3.js', name: 'baritone_sax', label: '上低音萨克斯' },
  { patch: 68, file: 'oboe-mp3.js', name: 'oboe', label: '双簧管' },
  { patch: 69, file: 'english_horn-mp3.js', name: 'english_horn', label: '英国管' },
  { patch: 70, file: 'bassoon-mp3.js', name: 'bassoon', label: '大管' },
  { patch: 71, file: 'clarinet-mp3.js', name: 'clarinet', label: '单簧管' },
  { patch: 72, file: 'piccolo-mp3.js', name: 'piccolo', label: '短笛' },
  { patch: 73, file: 'flute-mp3.js', name: 'flute', label: '长笛' },
  { patch: 74, file: 'recorder-mp3.js', name: 'recorder', label: '竖笛' },
  { patch: 75, file: 'pan_flute-mp3.js', name: 'pan_flute', label: '排箫' },
  { patch: 76, file: 'blown_bottle-mp3.js', name: 'blown_bottle', label: '吹瓶声' },
  { patch: 77, file: 'shakuhachi-mp3.js', name: 'shakuhachi', label: '尺八' },
  { patch: 78, file: 'whistle-mp3.js', name: 'whistle', label: '口哨' },
  { patch: 79, file: 'ocarina-mp3.js', name: 'ocarina', label: '陶笛' },
  { patch: 80, file: 'lead_1_square-mp3.js', name: 'lead_1_square', label: '合成主音（方波）' },
  { patch: 81, file: 'lead_2_sawtooth-mp3.js', name: 'lead_2_sawtooth', label: '合成主音（锯齿）' },
  { patch: 82, file: 'lead_3_calliope-mp3.js', name: 'lead_3_calliope', label: '合成主音（汽笛）' },
  { patch: 83, file: 'lead_4_chiff-mp3.js', name: 'lead_4_chiff', label: '合成主音（箫声）' },
  { patch: 84, file: 'lead_5_charang-mp3.js', name: 'lead_5_charang', label: '合成主音（恰朗）' },
  { patch: 85, file: 'lead_6_voice-mp3.js', name: 'lead_6_voice', label: '合成主音（人声）' },
  { patch: 86, file: 'lead_7_fifths-mp3.js', name: 'lead_7_fifths', label: '合成主音（五度）' },
  { patch: 87, file: 'lead_8_bass__lead-mp3.js', name: 'lead_8_bass__lead', label: '合成主音（贝斯）' },
  { patch: 88, file: 'pad_1_new_age-mp3.js', name: 'pad_1_new_age', label: '合成铺底（新时代）' },
  { patch: 89, file: 'pad_2_warm-mp3.js', name: 'pad_2_warm', label: '合成铺底（温暖）' },
  { patch: 90, file: 'pad_3_polysynth-mp3.js', name: 'pad_3_polysynth', label: '合成铺底（复音）' },
  { patch: 91, file: 'pad_4_choir-mp3.js', name: 'pad_4_choir', label: '合成铺底（合唱）' },
  { patch: 92, file: 'pad_5_bowed-mp3.js', name: 'pad_5_bowed', label: '合成铺底（弓弦）' },
  { patch: 93, file: 'pad_6_metallic-mp3.js', name: 'pad_6_metallic', label: '合成铺底（金属）' },
  { patch: 94, file: 'pad_7_halo-mp3.js', name: 'pad_7_halo', label: '合成铺底（光晕）' },
  { patch: 95, file: 'pad_8_sweep-mp3.js', name: 'pad_8_sweep', label: '合成铺底（扫掠）' },
  { patch: 96, file: 'fx_1_rain-mp3.js', name: 'fx_1_rain', label: '合成效果（雨）' },
  { patch: 97, file: 'fx_2_soundtrack-mp3.js', name: 'fx_2_soundtrack', label: '合成效果（配乐）' },
  { patch: 98, file: 'fx_3_crystal-mp3.js', name: 'fx_3_crystal', label: '合成效果（水晶）' },
  { patch: 99, file: 'fx_4_atmosphere-mp3.js', name: 'fx_4_atmosphere', label: '合成效果（大气）' },
  { patch: 100, file: 'fx_5_brightness-mp3.js', name: 'fx_5_brightness', label: '合成效果（明亮）' },
  { patch: 101, file: 'fx_6_goblins-mp3.js', name: 'fx_6_goblins', label: '合成效果（精灵）' },
  { patch: 102, file: 'fx_7_echoes-mp3.js', name: 'fx_7_echoes', label: '合成效果（回声）' },
  { patch: 103, file: 'fx_8_scifi-mp3.js', name: 'fx_8_scifi', label: '合成效果（科幻）' },
  { patch: 104, file: 'sitar-mp3.js', name: 'sitar', label: '西塔琴' },
  { patch: 105, file: 'banjo-mp3.js', name: 'banjo', label: '班卓琴' },
  { patch: 106, file: 'shamisen-mp3.js', name: 'shamisen', label: '三味线' },
  { patch: 107, file: 'koto-mp3.js', name: 'koto', label: '日本筝' },
  { patch: 108, file: 'kalimba-mp3.js', name: 'kalimba', label: '卡林巴' },
  { patch: 109, file: 'bagpipe-mp3.js', name: 'bagpipe', label: '风笛' },
  { patch: 110, file: 'fiddle-mp3.js', name: 'fiddle', label: '民间小提琴' },
  { patch: 111, file: 'shanai-mp3.js', name: 'shanai', label: '印度唢呐' },
  { patch: 112, file: 'tinkle_bell-mp3.js', name: 'tinkle_bell', label: '叮当铃' },
  { patch: 113, file: 'agogo-mp3.js', name: 'agogo', label: '阿哥哥铃' },
  { patch: 114, file: 'steel_drums-mp3.js', name: 'steel_drums', label: '钢鼓' },
  { patch: 115, file: 'woodblock-mp3.js', name: 'woodblock', label: '木鱼' },
  { patch: 116, file: 'taiko_drum-mp3.js', name: 'taiko_drum', label: '太鼓' },
  { patch: 117, file: 'melodic_tom-mp3.js', name: 'melodic_tom', label: '旋律鼓' },
  { patch: 118, file: 'synth_drum-mp3.js', name: 'synth_drum', label: '合成鼓' },
  { patch: 119, file: 'reverse_cymbal-mp3.js', name: 'reverse_cymbal', label: '反转镲' },
  { patch: 120, file: 'guitar_fret_noise-mp3.js', name: 'guitar_fret_noise', label: '品噪吉他' },
  { patch: 121, file: 'breath_noise-mp3.js', name: 'breath_noise', label: '呼吸声' },
  { patch: 122, file: 'seashore-mp3.js', name: 'seashore', label: '海浪' },
  { patch: 123, file: 'bird_tweet-mp3.js', name: 'bird_tweet', label: '鸟鸣' },
  { patch: 124, file: 'telephone_ring-mp3.js', name: 'telephone_ring', label: '电话铃' },
  { patch: 125, file: 'helicopter-mp3.js', name: 'helicopter', label: '直升机' },
  { patch: 126, file: 'applause-mp3.js', name: 'applause', label: '掌声' },
  { patch: 127, file: 'gunshot-mp3.js', name: 'gunshot', label: '枪声' },
];

/** 音名 → MIDI（A0=21 .. C8=108，与清单里的 midi 一致） */
const NOTE_RE = /^([A-G])(b?)(-?\d)$/;
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteToMidi(n) {
  const m = NOTE_RE.exec(n);
  if (!m) return -1;
  const semi = BASE[m[1]] + (m[2] ? -1 : 0);
  return (Number(m[3]) + 1) * 12 + semi;
}

/** 解析 midi-js 音色文件：{ noteName: base64 } */
function parseSoundfont(file) {
  const src = readFileSync(file, 'utf8');
  const out = {};
  const re = /"([A-G]b?-?\d)":\s*"data:audio\/mp3;base64,([A-Za-z0-9+/=]+)"/g;
  let s;
  while ((s = re.exec(src))) out[s[1]] = Buffer.from(s[2], 'base64');
  return out;
}

/** MP3 → 单声道 Float32Array @44100（audio-decode 出多声道就平均） */
async function decodeMono(bytes) {
  const buf = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // audio-decode v3 返回 { channelData: Float32Array[], sampleRate }（非标准 AudioBuffer）
  const chans = buf.channelData ?? [buf.getChannelData(0)];
  const n = chans[0].length;
  const out = new Float32Array(n);
  for (const d of chans) for (let i = 0; i < n; i++) out[i] += d[i] / chans.length;
  const rate = buf.sampleRate;
  if (rate !== SR) throw new Error(`意外的采样率 ${rate}`);
  return out;
}

/** 包络（每 5ms 一帧的 RMS） */
function envelope(x, frame = Math.round(SR * 0.005)) {
  const n = Math.floor(x.length / frame);
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) acc += x[i] * x[i];
    env[f] = Math.sqrt(acc / frame);
  }
  return env;
}

/**
 * 起音结束点：20ms 帧的 RMS 第一次达到「稳态水平 90%」的位置。
 * 不能用固定「起音后 0.25s」——长笛起音 0.54s、小提琴 0.35s，
 * 循环段落在起音斜坡上的话，平铺时每次重复都重新涨一次音量，
 * 听起来像风琴在抽气，音色全走样（用户实测 0.2.183）。
 */
function findSettle(x, onset) {
  const frame = Math.round(0.02 * SR);
  const n = Math.floor((x.length - onset) / frame);
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    for (let i = onset + f * frame; i < onset + (f + 1) * frame; i++) acc += x[i] * x[i];
    env[f] = Math.sqrt(acc / frame);
  }
  // 稳态水平：0.3s 之后的峰值（避开起音斜坡本身）
  let sustain = 0;
  for (let f = Math.round(0.3 / 0.02); f < n; f++) if (env[f] > sustain) sustain = env[f];
  if (sustain <= 0) return onset + Math.round(0.25 * SR);
  const thr = sustain * 0.9;
  for (let f = 0; f < n; f++) if (env[f] >= thr) return onset + f * frame;
  return onset + Math.round(0.25 * SR);
}

/**
 * 循环段检测：在 [searchFrom, searchTo] 里找一段长度 ≈ LOOP_TARGET 的窗口，
 * 窗口起点与终点的包络最接近（接缝最平），且窗口内包络起伏最小。
 * 颤音 / 震音乐器再把窗口长度对齐到包络主周期（自相关），平铺才不会抖。
 */
function findLoop(x, from, to) {
  const frame = Math.round(SR * 0.005);
  const env = envelope(x.subarray(from, to), frame);
  // 包络自相关找主周期（0.1s ~ 1.2s）：颤音 5-7Hz、震音/轮指 4-8Hz 都落在这个带
  let period = 0;
  {
    const minLag = Math.round(0.1 / 0.005);
    const maxLag = Math.min(env.length - 1, Math.round(1.2 / 0.005));
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      let e0 = 0;
      let e1 = 0;
      for (let i = 0; i + lag < env.length; i++) {
        acc += env[i] * env[i + lag];
        e0 += env[i] * env[i];
        e1 += env[i + lag] * env[i + lag];
      }
      const norm = acc / (Math.sqrt(e0 * e1) + 1e-9);
      if (norm > best) { best = norm; period = lag; }
    }
    // 周期性弱（平直包络）就不用对齐
    if (best < 0.5) period = 0;
  }
  // 候选窗口长度：目标长度的周期整数倍
  let loopFrames = Math.round(LOOP_TARGET / 0.005);
  if (period > 0) {
    const k = Math.max(1, Math.round(LOOP_TARGET / (period * 0.005)));
    loopFrames = period * k;
  }
  const loopLen = loopFrames * frame;
  // 电平参考：搜索窗开头（= 起音刚结束的稳态平台）的平均包络。
  // 只按「接缝平直」挑窗会偏往自然衰减的安静尾部——平铺后长音在起音段
  // 结束处塌下去一截再回不来。循环段的平均电平要贴住这个参考。
  let refEnv = 0;
  {
    const refFrames = Math.min(Math.round(0.3 / 0.005), env.length);
    for (let i = 0; i < refFrames; i++) refEnv += env[i];
    refEnv /= refFrames || 1;
  }
  let bestStart = from + Math.floor((to - from - loopLen) / 2);
  let bestScore = Infinity;
  const startMin = from;
  const startMax = to - loopLen;
  for (let st = startMin; st <= startMax; st += frame) {
    // 接缝平直度：窗口首尾各一个窗口长度的包络均差
    let seam = 0;
    let wmean = 0;
    const base = Math.floor((st - from) / frame);
    for (let i = 0; i < loopFrames; i++) {
      const a = env[base + i];
      const b = env[base + i + loopFrames];
      if (a === undefined || b === undefined) { seam = Infinity; break; }
      seam += Math.abs(a - b);
      wmean += a;
    }
    if (seam === Infinity) continue;
    wmean /= loopFrames;
    // 电平连续性罚项：循环段平均电平偏离稳态参考越多罚越重
    // （0.3×loopFrames 让 ~1dB 的偏离与 Typical 接缝差同一量级）
    const level = refEnv > 1e-6 ? Math.abs(Math.log(wmean / refEnv)) * 0.3 * loopFrames : 0;
    const score = seam + level;
    if (score < bestScore) { bestScore = score; bestStart = st; }
  }
  return { start: bestStart, end: bestStart + loopLen };
}

/** 给循环段做「与自身拼接」的交叉淡化：返回的 [loopStart, loopEnd) 平铺无缝 */
function makeSeamlessLoop(x, seg) {
  const xfade = Math.round(XFADE * SR);
  const len = seg.end - seg.start;
  const out = new Float32Array(len);
  out.set(x.subarray(seg.start, seg.end));
  // 尾部 xf 秒与「循环起点**之前** xf 秒」做等功率交叉：平铺时尾部淡入的
  // 正是 x[loopStart-xf..loopStart)，回卷落回 x[loopStart) 是自然衔接。
  // 不能拿「循环段自己的开头」当淡入素材——那样回卷后开头素材连放两遍，
  // 接缝处是 xf 秒的相位倒跳（长音每个循环周期响一次接缝杂音）。
  const pre = Math.max(0, seg.start - xfade);
  for (let i = 0; i < xfade; i++) {
    const t = i / xfade; // 0..1
    const wOut = Math.cos((t * Math.PI) / 2);   // 尾部淡出
    const wIn = Math.sin((t * Math.PI) / 2);    // 循环起点前的素材淡入
    out[len - xfade + i] = x[seg.start + len - xfade + i] * wOut + x[pre + i] * wIn;
  }
  return out;
}

/**
 * 循环段电平整形：把短时包络的起伏向段内平均水平收拢（增益曲线钳位）。
 * 簧片 / 风琴类采样自带很深的颤音起伏（实测手风琴循环段内 RMS 在 0.039~0.108
 * 之间摆，低谷只有均值的一半）——原曲里它只发生一次、随后自然衰减，听不出问题；
 * 平铺成长音后同样的深谷每个循环周期重复一次，听感就是「长音中间断一下、
 * 不稳定」（用户实测）。整形后长音是稳定的持续声。
 * 增益曲线按**循环回卷**平滑（端点相接），不会破坏接缝；钳位避免把谷底的
 * 噪声底过度抬起来。
 */
function steadyLoop(loopPcm) {
  const frame = Math.round(0.02 * SR);
  const n = Math.max(1, Math.floor(loopPcm.length / frame));
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) acc += loopPcm[i] * loopPcm[i];
    env[f] = Math.sqrt(acc / frame);
  }
  // 目标 = 包络中位数（比均值抗谷底偏置）
  const sorted = Float32Array.from(env).sort();
  const target = sorted[Math.floor(n / 2)] || 0;
  if (target <= 1e-5) return loopPcm;
  // ±80ms 的滑动平均让增益曲线本身平滑（环形——循环两端相接）
  const half = Math.round(0.08 / 0.02);
  const smooth = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    let cnt = 0;
    for (let d = -half; d <= half; d++) {
      const j = (f + d + n * 4) % n;
      acc += env[j];
      cnt += 1;
    }
    smooth[f] = acc / cnt;
  }
  const GAIN_MIN = 0.7;
  const GAIN_MAX = 1.6;
  const frameGain = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    frameGain[f] = Math.min(GAIN_MAX, Math.max(GAIN_MIN, target / (smooth[f] || target)));
  }
  const out = Float32Array.from(loopPcm);
  for (let f = 0; f < n; f++) {
    const g0 = frameGain[f];
    const g1 = frameGain[(f + 1) % n];
    for (let i = f * frame; i < (f + 1) * frame && i < out.length; i++) {
      const t = (i - f * frame) / frame;
      out[i] *= g0 + (g1 - g0) * t; // 帧内线性插值，避免增益台阶
    }
  }
  return out;
}

/** 起 3ms 余弦淡入，防咔哒 */
function fadeIn(x, sec = 0.003) {
  const n = Math.min(Math.round(sec * SR), x.length);
  for (let i = 0; i < n; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
}

/**
 * 实测 MP3 延迟：编码一段「首样本冲激 + 正弦」，解码后找冲激落点。
 * 比写死 1105 可靠——lamejs 换版本也能对上。
 */
async function measureMp3Delay() {
  const n = Math.round(SR * 0.5);
  const probe = new Float32Array(n);
  probe[0] = 1;
  for (let i = 2000; i < n; i++) probe[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const { mp3 } = encodeMp3([probe]);
  const buf = await decode(mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength));
  const out = buf.channelData?.[0] ?? buf.getChannelData(0);
  let idx = 0;
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i]);
    if (v > peak) { peak = v; idx = i; }
  }
  return idx;
}

// ── 编码：拼接 PCM → 单件 MP3 ─────────────────────────────────
function encodeMp3(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  const enc = new Mp3Encoder(1, SR, KBPS);
  const parts = [];
  const blockSize = 1152;
  const int16 = new Int16Array(blockSize);
  for (let i = 0; i < pcm.length; i += blockSize) {
    const n = Math.min(blockSize, pcm.length - i);
    for (let j = 0; j < n; j++) {
      const v = Math.max(-1, Math.min(1, pcm[i + j]));
      int16[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const d = enc.encodeBuffer(int16.subarray(0, n));
    if (d.length) parts.push(Buffer.from(d));
  }
  const end = enc.flush();
  if (end.length) parts.push(Buffer.from(end));
  return { mp3: Buffer.concat(parts), pcmLength: total };
}

// ── 主流程 ─────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
MP3_DELAY = await measureMp3Delay();
if (MP3_DELAY <= 0 || MP3_DELAY > SR) { console.error(`测出的 MP3 延迟不对：${MP3_DELAY}`); process.exit(1); }
console.log(`MP3 编解码延迟：${MP3_DELAY} 样本（${((MP3_DELAY / SR) * 1000).toFixed(1)}ms），清单偏移统一补上\n`);
console.log(`采样源：${SRC_NAME}（${SRC_LICENSE}）`);
const report = [];
/** 音色包条目：manifest + 各件 mp3 / json */
const bankInstruments = [];
const bankFiles = [];
/** 音色包输出目录（整包与单件包都落这里） */
const outDirBank = join(ROOT, OUT_REL);
mkdirSync(outDirBank, { recursive: true });
for (const inst of INSTRUMENTS) {
  // 分批跑：只处理 --patches 选中的号
  if (PATCH_FILTER && !PATCH_FILTER.includes(inst.patch)) continue;
  // 同一份源文件在不同音源目录下重名，MusyngKite 的下载加了 mk- 前缀
  const file = `${SRC_DIR}/${SRC_NAME === 'MusyngKite' ? `mk-${inst.file}` : inst.file}`;
  if (!existsSync(file)) { console.error(`缺源文件：${file}`); process.exit(1); }
  const notes = parseSoundfont(file);
  // 逐音解码 + 可用性扫描
  const avail = new Map(); // midi → Float32Array
  for (const [name, bytes] of Object.entries(notes)) {
    const midi = noteToMidi(name);
    if (midi < 0) continue;
    const pcm = await decodeMono(bytes);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    if (peak >= SILENCE_PEAK) avail.set(midi, pcm);
  }
  const midis = [...avail.keys()].sort((a, b) => a - b);
  if (!midis.length) { console.error(`${inst.label}：没有可用音区`); process.exit(1); }
  // 采样点选择：从最低可用音起每 STRIDE 半音一个点，最高可用音保底收进
  const points = [];
  let last = -99;
  for (const midi of midis) {
    if (midi - last >= STRIDE || midi === midis[midis.length - 1]) {
      points.push(midi);
      last = midi;
    }
  }
  // 逐点处理：起音对齐 → 循环检测 → 无缝循环段 → 响度归一 → 拼 PCM
  const chunks = [];
  const manifest = [];
  let cursor = 0;
  for (const midi of points) {
    const x = avail.get(midi);
    // 起音对齐：阈值取该音峰值的 1.5%（下限 0.002）——
    // 长笛 / 萨克斯的气息声、手风琴的簧片起振都很轻，固定阈值会把这层
    // 「音色身份证」切掉，只剩稳态段，听起来谁都不像谁（用户实测 0.2.183）
    let pk = 0;
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > pk) pk = v; }
    const thr = Math.max(0.002, pk * 0.015);
    let onset = 0;
    while (onset < x.length && Math.abs(x[onset]) < thr) onset++;
    onset = Math.max(0, onset - Math.round(ATTACK_GUARD * SR));
    // 搜索循环段的范围：起音**结束**（RMS 到稳态 90%）后 50ms，到结尾前 0.3s
    const searchFrom = Math.min(findSettle(x, onset) + Math.round(0.05 * SR), x.length - Math.round(0.8 * SR));
    const searchTo = x.length - Math.round(0.3 * SR);
    if (searchTo - searchFrom < Math.round(0.5 * SR)) {
      console.error(`${inst.label} midi${midi}：可搜索区间太短`);
      process.exit(1);
    }
    const loop = findLoop(x, searchFrom, searchTo);
    const loopPcm = steadyLoop(makeSeamlessLoop(x, loop));
    const attack = x.subarray(onset, loop.start);
    fadeIn(attack);
    // 响度归一：各采样点的峰值差很大（录音电平不一），统一到与钢琴合成一个量级，
    // 播放时不同音色 / 不同音之间不会忽大忽小。gain 记进清单，运行时直接乘
    let peak = 0;
    for (let i = 0; i < attack.length; i++) { const v = Math.abs(attack[i]); if (v > peak) peak = v; }
    for (let i = 0; i < loopPcm.length; i++) { const v = Math.abs(loopPcm[i]); if (v > peak) peak = v; }
    const norm = peak > 1e-4 ? TARGET_PEAK / peak : 1;
    const attackStart = cursor;
    chunks.push(Float32Array.from(attack, (v) => v * norm));   // 起音段（含 guard，已归一）
    const loopStart = cursor + attack.length;
    chunks.push(Float32Array.from(loopPcm, (v) => v * norm));  // 循环段（已无缝化，已归一）
    cursor += attack.length + loopPcm.length;
    manifest.push({
      midi,
      // 偏移换算到**解码域**：解码后的数据整体比源 PCM 晚 MP3_DELAY 个样本
      start: attackStart + MP3_DELAY,
      loopStart: loopStart + MP3_DELAY,
      loopEnd: cursor + MP3_DELAY,
      length: cursor - attackStart,
      gain: Number(norm.toFixed(4)),
    });
  }
  const { mp3, pcmLength } = encodeMp3(chunks);
  if (pcmLength !== cursor) { console.error('PCM 长度对不上'); process.exit(1); }
  const json = {
    name: inst.name,
    label: inst.label,
    patch: inst.patch,
    sampleRate: SR,
    license: SRC_LICENSE,
    points: manifest,
  };
  const jsonText = JSON.stringify(json);
  if (!ONLY_BANK) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${inst.patch}.mp3`, mp3);
    writeFileSync(`${OUT_DIR}/${inst.patch}.json`, jsonText);
  }
  if (BANK_NAME) {
    const mp3Name = `${inst.patch}.mp3`;
    const jsonName = `${inst.patch}.json`;
    const instLabel = `${inst.label}（${SRC_NAME}）`;
    /** 单乐器包：manifest.name 短一点，曲库 chip 和音色下拉的来源标注都用它 */
    const instBankName = `${SRC_NAME}·${inst.label}`;
    const bankManifest = {
      kind: 'windscore-soundbank',
      version: 1,
      name: BANK_NAME,
      license: SRC_LICENSE,
      instruments: [{ patch: inst.patch, label: instLabel, mp3: mp3Name, json: jsonName }],
    };
    if (PER_INSTRUMENT) {
      // 一包一件：文件名 = 包名-乐器名，manifest.name 只写乐器（chip / 来源标注短）
      const bytes = zipStore([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...bankManifest, name: instBankName }), 'utf8') },
        { name: mp3Name, data: new Uint8Array(mp3) },
        { name: jsonName, data: Buffer.from(jsonText, 'utf8') },
      ]);
      const out = join(outDirBank, `${BANK_NAME}-${inst.label}.wsbank`);
      writeFileSync(out, bytes);
      console.log(`音色包：${out}（${(bytes.length / 1024 / 1024).toFixed(2)}MB，1 件音色）`);
    } else {
      bankFiles.push({ name: mp3Name, data: new Uint8Array(mp3) }, { name: jsonName, data: Buffer.from(jsonText, 'utf8') });
      bankInstruments.push({ patch: inst.patch, label: instLabel, mp3: mp3Name, json: jsonName });
    }
  }
  const usable = `${midis[0]}~${midis[midis.length - 1]}`;
  report.push(`${inst.label} (patch ${inst.patch})：可用音区 ${usable}（${midis.length} 音），采样点 ${points.length}，MP3 ${(mp3.length / 1024).toFixed(0)}KB`);
}
console.log(report.join('\n'));

if (BANK_NAME && !PER_INSTRUMENT) {
  const manifest = {
    kind: 'windscore-soundbank',
    version: 1,
    name: BANK_NAME,
    license: SRC_LICENSE,
    instruments: bankInstruments,
  };
  const bytes = zipStore([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...bankFiles,
  ]);
  const out = join(outDirBank, `${BANK_NAME}.wsbank`);
  writeFileSync(out, bytes);
  console.log(`\n音色包：${out}（${(bytes.length / 1024 / 1024).toFixed(2)}MB，${bankInstruments.length} 件音色）`);
}
