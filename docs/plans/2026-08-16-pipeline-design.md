# 2026-08-16 智能录音处理流水线（方向 A）设计

## 目标

把录音笔插件从「录音 → 纯文本转写」升级为「录音 → 可用产出」：
会议/课堂/通话录音一键（或自动）转成结构化纪要/笔记并归档。

## 需求（已与用户确认）

- **场景**：会议纪要为主 + 课堂笔记为主 + 自动归档
- **触发**：混合模式 —— 手动工具为主，可选「下载后自动处理」+「目录监听」两种自动开关
- **LLM**：复用 DSH LLM 服务（`ctx.llm`，默认 deepseek-official / deepseek-v4-flash），插件不额外配 key
- **归档**：日期目录 + LLM 提取的主题名命名；同目录产出三件套（.wav/.opus 原件 + .txt 全文 + .md 报告）
- **产出形态**：Markdown 报告（标题/时间/时长 + 结构化正文 + 全文转写附后）

## 架构

```
recorder_download 完成
    │
    ├─（可选 autoProcess=true）──► processFile() ──┐
    │                                               │
recorder_process 工具（手动）──────────────────────┤
    │                                               ▼
    │  1. 定位音频（已下载文件 / 设备文件）      ┌──────────────────┐
    │  2. 转写（复用 asr.ts）→ 全文 .txt        │  Pipeline 模块    │
    │  3. LLM 结构化（ctx.llm.stream）          │  src/pipeline.ts  │
    │  4. 归档：日期目录 + LLM 主题名           └──────────────────┘
    │     ├─ <日期>_<主题>.md   (纪要/笔记报告+全文)
    │     ├─ <日期>_<主题>.txt  (纯转写)
    │     └─ 原始 .wav/.opus 移入同目录
    └─（可选 dirWatch 开关）► 轮询下载目录新文件 → 自动 processFile
```

## 组件

### 1. `src/pipeline.ts`（核心）

- `processFile(audioPath, opts)`：
  1. ffmpeg 解码 + whisper 转写（复用 `asr.ts` 的 `transcribeFile`）→ 全文
  2. 提取音频时长（ffmpeg probe 或文件列表缓存）
  3. LLM 结构化：按模式（meeting/note）发 prompt → 主题名 + 结构化正文
  4. 落盘归档
- LLM prompt 模板：
  - **meeting**：议题清单、结论、待办（含责任人若可识别）、关键发言摘要
  - **note**：核心要点、公式/术语（若有）、作业/任务
  - 主题名：≤10 字，安全化（去非法字符）
- LLM 失败降级：结构化失败 → 仍保留 .txt 全文 + 无主题回退文件名，返回错误说明

### 2. 工具：`recorder_process`

- 参数：`index`（设备文件，自动下载）或 `local_file`（输出目录内文件）；`mode`（meeting/note，默认 meeting）
- 返回：归档路径、主题、模式、是否降级

### 3. 配置项（Config 扩展）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `autoProcess` | boolean | false | 下载完成后自动处理 |
| `dirWatch` | boolean | false | 监听下载目录新文件自动处理 |
| `archiveRoot` | string | `<outputDir>/archive` | 归档根目录 |
| `llmProvider` | string | `deepseek-official` | LLM provider |
| `llmModel` | string | `deepseek-v4-flash` | LLM 模型 |

### 4. 自动监听（`src/pipeline.ts` 内 `startWatcher`）

- 定时轮询（如 10s）下载目录，对比文件集合，新文件 → 排队自动处理
- 受 `dirWatch` 开关控制，插件 dispose 时停止
- 与 `autoProcess` 区别：autoProcess 挂在 download 完成路径上（即时），dirWatch 面向外部新文件

## 数据流

```
audio(wav/opus) → ffmpeg → 16kHz PCM → whisper-cli → 全文
  → ctx.llm.stream({provider, model, messages}) → 主题+结构化 markdown
  → archive/<YYYY-MM>/<YYYY-MM-DD>_<主题>.{md,txt} + 原件移入
```

## 错误处理

- 转写不可用（ffmpeg/whisper 缺失）：复用现有 AsrNotAvailable 错误
- LLM 不可用/超时：保留转写，跳过结构化，返回降级标记
- 文件名冲突：自动加 `_n` 后缀
- 目录监听：处理失败仅记录日志，不阻塞后续文件

## 测试

- pipeline 单测：mock LLM 返回固定 JSON，验证归档结构与文件名安全化
- 降级路径：LLM 不可用时保留 .txt
- 监听测试：临时目录 + 模拟新文件，验证自动处理被触发
- 全链路：simulated 传输下 download → process 冒烟

## 后续方向（本次不实施）

- B：实时听写与字幕（复用 Python 参考实现 OPUS 流式解码思路）
- C：录音内容语义检索（转写索引 + 自然语言查询）