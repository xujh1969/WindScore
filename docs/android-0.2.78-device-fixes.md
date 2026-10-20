# Android 0.2.78 手机反馈修复

## 问题与调整

1. 横屏不转向：原生 Activity 未指定传感器方向策略，会遵循手机方向锁。改为 `fullSensor`，支持随设备转向；保留现有配置变化处理，避免转向重建页面或打断播放。
2. 切出去发送上传地址后失效：`MainActivity.onPause` 原先主动关闭服务并废弃凭证。现保留同一个监听、端口和令牌，用 dataSync 通知栏服务支持切换应用。Wi-Fi 丢失/地址变化、手动停用、退出应用仍关闭服务。后台新文件可以暂存，新的校验入库任务等手机回到前台后消费；电脑页面明确提示，不提前报告成功。
3. 双指放大后白屏：现有画布按整首谱高度乘设备 DPR 分配位图，窄屏大字号会增加行数和纹理高度，是移动 GPU/内存风险；手势每个 move 都触发重排。现只分配视口加 256px 缓冲区，滚动空间仍保留整首谱高度；分块移动绘图区，命中坐标加回偏移，DPR 上限为 2、单边不超过 4096 像素；字号更新按动画帧合并，关闭原生 WebView 网页缩放。由于未连接用户设备，尚不能确认其白屏是否还有其他原因。
4. 光球跳顿：原来每帧重建全曲落点并重画整首谱。轨迹现按排版结果缓存；Android 使用独立透明动画层，静态谱面只在排版、主题、选区或绘图区变化时重画。保留共用轨迹与拖尾算法、默认普通光标；真机光球帧率待验收。

## 版本和交付约定

- 本轮为 `0.2.78`、Android 构建 `5`；前面的构建 4 为本轮未交付的中间产物。
- 每轮代码修改交付前执行 `npm run version`；同步 package/锁文件、Tauri/Cargo 与 Android versionName，并递增 Android versionCode。
- APK 一律交付到项目 `artifacts/releases/`。Debug 和 Release 的 assemble/export 任务均自动复制，文件名含版本、构建号和类型；Gradle 自己的 build 目录仅为内部产物。
- 安装覆盖更新，不要求卸载或清空曲库。

## 跨端范围和检查

- Android：原生方向、上传生命周期、通知栏服务、手势及播放绘图区调整。
- 浏览器安卓预览：393×852 与 852×393、42px 字号、重排、光球显示、滚动到末尾均已查看，无页面横向溢出。样例 3132px 长谱的单层位图为 394×1106，未再按整谱高度分配。控制台未出现错误或警告；浏览器预览无法代替设备触摸、旋转传感器和 GPU 帧率验收。
- PC/Tauri：轨迹缓存位于共享播放实现；视口绘图区和独立动画层仅在 Android responsive 模式启用，桌面绘制方式保持原状。版本字段同步；根据用户后续要求，本轮也编译 0.2.78 exe，纯安卓变更不要求每次编译 PC。
- 0.2.78 普通网页生产构建通过。Android 类型检查、相对资源检查、Kotlin 和 APK 构建通过；`assembleDebug` 自动导出 `artifacts/releases/WindScore-0.2.78-android-build5.apk`（5,712,938 字节），与内部 APK SHA-256 一致；aapt 确认原生版本 0.2.78/5、fullSensor、dataSync 服务及权限均实际打入包内。Release 的导出依赖图经 dry-run 检查，本轮未生成 Release APK。
- ADB 当前无连接设备。以下待真机确认：横竖屏传感器、切到聊天软件后原地址可用、后台收包返回后入库、双指放大长谱、光球流畅度、通知栏停用、Wi-Fi 变化关闭。
- Windows 0.2.78 原生 release 与 NSIS 构建成功。免安装 exe 及安装版分别复制为 `artifacts/releases/WindScore-0.2.78-windows.exe`、`WindScore-0.2.78-windows-setup.exe`，交付副本与原输出哈希一致；本轮未执行桌面实际播放验收。

原生服务声明依据：[Android 前台服务类型要求](https://developer.android.com/develop/background-work/services/fgs/service-types)。
