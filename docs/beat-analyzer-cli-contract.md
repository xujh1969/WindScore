# B 路线：独立节拍分析程序接口约定

状态：设计约定，尚未实现 B 程序或安装 Beat This!。

## 进程边界

WindScore 不内嵌 Python/PyTorch/模型。分析器单独安装、单独升级；桌面版本用参数数组启动进程，网页版本先支持手动导入结果文件。优先 CLI，不必先运行常驻 HTTP 服务。

约定调用：

```text
windscore-beat analyze --input <绝对音频路径> --output <结果.json> --bpm-hint <可选速度> --meter <可选拍号>
```

输入分析器应使用原始音频；重采样、特征和模型推理都在分析器内部完成。bpm-hint 是可选提示，不等于强制速度。输入音频起点不能被自动裁掉；所有时间都是相对于原文件起点的秒数。

成功退出码为 0；stdout 只返回一份结果 JSON，stderr 输出日志/进度。失败非 0，stderr 给原因；取消由调用者结束进程，忽略未完成文件。结果先写临时文件，完成后原子替换输出文件。

## 结果结构

```json
{
  "schemaVersion": 1,
  "engine": "beat-this",
  "engineVersion": "实际版本",
  "audio": { "durationSec": 240.0 },
  "pulseUnit": "quarter",
  "bpm": 108.0,
  "beatTimes": [0.31, 0.866, 1.421],
  "downbeatTimes": [],
  "warnings": []
}
```

示例数组仅演示字段，实际须输出完整拍点。pulseUnit 必须明确，例如 quarter / eighth / dotted-quarter / unknown；复拍子不能默认为 quarter。unknown 时主程序要求确认速度层级，不能直接按四分音符 tick 接入。downbeatTimes 未检测成功时为空，不以每 N 拍推算来冒充检测结果。不要将未经校准的模型分数称为准确率。

主程序验证 schemaVersion、有限数值、严格递增的 beatTimes、音频时长及脉冲单位。完成单位转换后接入音频网格，再由人工绑定或独立原点匹配对齐谱面。B 不直接修改 JPS、谱面 BPM 或手动锚点。

现有兼容格式可输出 `AlignFile` 的 `tempo.kind=curve` / `beatTimes` / `scoreOriginBeat`，但完整结果仍保留 pulseUnit 与模型版本，防止单位歧义。

## 后续实施顺序

1. 收集 A 未能处理的真实样本与人工参照。
2. 独立程序接入 Beat This! 官方 Python 推理，实现上述协议。
3. 先通过手动导入 JSON 验证时间轴，再接桌面 CLI 自动调用。
4. 对同一批样本比较错误拍点、倍速歧义、前中后漂移和人工修正量后再决定默认引擎。
