# tools/ —— 识别流水线工具

模型只负责「看」（识别音高 / 时值 / 记号），语法正确性与拍数对账全部由这里的脚本保证。
两个工具配合 `validate.mjs` 使用，构成完整流水线：

```
原图 ──preprocess──> 放大 / 切条图 ──模型分段识别──> JSON ──json2jps──> .jps ──validate──> PASS
```

## preprocess.mjs —— 图片预处理

```bash
npm i jimp        # 一次性安装（纯 JS，无原生模块）
node tools/preprocess.mjs 原图.png out [--scale 2.5] [--rows 0] [--threshold 0] [--invert]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--scale` | 2.5 | 放大倍数；八度点 / 附点在原图里小于 3px 时必须放大 |
| `--rows` | 0（不切） | 按行切成 N 条，相邻条重叠 8% 高度防止切断音符 |
| `--threshold` | 0（只灰度） | 二值化阈值 0–255；彩色 / 灰底谱面从 170 试起 |
| `--invert` | 关 | 深底浅字的谱面先反相 |

## json2jps.mjs —— 结构化 JSON → .jps

模型**不直接写 .jps token**（那是语法漂移的第一来源），而是输出 JSON，由脚本转写。
脚本做三件事：字段合法性检查、**逐小节拍数对账**（stderr 精确报「小节 N 差多少拍」）、生成 .jps。

```bash
node tools/json2jps.mjs 谱面.json 曲名.jps
echo $?    # 0 = 拍数全对；1 = 有问题（按 stderr 提示回去重读对应小节）
```

### JSON schema

```json
{
  "meta": { "title": "曲名", "key": "1=C", "beat": "4/4", "bpm": 90, "patch": 73 },
  "measures": [
    {
      "partial": false,
      "notes": [
        {
          "d": 5,
          "dur": 1,
          "oct": 0,
          "acc": "",
          "tie": false,
          "slur": "",
          "graceBefore": [],
          "graceAfter": [],
          "text": "",
          "parenOpen": false,
          "parenClose": false
        }
      ],
      "meterAfter": "",
      "breakAfter": ""
    }
  ]
}
```

### 字段说明

| 字段 | 取值 | 说明 |
|---|---|---|
| `meta.key` | `1=C` … | 调号；决定合成音音高 |
| `meta.beat` | `4/4` … | 全曲起始拍号（后续变拍号用 `meterAfter`） |
| `measures[i].partial` | true/false | 弱起小节（只允许第一个小节） |
| `notes[].d` | 0–8 | 音级 1–7；`0`=休止；`8`=隐藏休止（占位不画） |
| `notes[].dur` | 拍数 | 见下方速查表；**模型只给拍数，写法由脚本选择** |
| `notes[].oct` | -3..3 | 八度点个数：正=高音 `^`，负=低音 `v` |
| `notes[].acc` | `""`/`#`/`b`/`♮` | 变音记号（休止符不允许） |
| `notes[].tie` | true/false | 延音线连到下一颗音（下一颗须同音高） |
| `notes[].slur` | `""`/`open`/`close` | 连音线弧线的起 / 止（弧线跨的音：首音 open、末音 close） |
| `notes[].graceBefore/After` | 数组 | 倚音 `{ "d": 6, "oct": 0, "acc": "" }`，最多 3 颗 |
| `notes[].text` | 字符串 | 段落文字标注 → `(前奏)` |
| `notes[].parenOpen/Close` | true/false | 左 / 右括号记号 → 全角 `（` / `）` |
| `measures[i].meterAfter` | `"3/4"` … | 本小节结束后改拍号（空 = 不改） |
| `measures[i].breakAfter` | `""`/`line`/`page` | 本小节末换行 / 分页 |

### dur 速查表（看到原图写法 → 填的拍数）

| 原谱写法 | dur | 原谱写法 | dur |
|---|---|---|---|
| `5` | 1 | `5.` | 1.5 |
| `5-` | 2 | `5..` | 1.75 |
| `5--` | 3 | `5/2` | 0.5 |
| `5---` | 4 | `5/4` | 0.25 |
| `0-`（休止同） | 2 | `5/8` | 0.125 |
| `5/3`（三连音成员） | 0.333 | `5/6`（六连音成员） | 0.167 |
| `5./2` | 0.75 | `8`（隐藏休止） | 1 |

脚本用 48-tick 网格精确对账：`0.333` 会被识别为三连音成员（16 tick），误差自动容忍。

## 推荐流水线（与 SKILL.md 的工作流一致）

1. preprocess 放大 / 切条；
2. 模型**逐段**识别，每段输出 `measures` 片段 JSON，**每段识别两遍**，一致才接受；
3. 拼成完整 JSON → json2jps；退出码 1 时，**只裁剪 stderr 点名的小节**放大重读，替换该小节片段后重跑；
4. validate.mjs 必须 PASS；
5. 交付时附「待人工核对清单」：两遍不一致的段、看不清的八度点 / 附点、仍未消掉的拍数告警。
