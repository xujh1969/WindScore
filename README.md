# WindScore

面向电吹管演奏者的**简谱写谱器**。录入 → 排版 → 播放 → 存成 `.jps` 文本文件，一套源码同时跑桌面（Tauri）和浏览器。

界面是自绘 Canvas：排版（`layout.ts`）与绘制（`paint.ts`）分离，命中测试（`pickAt` / `caretAt`）和绘制共用同一套度量——点在谱面上的位置和程序判定的位置永远一致。

## 现在能做什么

| 类别 | 支持 |
|---|---|
| 音符 | 音级 1–7、休止 0、高/低八度点、变音记号（♯ ♭ ♮） |
| 时值 | 减时线（1/2、1/4、1/8 拍）、增时线（2 拍、3 拍…）、单附点与双附点 |
| 节奏 | 拍内组自动连减时线、三连音 / 六连音（断弧 + 标号）、连音线、延音线 |
| 装饰 | 前倚音 / 后倚音（最多三颗，可带八度与变音） |
| 演奏记号 | 吐音 T / K、换气 V、断音 ·、保持音、重音、延长音、花舌、打音、波音、滑音、弯音 |
| 力度 | `pp p mp mf f ff` 与渐强 / 渐弱 |
| 转调 | 任意音符上标 `转1=G`，从该音起改用新调 |
| 版式 | 谱面字号、字间距（写在 `.jps` 里，打开即还原） |
| 播放 | 从光标处起播，光标 / 高亮条两种指示 |
| 校验 | 每小节拍数、拍内组不变量 I1–I5，工具栏实时显示 |
| 编辑 | 撤销/重做、复制粘贴、拖拉建选区、源码视图（实时解析，切回简谱自动应用） |

## 快速开始

```bash
npm install
npm run dev        # 浏览器预览 http://localhost:5173
npm test           # 内核回归测试（500+ 条断言，纯 Node 跑）
npm run build      # 类型检查 + 生产构建
npm run tauri:dev  # 桌面版（需 Rust 工具链）
npm run build:skill # 重新打包 skill 里的独立校验器（改了 dsl/validate/layout 后要跑）
```

浏览器版没有原生文件对话框：保存 = 下载 `.jps`，打开 = 用文件选择框。桌面版走系统对话框，能拿到真实路径。

## 键盘

| 键 | 作用 |
|---|---|
| `1`–`7` | 输入音符（选中某个音时 = 改它的音级） |
| `0` | 休止符 |
| `\|` 或 `\` | 小节线（连按两次 = 终止线） |
| `-` | 给光标左边的音加一拍（增时线） |
| `^` / `v` | 升 / 降八度 |
| `.` | 附点循环（无 → 单 → 双 → 无） |
| `t` | 吐音开关 |
| `←` / `→` | 在「方块（选中音）」和「插入点（缝隙）」之间切换；按住 `Shift` 建选区 |
| `Backspace` / `Delete` | 删除 |
| `Esc` | 取消选区 |
| `Ctrl+Z` / `Ctrl+Shift+Z`、`Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+S` | 保存 |
| `Ctrl+C` / `Ctrl+V` | 复制 / 粘贴选区 |
| `Ctrl+L` | 给选区加连音线 |

## 文件格式 `.jps`

纯文本，UTF-8。结构 = 头部元信息 + 空行 + 谱面主体（token 用空格分隔）：

```
@title 茉莉花
@key 1=G
@beat 2/4
@bpm 48
@patch 73

<3/2 3/4 5/4> <(6/4 1^/4) 1^/4 6/4> | <5/4 (5/4 6/2)> 5t | ...  ||

```

- 头部：`@title @key @beat @bpm @patch @patchName`（后两项可选），版式参数 `@size 字号` `@space 字间距`（未改过不写）
- 主体：`5`=1 拍、`5/2`=半拍、`5-`=2 拍、`5.`=1.5 拍、`5^`=高八度、`<…>`=拍内组、`<3: …>`=三连音、`5~5`=延音线、`(5 6 5)`=连音线、`{2}3`=前倚音、`5V`=换气、`5t`=吐音、`转1=G`=转调
- **独立换气记号 `'` 已从规范删除**，遇到会报错；换气写作音符后缀 `V`

完整语法：`skills/windscore-jps/reference.md`（给人和大模型读的规范）。设计决策与不变量：`windscore-v2-spec.md`。

## 目录结构

```
src/v2/
  types.ts     数据模型（Score / Event / BeatGroup）与类型
  dsl.ts       .jps 的解析与序列化（唯一的文件格式入口）
  ticks.ts     时值 ↔ tick、减时线条数、时值档位
  edit.ts      全部编辑操作（纯函数，改一个音 / 一组音都在这里）
  layout.ts    排版：度量派生、断行、落位、命中测试、插入点
  paint.ts     Canvas 绘制（只读 layout 的结果）
  validate.ts  I1–I5 不变量
  timeline.ts  音高与演奏时间线（调号 / 转调在这里生效）
  audio.ts     合成音播放
src/v2/ui/     React 界面（EditorApp / ScoreCanvas / editor.css）
src/scores/    内置示例谱（茉莉花、送别、欢乐颂、小星星、青花瓷）
scripts/       v2-test.ts 回归测试、build-skill-validator.ts、图标生成
skills/        windscore-jps：给大模型用的简谱转录 skill
windscore-v2-spec.md  设计方案（v2 全部决策与不变量）
```

## 让大模型帮你写谱

`skills/windscore-jps/` 是一份可直接挂到 Agent 上的技能包：把简谱图片或文字谱交给它，它按规范生成 `.jps` 并用内置校验器自检到 `PASS`。

```bash
node skills/windscore-jps/validate.mjs 曲名.jps   # PASS / FAIL + 退出码
```

校验器内嵌了本程序自己的解析器与不变量（不是另写一套），所以「校验通过 ≈ 程序能无损打开」。改了 `dsl.ts` / `validate.ts` / `layout.ts` 之后记得 `npm run build:skill` 重新打包。

## 开发约定

- 内核（types / dsl / edit / layout / validate / timeline）不依赖 DOM，可在 Node 里直接测
- 任何编辑操作都是 `edit.ts` 里的纯函数：`(score, …) => Score`，改一处只走一条写入路径
- 排版/绘制/命中三处必须用同一套度量（`layout.deriveGlyph`），各写一份就会出现「看着点在缝里、实际被判成点在音上」
- 界面文案说人话，内部术语（BeatGroup、不变量编号）不出现在面板上
