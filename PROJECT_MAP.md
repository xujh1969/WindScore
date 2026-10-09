# WindScore 项目地图

这份文档记录代码结构与模块边界，供后续开发快速定位。产品功能细节见 [README.md](README.md)，谱面格式规范见 [skills/windscore-jps/reference.md](skills/windscore-jps/reference.md)，设计约束见 [windscore-v2-spec.md](windscore-v2-spec.md)。

## 产品与运行入口

- 项目是离线优先的简谱动态谱工具：浏览器版与 Tauri 桌面版共用 React/TypeScript 应用和同一套本地数据格式。
- Vite 多页面入口：`index.html`（四个主入口）、`editor.html`（简谱编辑）、`align.html`（动态谱生成/对轨）、`library.html`（曲库管理）、`play.html`（只读曲库查询/播放）、`lab.html`（隐藏的实验性听音成谱）、`help.html`（分类帮助）。各页通过 `body[data-entry]` 进入 `src/main.tsx`，再选择 `EditorApp` 或独立页面。简谱编辑与对轨共用内核、会话及伴奏标定存储，但使用独立页面；曲库的对轨操作保存选中曲目会话并跳到 `align.html`。
- `src-tauri/` 提供桌面壳、系统文件对话框和安装包配置；业务逻辑仍在 `src/v2/`。
- `vite.config.ts` 配置页面入口、版本注入和转录 Worker 的 ES 输出。

## 代码分层

### 谱面内核：`src/v2/`

内核数据为 `Score`：有序 `events`、拍内组 `groups` 和元数据。内核尽量不依赖 DOM，便于 Node 测试。

- `types.ts`：谱面、音符、休止符、小节线、跳转标记和拍内组的数据模型；每拍 48 ticks。
- `dsl.ts`：`.jps` 文本的解析与序列化，是谱面文件格式的唯一入口。
- `lyrics.ts`：歌词行增删改名/关联、逐音附着与文本行序列化，中文词句逐字插入、补空位顺延（容量不足保留原谱）；`ui/TrackDialog.tsx` 创建演奏声部或关联歌词行，`ui/LyricCell.tsx` 与 `ScoreCanvas` 在谱面提供输入法完成选字后分格的输入。`PartInfo.lyricNames` 保存行名，文字仍在 `NoteEvent.lyrics` 中，歌词不进入播放时间线。歌词基础字号 16、段间距 24 同步用于画布输入框、布局、绘制和导出。
- `ticks.ts`、`validate.ts`：时值换算和谱面结构/不变量检查。
- `edit.ts`：编辑操作集中为纯函数，UI 通过这些函数改谱。
- `layout.ts`：从 Score 派生排版、字形度量、命中区域和拾取结果。
- `paint.ts`：Canvas 绘制 layout；不要在绘制或命中逻辑中另造字形尺寸。
- `timeline.ts`、`tempo.ts`、`clock.ts`：把事件转为演奏时间线，处理调号、转调、恒速/变速映射和播放时钟。
- `expand.ts`：把反复结构派生成线性谱，供播放与导出使用；编辑仍针对原谱。
- `audio.ts`、`beat.ts`、`mp3.ts`：合成/伴奏播放、音频 BPM 与入口估算、WAV 转 MP3。
- `pack.ts`：ZIP store 读写；业务包格式与 `.wspack` 约定在 `ui/packBundle.ts`。

### UI 与本地数据：`src/v2/ui/`

- `EditorApp.tsx` 是主应用和页面模式编排：记谱、对轨、曲库、播放/发现；`ScoreCanvas.tsx` 把 layout/paint 接到交互画布。
- `LibraryScreen.tsx`、`DiscoverScreen.tsx`、`ExportDialog.tsx`、`AudioWaveform.tsx` 分别承载曲库、播放首页、导出和对轨波形界面。
- `HelpCenter.tsx` / `help.css`：共用分类帮助、全文关键词搜索和原生模态窗口；首页进入独立 `help.html`。正文唯一来源是 `docs/user-guide.md`，顶层二级标题顺序与组件中的分类 ID 对应，维护时同时更新。
- `libraryStore.ts` 管谱面清单、摘要、收藏和订阅；`alignStore.ts` 管对轨参数与音频引用。
- `storeBackend.ts` 提供存储文件原语并选择 `tauri`、浏览器 `folder` 或 `local` 后端；`storeInit.ts` 负责启动水合、选目录和续接授权。不要绕过 Store 直接写曲库数据。
- 磁盘曲库格式：`library.json` + `align.json` + `audio/`；浏览器兜底为 localStorage + IndexedDB。
- `packBundle.ts` 将谱面、对轨和音频组合为 `.wspack`，使用 `pack.ts` 的 ZIP 实现。

### 导出：`src/v2/export/`

- `render.ts` 复用 layout/paint，提供 PDF 页和视频帧绘制。
- `pdf.ts` 做分页计划和 PDF 字节组装；`tasks.ts` 串联 PDF 绘制和保存。`ScoreCanvas.onLayout` 将当前排版与参数交给 `ExportDialog`，PDF 直接复用排版、按纸张宽度等比适配，再分页；逐页预览与导出共用 `paintExportPage`，DPI 不改变断行。
- `image.ts` 输出 PNG 长图与 SVG；`svg.ts` 把共用绘制器的文字和路径指令记录为矢量元素。
- `video.ts` 管画面比例、滚动与时长计算；`mix.ts` 离线混音/合成；`encode.ts` 选 WebCodecs 编码器；`videoExport.ts` 串起逐帧视频导出。

### 实验性听音成谱：`src/v2/lab/`

此功能当前存在于工作区的暂存改动中，后续开发应先核对相关 Git 状态，不要假设它已发布或与基线相同。

- `transcribe.ts` 将浏览器解码的人声重采样为 22050Hz 单声道 WAV，调用本机 GAME 服务；支持轮询与取消。
- `scripts/lab_server.py` 仅监听 `127.0.0.1:8766`，串行启动 GAME 官方 CLI，读取音符 CSV，清理临时音频。`scripts/lab-runtime.mjs` 安装官方 v1.0.3 源码与 medium 模型到 `.lab-runtime/`；权重有非商业许可限制。
- `rhythm.ts` / `rhythm.worker.ts` 复用 `beat.ts`：鼓 → 完整伴奏 → 贝斯 → 其他 → 人声，估计固定 BPM；相位不能直接当作小节首拍。
- `quantize.ts` 保留音符先后与休止，按固定 BPM/起点吸附至十六分网格，精确分拍并跨小节延音；`toDsl.ts` 输出可往返解析的 `.jps` 草稿。
- `LabScreen.tsx` / `lab.css` 管理两/四分轨上传、参数、服务状态、草稿谱面与合成试听。仅在人声输入时识别歌唱旋律；伴奏不冒充歌唱旋律。明确确认后通过现有 Store 入库，也可导出或交给编辑器修谱。
- 草稿支持整体 ±12 半音、选中音符起播、逐颗播放高亮、主音/前倚音半音校正；校正回溯原始识别音符，长音的所有分片一起更新。短倚音整理默认关闭，只整理紧邻长主音的短级进音，不自动消除变化音，真实识别效果仍需歌曲样本确认。
- `paint.ts` 的 `curve` 统一延音线、圆滑线、连音符弧线与倚音弧线，深色 `#d9b23c`、浅色 `#8a6a12`，编辑/播放/PDF/视频共用。
- 《青花瓷》真实人声的诊断见 `docs/qinghuaci-transcription-analysis.md`：确认真实错音、半音舍入问题、原谱与人声的八度差和末段升调；独立 pYIN 未表现出直接替换优势。对照数字不是标准识别准确率，后续应考虑分段调性与低置信标记。
- 第一阶段不识别乐器主奏、复调伴奏、三连音和变速谱；也不自动保存分轨到对轨 Store。独立 Python 服务尚未嵌入 MSI。

## 数据流速查

### 重奏与 JPS 3（2026-10-08）

- `Score.version` 保持内部版本 2；`format: 3` 对应文本的 `@format 3`。首声部复用根 `events/groups`，`part` 存其信息，`parts` 只存其余声部，避免重复保存首声部。
- 编辑器新建、载入与提交的谱默认使用 `format: 3`，空谱源码也生成新版谱头；无版本的旧文本仍由 DSL 按原语义解析，转换发生在解析之后，避免改变时值。声部栏不再提供版本启用按钮。
- `parts.ts` 负责声部投影、替换、组装、ID 命名空间、对应小节校验和首声部反复/跳转继承。事件/组 ID 带声部前缀。
- `dsl.ts` 支持 `@part`、`@mix`、斜线短写及三连音省写；新版自动拍组由 `edit.ts` 推导。旧文本规则保留。
- `ensembleLayout.ts` 按小节建立共享时间格，再调用单声部排版处理记号；`paint.ts` 绘制声部名称、连谱号和多个播放头。
- `PartsPanel.tsx` 管理声部、总谱/分谱与混音；`EditorApp.tsx` 用声部投影编辑、用整谱保存和撤销。`expand/timeline/audio` 同步处理所有声部，合成器用独立增益节点支持播放中混音。
- PDF 以整组声部为分页单位；视频以整组为滚动单位。导出窗口允许选择总谱或任一分谱。
- 使用规则与验证边界见 `docs/ensemble-guide.md`，示例为 `src/scores/ensemble-demo.jps`。
- 第二阶段（2026-10-09）：`BarlineEvent.beatAfter/breakAfter` 保存小节边界的拍号与断行/分页，首声部同步到其他声部；`meter.ts` 为拍号读取与拍组长度提供共同规则。`NoteEvent.hairpinTo` 引用范围终音，DSL 写 `cresc[ … ]hairpin` / `dim[ … ]hairpin`；复制、命名空间、删除和反复展开维护引用，layout 分段生成楔形，paint 分层避让力度文字。PDF 分页读取 `LayoutLine.pageBreakBefore`。`PartsPanel` 使用 pointer capture 和拖拽阈值换位，弹窗设置/删除保持原有撤销链路。

```text
.jps 文本 ⇄ dsl.ts ⇄ Score
                    ├─ edit.ts → 更新 Score → serializeDsl / session / 曲库
                    ├─ layout.ts → paint.ts → ScoreCanvas
                    ├─ expand.ts → timeline.ts + tempo.ts → audio.ts 播放
                    └─ layout.ts → export/render.ts → PDF 或视频

伴奏文件 + 锚点/TempoMap → alignStore → 播放 / 混音 / 视频导出
曲谱 + 对轨 + 音频 → packBundle → .wspack → 曲库导入
音频 → lab/transcribe → quantize → toDsl → 普通 .jps 草稿
```

## 开发与验证入口

- `npm run typecheck`：TypeScript 类型检查。
- `npm run build`：类型检查 + Vite 多页面生产构建。
- `npm test`：运行 `scripts/` 中 DSL/内核、展开、节拍、发现、导出、存储、MP3、播放和 Lab 的 Node 回归测试。
- `npm run build:skill`：将应用 DSL/校验逻辑打包到 `skills/windscore-jps/validate.mjs`。
- `npm run tauri:dev`：Tauri 桌面开发运行。

测试文件与功能映射：`v2-test.ts`（DSL/编辑/不变量）、`expand-test.ts`（反复）、`beat-test.ts`（节拍估算）、`discover-test.ts`（曲库发现逻辑）、`export-test.ts`、`store-test.ts`、`mp3-test.ts`、`play-test.ts`、`lab-test.ts`。

## 维护约束

- 改谱面格式时先看 `dsl.ts`、`types.ts`、`validate.ts` 和 JPS reference；保持解析/序列化往返一致。
- 改编辑行为时让变更经过 `edit.ts` 的纯函数，并保持拍内组/时值校验。
- 改谱面显示时同时检查 `layout.ts`、`paint.ts` 和命中测试的共享度量。
- 改播放或导出时区分原谱与反复展开谱，并复用 timeline/tempo 口径。
- 改曲库持久化时经由 `libraryStore`/`alignStore`，考虑三种后端和 `.wspack` 导入导出。
- `windscore-v2-spec.md` 与 `windscore-audio-alignment-guide.md` 是较深入的设计背景；修改相应领域前优先查阅。
