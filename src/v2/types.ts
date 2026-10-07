/**
 * WindScore v2 内核类型（M0-1）
 * 与 windscore-v2-spec.md §5 完全一致：
 *   扁平事件流 + 结构标记 + 独立的 BeatGroup 表
 *
 * 约定：本文件及 v2 内核其余模块不得 import 任何 Canvas / DOM API。
 */

export const TICKS_PER_BEAT = 48;

export type Degree = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/**
 * 变音记号：♯ 升、♭ 降、♮ 还原。
 * ♮ 是显式写出来的还原号，用来抵消调号自带的升降。
 */
export type Accidental = '#' | 'b' | '♮';
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
   * 力度，跟音符绑定、画在音符下方：pp p mp mf f ff。
   * 与「渐强 / 渐弱」(hairpin) 互相独立，一个音可以既有力度又有渐变。
   */
  dynamic?: string;
  /** 渐强 / 渐弱记号（〈 >），画在音符下方力度记号旁边 */
  hairpin?: 'cresc' | 'dim';
  /** 单音音色覆盖，MIDI program 0-127 */
  patch?: number;
}

export interface RestEvent extends BaseEvent {
  kind: 'rest';
  ticks: number;
  /** 附点：休止符与音符一样可带 1–2 个附点 */
  dot?: 0 | 1 | 2;
  groupId?: string;
}

/**
 * 小节线。**反复记号是它的属性，不是独立事件**：
 * `|:`、`:|`、跳房子都画在这一根线上，所以谱面上永远不会多出一条线。
 * （早期把它们做成独立事件，插入时就会在原有小节线旁边再长一条 `| |:`，
 *   而且「点这条线改它」也无从下手。）
 */
export interface BarlineEvent extends BaseEvent {
  kind: 'barline';
  style: 'single' | 'final';
  /** 弱起 / 不完全小节开关（§8.2） */
  partial?: boolean;
  /** `|:` 反复开始 / `:|` 反复结束 */
  repeat?: 'start' | 'end';
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
}

export type JumpMark = 'segno' | 'coda' | 'fine' | 'dc' | 'ds' | 'tocoda';

export interface JumpEvent extends BaseEvent {
  kind: 'jump';
  mark: JumpMark;
}

export interface DirectiveEvent extends BaseEvent {
  kind: 'directive';
  type: 'tempo' | 'dynamic' | 'patch' | 'text';
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
  /** 全局默认音色，MIDI program 0-127 */
  patch: number;
  /** 仅显示用，如 "Flute" */
  patchName?: string;
  /**
   * 谱面字号（px），缺省 21。数字 / 附点 / 增时线 / 倚音的整体大小随它缩放，
   * 行高与命中测试一起缩——三处（排版 / 绘制 / 命中）必须同源，见 layout.deriveGlyph。
   */
  fontSize?: number;
  /** 字间距（px），缺省 0。加在每个记号占位的横向空隙上，正数拉开、负数收紧 */
  letterSpacing?: number;
  /**
   * 小节线下方是否画小节号（`@measureNo off` 关掉）。缺省 true——
   * 只有用户明确关掉时才写进文件，老文件保持原样
   */
  showMeasureNumbers?: boolean;
}

export interface Score {
  version: 2;
  meta: ScoreMeta;
  /** 唯一真源，线性有序 */
  events: Event[];
  groups: BeatGroup[];
}

export function isTimed(e: Event): e is TimedEvent {
  return e.kind === 'note' || e.kind === 'rest';
}

