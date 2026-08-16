# dsh-recorder

QS668 / CB08 录音笔 BLE 控制 **DSH 插件**（Node/TypeScript/Cordis 技术栈实现）。

把录音笔的控制能力暴露为面向模型的 DSH 工具：扫描、连接、只读巡检、文件列表、
下载（WAV/OPUS 候选名自动回退）、删除（需显式确认）、远程录音控制、实时码流备份、
调试（raw 命令）与本地转写。

> 本插件是 Python 参考实现（recorder/ 目录）的 DSH 生态移植：协议层逐项对齐
> （帧格式 / CRC-16/XMODEM / 字节序 / 超时与兼容策略），并保留真机验证得到的
> 行为修正（如应答可能经 AE22 或 AE23 特征到达）。Python 项目仍可作为真机对照
> 与测试参考。

## 架构

```
src/
├── protocol.ts          协议层：CRC16、帧构造/解析、流式 FrameParser、文件列表/WAV 解码
├── transport.ts         传输抽象：BleTransport 接口 + SimulatedTransport（模拟设备）
│                        + NobleTransport（@abandonware/noble 适配器）
├── python-transport.ts  PythonBridgeTransport：子进程桥接 Python bleak（Windows 内置蓝牙）
├── device.ts            设备会话层：请求应答匹配、列表组装、下载会话、实时会话、录音控制
├── asr.ts               本地转写：ffmpeg 解码 16kHz PCM + 可插拔 ASR 命令（默认 whisper-cli）
└── index.ts             Cordis 插件入口：name/inject/Config/apply + 14 个工具注册

tools/
└── ble_bridge.py        Python bleak 桥接进程（transport=python 时使用，逐行 JSON over stdin/stdout）
```

- 协议层与传输层完全解耦：协议不依赖任何 BLE 库，可独立测试。
- 传输层可插拔：noble（真机）、python（Windows 内置蓝牙经 bleak/WinRT 桥接）与
  simulated（内存模拟设备，无硬件演示/测试）。
- 设备会话层保持参考实现的行为：列表无 CMD=18 时空闲 1.2s 收尾、下载 12s 空闲超时、
  候选名回退仅在未收到数据且 code=1 时、36B 整帧单写约束、同名落盘加 _时长s_大小 后缀。

## 工具清单

| 工具 | 说明 |
| --- | --- |
| recorder_scan | 扫描设备（timeout / compat） |
| recorder_connect / recorder_disconnect | 连接（按序号或 MAC）/ 断开 |
| recorder_status | 连接状态、MTU、电量/容量/固件 |
| recorder_smoke | 只读巡检（电量/容量/固件/授权码/录音状态/时长/文件名/增益/列表） |
| recorder_list | 文件列表（缓存供后续按序号引用） |
| recorder_download | 下载（候选名回退、续传、WAV 校验） |
| recorder_delete / recorder_deleteall | 删除（必须显式 confirm=true） |
| recorder_rec | 录音控制 start/save/pause/resume/state/time/name |
| recorder_gain | 增益查询/设置 |
| recorder_rt | 实时码流 start/stop/pause/resume（原始码流自动备份 .opus） |
| recorder_raw | 调试：任意 TYPE/CMD/参数十六进制封包发送 |
| recorder_transcribe | 本地转写（依赖 ffmpeg + ASR 命令，结果存同名 .txt） |

## 安装到 DSH

1. 构建插件（生成 lib/）：

```bash
cd dsh-recorder
npm install && npm run build
```

2. 把插件加入 DSH profile（以 web profile 为例，$DSH_HOME 默认为 ~/.dsh）：

```bash
cd ~/.dsh/profiles/web
npm install <本插件绝对路径>        # 或 pnpm add <本插件绝对路径>
```

3. 在 ~/.dsh/profiles/web/cordis.patch.yml 追加插件条目：

```yaml
- id: recorder
  name: dsh-recorder
  config:
    outputDir: D:/develop/python/record/downloads   # 下载与备份目录
    transport: python                               # python（Windows 内置蓝牙，推荐）/ noble / simulated
    # pythonPath: python                            # transport=python 时用的 python 可执行文件
    # bridgeScript:                                # 缺省为插件目录 tools/ble_bridge.py
    # ffmpegPath: ffmpeg
    # asrCommand: whisper-cli
    # asrModel: D:/models/ggml-base.bin
    # language: auto
```

4. 重启 dsh web，插件即被加载，模型将看到 recorder_* 工具。

> 配置也可通过 --patch <file> 覆盖；插件是普通 Cordis 插件，同样适用于
> headless / tui 等其他 profile。

## 平台支持与真机验证

| 场景 | 说明 |
| --- | --- |
| Linux / macOS 真机 | @abandonware/noble（BlueZ / CoreBluetooth）原生支持 |
| Windows 真机（内置蓝牙） | transport: python：经 Python bleak（WinRT 后端）桥接，无需 USB 适配器；需 `pip install bleak` |
| Windows 真机（USB 适配器） | noble + USB BLE 适配器 + WinUSB 驱动（实验性） |
| 无硬件演示 | transport: simulated：内置模拟固件（电量/容量/列表/下载），可完整走通工具链路 |
| 真机对照 | Python 参考实现（recorder/）已在 QS668/CB08 真机完整验证，协议行为以此为准 |

真机注意事项（来自参考实现验证）：
- 36B 整帧单写：2-2 文件导入请求必须一次 GATT 写入，MTU 需 ≥39。
- 应答通道：waiter 按 (type,cmd) 匹配、不区分 AE22/AE23——真机观察电量应答 0-4 经 AE23 到达。
- 文件名查询：未录音时设备可能对 3-23 无应答，工具会超时提示。
- 设备广播是间歇性的：扫描偶尔需要重试或等待设备进入广播窗口。

## 转写（recorder_transcribe）

插件保持 Node 技术栈：转写 = ffmpeg（解码 16kHz 单声道 PCM）+ 可插拔 ASR 命令。
默认使用 whisper.cpp 的 whisper-cli（参数兼容：-f wav -nt -np -ojf -of out，
读取 out.json 的 transcription 字段）。

安装示例（Windows）：

```bash
winget install Gyan.FFmpeg
# 下载 whisper.cpp release 与 ggml 模型：
#   https://github.com/ggerganov/whisper.cpp/releases  → whisper-cli.exe
#   https://huggingface.co/ggerganov/whisper.cpp       → ggml-base.bin
```

然后在插件配置中设置 asrCommand 与 asrModel 指向实际路径。
若需 SenseVoice 等模型的完整离线转写（含说话人分离），请使用 Python 参考实现。

## 测试

```bash
cd dsh-recorder
npm test        # tsx + node:test，无需真机/BLE
```

覆盖：协议字节级向量（含真机 36B 帧复现）、流式解析重同步、设备会话端到端
（模拟传输）、候选名回退、整帧单写、实时会话备份、插件工具注册与全链路冒烟。
