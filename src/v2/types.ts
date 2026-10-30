/**
 * WindScore v2 内核类型（M0-1）
 * 与 windscore-v2-spec.md §5 完全一致：
 *   扁平事件流 + 结构标记 + 独立的 BeatGroup 表
 *
 * 约定：本文件及 v2 内核其余模块不得 import 任何 Canvas / DOM API。
 */

export type Degree = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/**
 * 变音记号（GB/T 46845—2025 §6.2.5.1 共五种）：♯ 升、× 重升、♭ 降、♭♭ 重降、♮ 还原。
 * ♮ 是显式写出来的还原号，用来抵消调号自带的升降；重升 / 重降在升号多 / 降号多的调里出现。
 * DSL 写法：重升 `##`、重降 `bb`（如 `##4`、`bb3`）。
 */
export type Accidental = '#' | 'x' | 'b' | 'bb' | '♮';
export type Articulation = 'staccato' | 'tenuto' | 'accent' | 'marcato';
export type OrnamentKind = 'trill' | 'mordent' | 'turn' | 'appoggiatura';

export interface BaseEvent {
  id: string;
  /**
   * 展开产物的血缘：这个事件是从原谱哪个事件复制来的。
   * **只出现在 expandScore() 的输出里**，原谱事件不带它。
   * 用途：播放到第二遍反复时，光标/高亮要落回原谱那同一个音上；
   * 点击展开谱的音也要能定位回原谱（见 expand.ts）。
   */
  originId?: string;
}

/** tie = 延音线（同音高，播放时合并）；slur = 圆滑线（不吐音）。两者必须分开存（§5.2） */
export interface Tie {
  to: string;
  kind: 'tie' | 'slur';
}

export interface Ornament {
  kind: OrnamentKind;
  /** 倚音的装饰音组原始写法，仅 appoggiatura 使用 */
  notes?: string;
}

/**
 * 倚音（装饰音）：**不占时值**，挂在主音上，播放时从主音时值里切一小段。
 *
 * 不占时值是关键设计：小节拍数校验、拍内组、连音线、复制粘贴全都不用为它开豁免；
 * 移动主音、复制主音时倚音自动跟随（它们在同一条事件里）。
 * 单倚音 / 复倚音只是音数差别（1 个 vs 2 个以上），不需要单独建模。
 */
export interface GraceNote {
  degree: Degree;
  octave: number;
  accidental?: Accidental;
}

export interface NoteEvent extends BaseEvent {
  kind: 'note';
  degree: Degree;
  /** 0 = 中音，+1 = 高八度（^），-1 = 低八度（v） */
  octave: number;
  accidental?: Accidental;
  ticks: number;
  groupId?: string;
  /** 附点数，仅用于复现原始写法；时值已含在 ticks 内 */
  dot?: 0 | 1 | 2;
  /** 转调：演奏到此音起，后面的音都改用这个调（如 "1=G"）。DSL 写作 `转1=G` */
  keyChange?: string;
  /** 前倚音（DSL 写作 `{65}3`），靠主音的那颗排在最后 */
  graceBefore?: GraceNote[];
  /** 后倚音（DSL 写作 `3{65}`），靠主音的那颗排在最前 */
  graceAfter?: GraceNote[];
  ties?: Tie[];
  articulations?: Articulation[];
  ornaments?: Ornament[];
  fermata?: boolean;
  /**
   * 吐音标记：T = 单吐（DSL 写 5t），K = 双吐的第二个音（DSL 写 5k）。
   * 双吐 / 三吐 / 快速双吐都是 T 与 K 在连续音符上的组合，不需要单独建模。
   */
  tongue?: 'T' | 'K';
  /**
   * 电吹管技法记号，可多选，画在音符上方横向排列。
   * 取值见 paint.ts 的 TECHNIQUE_GLYPH 表：花舌 / 打音 / 上下波音 / 上下滑音 / 前后弯音。
   * 倚音（单倚 / 复倚音）不在其中——它是不占时值的小音符，要另建结构。
   */
  techniques?: string[];
  /**
   * 自定义记号：用户在「气息与技法」里随手打的最多 3 个汉字 / 符号，
   * 原样画在音符上方（DSL 写 5[滑]）。空 = 没有。
   */
  mark?: string;
  /**
   * 力度，跟音符绑定、画在音符下方：pp p mp mf f ff。
   * 与「渐强 / 渐弱」(hairpin) 互相独立，一个音可以既有力度又有渐变。
   */
  dynamic?: string;
  /** 渐强 / 渐弱记号（〈 >），画在音符下方力度记号旁边 */
  hairpin?: 'cresc' | 'dim';
  /** 渐强/渐弱的终音；缺省仍是原有单音记号。 */
  hairpinTo?: string;
  /** 逐音歌词，每个数组位置对应一段歌词；空串表示该段此音不唱字。 */
  lyrics?: string[];
  /** 与 lyrics 相同段号；延唱标在后续空格，连字标在前一音节。 */
  lyricLinks?: (LyricLink | null)[];
  /** 单音音色覆盖，MIDI program 0-127 */
  patch?: number;
  /**
   * 指法（GB/T 46845—2025 §7.11.5）：'0'=空弦，'1'–'5' 按手指序。
   * 画在音符下方的小字。单字符——同音换指的并列弧线记法暂不支持。
   */
  fingering?: string;
  /**
   * 高 / 低八度演奏段（GB/T 46845—2025 §6.2.6）的**起点**：从此音起整体升 / 降八度，
   * 到 octavaTo 指向的音为止（含两端）。DSL 写 `8va[ … ]8` / `8vb[ … ]8`。
   * con-va / con-vb = 八度重复（con 8，DSL 写 `con8[` / `con8b[`）：段内音高不变，
   * 除原声外再叠一份高 / 低八度同响。结构与 hairpin/hairpinTo 相同。
   */
  octava?: 'va' | 'vb' | 'con-va' | 'con-vb';
  /** 八度段的终音 id */
  octavaTo?: string;
  /**
   * 颤音波线的**终点音**标记（DSL 后缀 `R`）：选区套用颤音时 tr 标在首音上，
   * 波浪线从 tr 右侧连续拉到本音（选区末音）的尾部（GB/T 46845—2025 §7.5.3）。
   * 单音颤音不用它——带增时线的音波线与延音线等长，无增时线只标 tr。
   */
  trillEnd?: boolean;
  /**
   * 琶音（GB/T 46845—2025 §7.7）：音符左侧的波状竖线。
   * 单声部简谱里它只是记谱标记（没有同时发声的和弦可滚）；
   * 重奏和弦的逐音延迟起音待后续。
   */
  arpeggio?: boolean;
  /**
   * 震音（GB/T 46845—2025 §7.8）：音符右上的 1–3 条斜线。
   * 播放时把该音均分成 2^n 等份快速重复（1 条 = 八分的重复，2 条 = 十六分…）。
   */
  tremolo?: 1 | 2 | 3;
  /**
   * 灰显（DSL 后缀 `g`）：画成灰色，提示这段是前奏 / 间奏，不用吹奏。
   * 纯视觉标记——播放、时值、小节拍数校验都不受影响。
   */
  gray?: boolean;
}

export type LyricLink = 'extend' | 'hyphen';

export interface RestEvent extends BaseEvent {
  kind: 'rest';
  ticks: number;
  /**
   * 多小节休止（GB/T 46845—2025 §6.3.7.3）的**首格**：N ≥ 2 表示这个休止共占 N 小节。
   * DSL 写 `0*8`；解析时展开成 N 个逐小节休止 + N−1 根隐藏小节线（拍数校验天然通过），
   * 序列化时合并回 `0*N`，谱面画成一条粗横线加数字。
   */
  multibar?: number;
  /** 多小节休止的后续格（第 2…N 格），配合 multibar 首格画连续横线 */
  multibarCont?: boolean;
  /**
   * 小节反复号（GB/T 46845—2025 §5.8.4，DSL 写 `%`）：整小节重复**上一小节**的内容。
   * 时值恒为一整个小节；播放时展开为上一小节的拷贝，谱面画 𝄍（两条斜线加两点）。
   */
  repeatBar?: boolean;
  /** 附点：休止符与音符一样可带 1–2 个附点 */
  dot?: 0 | 1 | 2;
  groupId?: string;
  /** 隐藏休止（DSL `8`）：占位但不画字形，用于行中混排前的空拍占位 */
  hidden?: boolean;
  /**
   * X 符号（无音高音符）：画 X 不画 0，发声为一记打击声（木鱼音色），
   * 没有固定音高——打击、拍手、念节奏用。时值 / 附点 / 增减时线与休止符一致。
   */
  x?: boolean;
  /** 灰显（DSL 后缀 `g`）：同音符，前奏 / 间奏里的休止也可以灰 */
  gray?: boolean;
}

/**
 * 小节线。**反复记号是它的属性，不是独立事件**：
 * `|:`、`:|`、跳房子都画在这一根线上，所以谱面上永远不会多出一条线。
 * （早期把它们做成独立事件，插入时就会在原有小节线旁边再长一条 `| |:`，
 *   而且「点这条线改它」也无从下手。）
 */
export interface BarlineEvent extends BaseEvent {
  kind: 'barline';
  /** single = 单细线；double = 双细线（乐段结束）；final = 细线+粗线（全曲终止） */
  style: 'single' | 'double' | 'final';
  /** 从这条小节线之后起使用的新拍号。 */
  beatAfter?: string;
  /**
   * 从这条小节线之后起的新速度（BPM，20-300）：**只影响合成音**的拍长与节拍器
   * （DSL 写「速96」，UI 在小节线面板里改）；伴奏模式跟对轨标定走，完全不看它。
   */
  bpmAfter?: number;
  /**
   * 从这条小节线之后起本声部的新音色（音色号，0-255，扩展号 128-255 给
   * 自定义音色包；DSL 写「音5」）。只改发声，不动谱面记谱。
   */
  patchAfter?: number;
  /** 此小节线后强制换行，page 同时要求 PDF 换页。 */
  breakAfter?: 'line' | 'page';
  /** 弱起 / 不完全小节开关（§8.2） */
  partial?: boolean;
  /** `|:` 反复开始 / `:|` 反复结束 / `:||:` 双向反复（既是上一段的结束又是下一段的开始） */
  repeat?: 'start' | 'end' | 'both';
  /** `:|` 的演奏遍数，缺省 2（`:|3` = 三遍） */
  times?: number;
  /**
   * 跳房子：从这一根线起，后面这一房属于第几遍（如 `[1]`、`[2]`、`[1,2]`）。
   * 房的范围 = 本线 → 下一条带 volta 的线（或所在反复段的那根 `:|`）。
   */
  volta?: number[];
  /**
   * 房子**右端开放**（DSL 写不闭合的 `[1`）：括线只有左钩、横线拉到收口处
   * 但不画右钩。简谱惯例：房子跨很多小节 / 跨行时右端开放
   * （「一直演奏直到 :|」），只有两三个小节的短房才画右钩。缺省闭合。
   */
  voltaOpen?: boolean;
  /** 隐藏小节线（DSL `|*`）：保留占位宽度、小节计数照常，但不画线 */
  hidden?: boolean;
  /**
   * 多小节休止的**结构化**隐藏小节线：由 `0*N` / 多小节休止插入生成，
   * 是休止格之间的分隔（不是用户写的 `|*`）。编辑后剩余格数重算时，
   * 没了左右休止格的这种线会被安全清掉——用户手写的 `|*` 永远不动。
   */
  multibarDiv?: boolean;
  /**
   * 虚小节线（GB/T 46845—2025 §5.2.2，DSL `|~`）：画成虚线。
   * 混合拍子里「按节拍分组、但不拦拍感」的细分线——
   * 占位、拦小节、计数、校验全部与实线一致，只是字形不同。
   */
  dashed?: boolean;
  /**
   * 散板 / 自由拍子（GB/T 46845—2025 §6.3.11.7，DSL 写「散」紧接小节线）：
   * 从这条线之后起进入散板段落——拍号位置记「散」，
   * 段内小节不做拍数校验（散板按词组自由延展，不满 / 超满是常态）。
   * 直到某根线写「拍N/M」声明新拍号才退出。
   */
  free?: boolean;
}

export type JumpMark = 'segno' | 'coda' | 'fine' | 'dc' | 'ds' | 'tocoda';

export interface JumpEvent extends BaseEvent {
  kind: 'jump';
  mark: JumpMark;
}

export interface DirectiveEvent extends BaseEvent {
  kind: 'directive';
  /**
   * text = 段落标注（(前奏)）；**paren = 左右括号记号**——
   * 画在音符左右两侧、与音符同一行，用来把一段（可跨行）音符夹在括号里，
   * 如 (6 2 2)：头一个音前放左括号、末一个音后放右括号
   */
  type: 'tempo' | 'dynamic' | 'patch' | 'text' | 'paren';
  value: string;
}

/**
 * 事件类型。**换气没有独立事件**：早期版本的 `'` 记号已从规范里删除，
 * 换气是音符的技法（后缀 `V`，见 NoteEvent.techniques），跟着音符走。
 */
export type Event =
  | NoteEvent
  | RestEvent
  | BarlineEvent
  | JumpEvent
  | DirectiveEvent;

export type TimedEvent = NoteEvent | RestEvent;

/**
 * 拍内组（§5.3）
 * 不变量见 validate.ts：
 *   I1  Σ member.ticks === totalTicks
 *   I2  totalTicks ≤ TICKS_PER_BEAT
 *   I3  memberIds 在 events 中连续（中间只允许 breath）
 *   I4  totalTicks 与成员 tick 都落在合法 tick 粒度
 */
export interface BeatGroup {
  id: string;
  /** 自动生成的普通拍组，编辑时可重新推导。 */
  auto?: boolean;
  /** 守恒量 */
  totalTicks: number;
  /** 顺序即谱面顺序 */
  memberIds: string[];
  /** 连音符标号，如 3；仅在真正连音时设置 */
  tuplet?: number;
}

export interface ScoreMeta {
  title: string;
  /** 记谱调，如 "1=G" */
  key: string;
  /** 如 "4/4" */
  beat: string;
  bpm: number;
  /** 全局默认音色，MIDI program 0-127（0 = 钢琴） */
  patch: number;
  /** 仅显示用，如 "Flute" */
  patchName?: string;
  /**
   * 音色的**八度偏移**：乐器音区不合适（太低发闷 / 太高失真）时整体挪八度，
   * 只改发声、不改谱面记谱。±1 = 升 / 降一个八度，建议 ±2 以内。
   */
  patchOctave?: number;
  /**
   * 标题下的居中说明行（DSL `@sub`），如「锣钹C20 管弦乐三重奏技法谱」。
   * 缺省（未写过）不显示、不回写
   */
  sub?: string;
  /**
   * 谱头右侧的说明行（DSL `@note`，最多 4 行，右对齐），
   * 如「流行小号(*和声常开)」「程序员老许制谱」。缺省不显示、不回写
   */
  notes?: string[];
  /**
   * 谱面字号（px），缺省见 DEFAULT_FONT_SIZE。数字 / 附点 / 增时线 / 倚音的整体大小随它缩放，
   * 行高与命中测试一起缩——三处（排版 / 绘制 / 命中）必须同源，见 layout.deriveGlyph。
   */
  fontSize?: number;
  /** 字间距（px），缺省见 DEFAULT_LETTER_SPACING。加在每个记号占位的横向空隙上，正数拉开、负数收紧 */
  letterSpacing?: number;
  /**
   * 行间距增量（px，按字号比例缩放）：行高的额外增加量，0 = 默认紧凑行距。
   * 写进 DSL `@lineGap`；正数拉开行与行的距离（留白 / 歌词空间不够时用）
   */
  lineGap?: number;
  /**
   * 小节线下方是否画小节号（`@measureNo off` 关掉）。缺省 true——
   * 只有用户明确关掉时才写进文件，老文件保持原样
   */
  showMeasureNumbers?: boolean;
}

/** 新建谱面的默认字号（px）——用户 2026-10-23 定：24 */
export const DEFAULT_FONT_SIZE = 24;
/** 新建谱面的默认字间距（px），与默认字号配套 */
export const DEFAULT_LETTER_SPACING = -10;

export interface Score {
  version: 2;
  meta: ScoreMeta;
  /** 唯一真源，线性有序 */
  events: Event[];
  groups: BeatGroup[];
  /** JPS 文本语法版本；缺省是旧版，不能改变旧谱的默认时值。 */
  format?: 3;
  /** events/groups 是第一声部，parts 只保存其余声部，避免重复真源。 */
  part?: PartInfo;
  parts?: ScorePart[];
}

export interface PartInfo {
  id: string;
  name: string;
  gain: number;
  muted?: boolean;
  solo?: boolean;
  /** 此声部的合成音色（GM patch 号）；缺省跟随曲目音色 meta.patch。 */
  patch?: number;
  /**
   * 此声部音色的**八度偏移**（±1 = 升 / 降一个八度）：
   * 乐器音区不合适时整体挪八度，避免音色失真；缺省跟随 meta.patchOctave。
   */
  patchOctave?: number;
  /** 关联此演奏声部的歌词行名称；数组位置与音符 lyrics 段号一致。 */
  lyricNames?: string[];
  /** 只决定五线谱的书写音高，不改变已有简谱的实际发声音高。 */
  staffInstrument?: import('./pitch').StaffInstrument;
  staffClef?: import('./pitch').StaffClefSetting;
}

export interface ScorePart extends PartInfo {
  events: Event[];
  groups: BeatGroup[];
}

export function isTimed(e: Event): e is TimedEvent {
  return e.kind === 'note' || e.kind === 'rest';
}

