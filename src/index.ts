/** QS668/CB08 录音笔 DSH 插件。

把录音笔的 BLE 控制能力暴露为面向模型的 DSH 工具：扫描、连接、巡检、
文件列表、下载、删除、录音控制、实时码流备份、调试与本地转写。
实现采用 DSH 技术栈（Node/TypeScript/Cordis），协议层为独立移植，
BLE 传输层可插拔（noble 真机 / 模拟设备）。

典型使用顺序：
    recorder_scan → recorder_connect → recorder_smoke / recorder_list
    → recorder_download → recorder_transcribe → recorder_disconnect
*/

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import * as path from "node:path";
import * as P from "./protocol.js";
import { Recorder, type DownloadResult } from "./device.js";
import { NobleTransport, SimulatedTransport, type BleTransport, type ScanDevice } from "./transport.js";
import { PythonBridgeTransport } from "./python-transport.js";
import { processFile, startWatcher, type ProcessMode } from "./pipeline.js";
import * as asr from "./asr.js";

export const name = "recorder";
export const inject = ["tools", "systemPrompt", "llm"];

/** Schemastery 配置：输出目录、传输后端、ASR 后端。 */
export const Config = z.object({
  outputDir: z.string().default("downloads"),
  /** "noble"（真机，Linux/macOS 或 Windows+USB 适配器）、"python"（Windows 内置蓝牙经 bleak 桥接）或 "simulated"（内存模拟设备）。 */
  transport: z.union([z.const("noble"), z.const("python"), z.const("simulated")]).default("noble"),
  /** python 桥接用的可执行文件（transport=python 时生效）。 */
  pythonPath: z.string().default("python"),
  /** 桥接脚本路径，缺省为插件目录 tools/ble_bridge.py。 */
  bridgeScript: z.string().default(""),
  /** transport=simulated 时模拟的扫描设备。 */
  simulatedDevices: z.array(z.object({
    name: z.string().default("CB08"),
    address: z.string().default("AA:BB:CC:DD:EE:FF"),
  })).default([]),
  /** ffmpeg 可执行文件（转写需要）。 */
  ffmpegPath: z.string().default("ffmpeg"),
  /** ASR 命令（whisper.cpp 兼容参数；输出纯文本或 -ojf JSON）。 */
  asrCommand: z.string().default("whisper-cli"),
  /** whisper.cpp ggml 模型路径，如 models/ggml-base.bin。 */
  asrModel: z.string().default(""),
  /** 转写默认语言：auto/zh/en/yue/ja/ko。 */
  language: z.string().default("auto"),
  /** 下载完成后自动转写并生成结构化报告。 */
  autoProcess: z.boolean().default(false),
  /** 轮询监听下载目录，新音频文件自动处理。 */
  dirWatch: z.boolean().default(false),
  /** 归档根目录；缺省为 outputDir/archive。 */
  archiveRoot: z.string().default(""),
  /** LLM provider（结构化摘要，复用 DSH LLM 服务）。 */
  llmProvider: z.string().default("deepseek-official"),
  /** LLM 模型。 */
  llmModel: z.string().default("deepseek-v4-flash"),
});

// DSH 约定 render(args, value)：第一个参数是调用参数，第二个才是执行结果。
// 旧实现只收一个参数，导致 value 实际收到 args，所有工具结果被渲染成参数回显。
const text = (_args: unknown, value: unknown): { type: "text"; text: string }[] =>
  [{ type: "text", text: JSON.stringify(value) }];

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function formatFileTime(value: number): string {
  if (P.isEpochTimestamp(value)) {
    return new Date(value * 1000).toISOString().replace("T", " ").slice(0, 16);
  }
  return formatDuration(value);
}

const BATTERY_LABELS: Record<number, string> = { 110: "充电中" };
const STATE_LABELS: Record<number, string> = { 1: "录音中", 2: "未录音", 3: "暂停" };
const GAIN_LABELS: Record<number, string> = { 1: "低", 2: "中", 3: "高" };
const RESULT_LABELS: Record<number, string> = { 1: "成功", 2: "失败" };

/** 模拟固件 handler：响应基本命令，便于无硬件演示。 */
function simulatedHandler(type: number, cmd: number, body: Buffer): Buffer[] {
  const resp = (data: number[]) => Buffer.from(data);
  if (type === P.TYPE_CONTROL) {
    if (cmd === P.CTRL_GET_BATTERY) return [resp([P.TYPE_CONTROL, P.CTRL_BATTERY_RESP, 85])];
    if (cmd === P.CTRL_GET_CAPACITY) {
      const b = Buffer.allocUnsafe(9);
      b[0] = P.TYPE_CONTROL; b[1] = P.CTRL_CAPACITY_RESP;
      b.writeUInt32LE(1024 * 1024, 2); b.writeUInt32LE(2048 * 1024, 6);
      return [b];
    }
    if (cmd === P.CTRL_GET_VERSION) {
      return [resp([P.TYPE_CONTROL, P.CTRL_VERSION_RESP, ...Buffer.from("V1.0.0")])];
    }
    if (cmd === P.CTRL_GET_AUTH) {
      return [resp([P.TYPE_CONTROL, P.CTRL_AUTH_RESP, ...Buffer.from("SIM0001")])];
    }
    return [];
  }
  if (type === P.TYPE_KEY) {
    if (cmd === P.KEY_GET_STATE) return [resp([P.TYPE_KEY, P.KEY_STATE_RESP, 2])];
    if (cmd === P.KEY_GET_TIME) {
      const b = Buffer.allocUnsafe(8);
      b[0] = P.TYPE_KEY; b[1] = P.KEY_TIME_RESP;
      b.writeUInt16LE(0, 2); b.writeUInt32LE(0, 4);
      return [b];
    }
    if (cmd === P.KEY_GET_FILENAME) return [resp([P.TYPE_KEY, P.KEY_FILENAME_RESP, 0])];
    if (cmd === P.KEY_GET_GAIN) return [resp([P.TYPE_KEY, P.KEY_GAIN_RESP, 3])];
    if (cmd === P.KEY_SET_GAIN) return [resp([P.TYPE_KEY, P.KEY_SET_GAIN_RESP, 0])];
    if (cmd === P.KEY_REC_START) return [resp([P.TYPE_KEY, P.KEY_REC_START_RESP, 1])];
    if (cmd === P.KEY_REC_SAVE) return [resp([P.TYPE_KEY, P.KEY_REC_SAVE_RESP, 1])];
    if (cmd === P.KEY_REC_PAUSE) return [resp([P.TYPE_KEY, P.KEY_REC_PAUSE_RESP, 1])];
    if (cmd === P.KEY_REC_RESUME) return [resp([P.TYPE_KEY, P.KEY_REC_RESUME_RESP, 1])];
    return [];
  }
  if (type === P.TYPE_FILE) {
    if (cmd === P.FILE_LIST_REQ) {
      // 一个模拟测试文件
      const name = Buffer.alloc(20);
      Buffer.from("demo20260101-000000.").copy(name);
      const entry = Buffer.allocUnsafe(28);
      entry.writeUInt32BE(3, 0);   // 时长 3s
      entry.writeUInt32BE(9600, 4); // 大小
      name.copy(entry, 8);
      const head = Buffer.allocUnsafe(6);
      head[0] = P.TYPE_FILE; head[1] = P.FILE_LIST_DATA;
      head.writeUInt32BE(1, 2); // count:4B BE
      return [Buffer.concat([head, entry]),
              resp([P.TYPE_FILE, P.FILE_LIST_DONE, 0])];
    }
    if (cmd === P.FILE_IMPORT_REQ) {
      const filename = Buffer.from(body.subarray(4)).toString("utf8").split("\0")[0] ?? "";
      const payload = Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4), Buffer.from("WAVE"),
        Buffer.alloc(36),
      ]);
      payload.writeUInt32LE(payload.length - 8, 4); // 声明长度（模拟）
      const chunks: Buffer[] = [];
      for (let i = 0; i < payload.length; i += 16) {
        chunks.push(Buffer.concat([resp([P.TYPE_FILE, P.FILE_DATA]), payload.subarray(i, i + 16)]));
      }
      return [
        resp([P.TYPE_FILE, P.FILE_IMPORT_START, ...Buffer.from(filename)]),
        ...chunks,
        resp([P.TYPE_FILE, P.FILE_IMPORT_END, P.IMPORT_END_OK]),
      ];
    }
    return [];
  }
  return [];
}

function apply(ctx: any, config: any): void {
  const resolved = {
    outputDir: config.outputDir ?? "downloads",
    transport: config.transport ?? "noble",
    pythonPath: config.pythonPath ?? "python",
    bridgeScript: config.bridgeScript ?? "",
    simulatedDevices: config.simulatedDevices ?? [],
    ffmpegPath: config.ffmpegPath ?? "ffmpeg",
    asrCommand: config.asrCommand ?? "whisper-cli",
    asrModel: config.asrModel ?? "",
    language: config.language ?? "auto",
    autoProcess: config.autoProcess === true,
    dirWatch: config.dirWatch === true,
    archiveRoot: config.archiveRoot || path.join(config.outputDir ?? "downloads", "archive"),
    llmProvider: config.llmProvider ?? "deepseek-official",
    llmModel: config.llmModel ?? "deepseek-v4-flash",
  };

  let transport: BleTransport;
  if (resolved.transport === "simulated") {
    const devices: ScanDevice[] = resolved.simulatedDevices.length > 0
      ? resolved.simulatedDevices
      : [{ name: "CB08", address: "AA:BB:CC:DD:EE:FF" }];
    transport = new SimulatedTransport(devices, simulatedHandler);
  } else if (resolved.transport === "python") {
    transport = new PythonBridgeTransport(
      resolved.pythonPath,
      resolved.bridgeScript || undefined);
  } else {
    transport = new NobleTransport();
  }
  const recorder = new Recorder(transport, resolved.outputDir);

  // 工具共享状态
  let scanDevices: ScanDevice[] = [];
  let filesCache: P.FileEntry[] = [];
  let busy = false;

  const requireConnected = () => {
    if (!recorder.isConnected) {
      throw new HarnessError("尚未连接设备，请先 recorder_scan 后 recorder_connect", "RECORDER_NOT_CONNECTED");
    }
  };
  const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy) throw new HarnessError("有耗时操作正在进行（下载/巡检/列表），请稍候", "RECORDER_BUSY");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
  const entryByIndex = (index: number): P.FileEntry => {
    const entry = filesCache[index];
    if (!entry) {
      throw new HarnessError("无效文件序号，请先 recorder_list 刷新列表", "RECORDER_BAD_INDEX");
    }
    return entry;
  };

  const asrOpts = {
    ffmpegPath: resolved.ffmpegPath,
    asrCommand: resolved.asrCommand,
    asrModel: resolved.asrModel,
  };

  ctx.systemPrompt?.section?.({
    name: "tool:recorder",
    order: 115,
    text: "录音笔工具：使用前先 recorder_scan 发现设备，再 recorder_connect；" +
      "巡检用 recorder_smoke，列表用 recorder_list，下载用 recorder_download，转写用 recorder_transcribe。" +
      "下载/删除/巡检是耗时或危险操作，按需执行；删除操作必须传 confirm=true。",
  });

  const output = (schema: any) => ({ schema, render: text });

  // ---------------- 连接管理 ----------------

  ctx.tools.register(defineTool({
    name: "recorder_scan",
    description: "扫描附近的 QS668/CB08 录音笔（BLE）。timeout 为扫描秒数；compat=true 时列出全部有名设备（兼容广播不带服务 UUID 的固件）。返回设备列表，随后用 recorder_connect 按序号或地址连接。",
    parameters: {
      timeout: { type: "number", description: "扫描秒数，默认 6" },
      compat: { type: "boolean", description: "兼容模式列出全部有名设备，默认 false" },
    },
    output: output({
      type: "object", additionalProperties: false,      properties: { devices: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { index: { type: "integer", required: true }, name: { type: "string", required: true }, address: { type: "string", required: true } } } } },
    }),
    async execute(args: any) {
      const devices = await recorder.scan(
        Math.max(1, Math.min(30, Math.round(args.timeout ?? 6)) * 1000),
        args.compat === true);
      scanDevices = devices;
      return { devices: devices.map((d, i) => ({ index: i, name: d.name || "(无名称)", address: d.address })) };
    },
    presentCall: () => ({ card: "generic", title: "扫描录音笔", kind: "search" }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_connect",
    description: "连接录音笔：target 为 recorder_scan 返回的序号或 MAC 地址。连接成功后自动同步设备时间。返回 MTU 与单写载荷上限（36B 整帧单写需要 ≥36B）。",
    parameters: {
      target: { type: "string", required: true, description: "扫描序号（如 \"0\"）或 MAC 地址（如 \"D1:A1:CA:00:01:B4\"）" },
    },
    output: output({
      type: "object", additionalProperties: false,      properties: {
        connected: { type: "boolean", required: true },
        mtu: { type: "integer" },
        payload: { type: "integer" },
        time_synced: { type: "boolean", required: true },
      },
    }),
    async execute(args: any) {
      const raw = String(args.target ?? "");
      let device: ScanDevice | null = null;
      if (/^\d+$/.test(raw)) {
        const index = Number(raw);
        device = scanDevices[index] ?? null;
        if (!device) throw new HarnessError("无效设备序号，请重新 recorder_scan", "RECORDER_BAD_TARGET");
      } else {
        device = { name: raw, address: raw };
      }
      await recorder.connect(device);
      filesCache = [];
      let timeSynced = true;
      try {
        await recorder.syncTime();
      } catch {
        timeSynced = false;
      }
      return {
        connected: true,
        mtu: recorder.transport.mtu,
        payload: recorder.transport.payloadSize,
        time_synced: timeSynced,
      };
    },
    presentCall: (args: any) => ({ card: "generic", title: "连接录音笔", kind: "other", rawInput: args.target }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_disconnect",
    description: "断开录音笔连接。",
    parameters: {},
    output: output({ type: "object", additionalProperties: false, properties: { connected: { type: "boolean", required: true } } }),
    async execute() {
      await recorder.disconnect();
      return { connected: false };
    },
    presentCall: () => ({ card: "generic", title: "断开录音笔", kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_status",
    description: "查看连接状态与 MTU；已连接时附带电量/容量/固件版本（查询失败显示 null，不会中断）。",
    parameters: {},
    output: output({
      type: "object", additionalProperties: false,      properties: {
        connected: { type: "boolean", required: true },
        mtu: { type: "integer" },
        payload: { type: "integer" },
        battery: { type: "json" },
        capacity_remain_kb: { type: "integer" },
        capacity_total_kb: { type: "integer" },
        version: { type: "string" },
      },
    }),
    async execute() {
      const base: any = { connected: recorder.isConnected };
      if (!recorder.isConnected) return base;
      base.mtu = recorder.transport.mtu;
      base.payload = recorder.transport.payloadSize;
      try { base.battery = await recorder.getBattery(); } catch { base.battery = null; }
      try {
        const [remain, total] = await recorder.getCapacity();
        base.capacity_remain_kb = remain;
        base.capacity_total_kb = total;
      } catch { /* 忽略 */ }
      try { base.version = await recorder.getVersion(); } catch { /* 忽略 */ }
      return base;
    },
    presentCall: () => ({ card: "generic", title: "录音笔状态", kind: "read" }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_smoke",
    description: "只读巡检：依次查询电量/容量/固件/授权码/录音状态/录音时间/当前文件名/增益/文件列表（命令间隔 260ms，不发送任何写入/删除命令）。返回各项的 ok/value，失败项 ok=false 并给出原因。",
    parameters: {},
    output: output({
      type: "object", additionalProperties: false,      properties: {
        items: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { label: { type: "string", required: true }, ok: { type: "boolean", required: true }, value: { type: "string", required: true } } } },
        file_count: { type: "integer", required: true },
      },
    }),
    async execute() {
      requireConnected();
      return withBusy(async () => {
        const items: { label: string; ok: boolean; value: string }[] = [];
        const step = async (label: string, fn: () => Promise<string>) => {
          try {
            items.push({ label, ok: true, value: await fn() });
          } catch (error) {
            items.push({ label, ok: false, value: (error as Error).message.includes("超时") ? "无应答（超时）" : `失败 ${(error as Error).message}` });
          }
          await new Promise((r) => setTimeout(r, 260));
        };
        await step("电量", async () => BATTERY_LABELS[await recorder.getBattery()] ?? `${await recorder.getBattery()}%`);
        await step("容量", async () => {
          const [remain, total] = await recorder.getCapacity();
          return `剩余 ${formatBytes(remain * 1024)} / 共 ${formatBytes(total * 1024)}`;
        });
        await step("固件", () => recorder.getVersion());
        await step("授权码", () => recorder.getAuthCode());
        await step("录音状态", async () => STATE_LABELS[await recorder.recordState()] ?? `${await recorder.recordState()}`);
        await step("录音时间", async () => {
          const [duration, size] = await recorder.recordTime();
          return `${formatDuration(duration)} / ${formatBytes(size)}`;
        });
        await step("当前文件名", () => recorder.recordFilename());
        await step("增益", async () => GAIN_LABELS[await recorder.getGain()] ?? `${await recorder.getGain()}`);
        await step("文件列表", async () => {
          filesCache = await recorder.getFileList();
          return `${filesCache.length} 个文件`;
        });
        return { items, file_count: filesCache.length };
      });
    },
    presentCall: () => ({ card: "generic", title: "只读巡检", kind: "read" }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_list",
    description: "拉取设备文件列表（缓存供 recorder_download / recorder_delete / recorder_transcribe 按序号引用）。返回 [{index, name, duration, size}]；name 为设备内截断名（20B 字段），下载时会自动重建 .wav/.opus 扩展名。",
    parameters: {},
    output: output({
      type: "object", additionalProperties: false,      properties: {
        files: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { index: { type: "integer", required: true }, name: { type: "string", required: true }, duration: { type: "integer", required: true }, size: { type: "integer", required: true }, time_text: { type: "string", required: true } } } },
      },
    }),
    async execute() {
      requireConnected();
      return withBusy(async () => {
        filesCache = await recorder.getFileList();
        return {
          files: filesCache.map((f, i) => ({
            index: i, name: f.name, duration: f.duration, size: f.size,
            time_text: formatFileTime(f.duration),
          })),
        };
      });
    },
    presentCall: () => ({ card: "generic", title: "文件列表", kind: "read" }),
  }));

  // ---------------- 下载 / 删除 ----------------

  ctx.tools.register(defineTool({
    name: "recorder_download",
    description: "下载设备文件（候选名 .wav → .opus → 原始截断名自动回退；offset>0 续传时不换候选名）。index 来自 recorder_list。文件保存到输出目录（同名自动加 _时长s_大小 后缀），返回本地路径、大小与 WAV 头校验结果。可能耗时数秒到数十秒。",
    parameters: {
      index: { type: "integer", required: true, description: "recorder_list 返回的文件序号" },
      offset: { type: "integer", description: "续传字节偏移，默认 0" },
      filename: { type: "string", description: "显式请求文件名（跳过候选名回退）" },
    },
    output: output({
      type: "object", additionalProperties: false,      properties: {
        filename: { type: "string", required: true },
        device_name: { type: "string", required: true },
        path: { type: "string", required: true },
        size: { type: "integer", required: true },
        is_wav: { type: "boolean", required: true },
        wav_ok: { type: "boolean" },
        sample_rate: { type: "integer" },
        bits: { type: "integer" },
        channels: { type: "integer" },
      },
    }),
    async execute(args: any) {
      requireConnected();
      return withBusy(async () => {
        const entry = entryByIndex(args.index);
        const result: DownloadResult = await recorder.download(
          entry, Math.max(0, args.offset ?? 0), args.filename ?? undefined);
        if (resolved.autoProcess && result.path) {
          runAutoProcess(result.path).catch((e) => {
            console.error("[recorder] autoProcess 失败:", (e as Error).message);
          });
        }
        return {
          filename: result.filename,
          device_name: result.deviceName,
          path: result.path ?? "",
          size: result.data.length,
          is_wav: result.isWav,
          ...(result.wavInfo ? {
            wav_ok: result.wavInfo.ok,
            sample_rate: result.wavInfo.sampleRate,
            bits: result.wavInfo.bitsPerSample,
            channels: result.wavInfo.channels,
          } : {}),
        };
      });
    },
    presentCall: (args: any) => ({ card: "generic", title: "下载文件", kind: "execute", rawInput: `#${args.index}` }),
  }));

  const deleteGuard = (confirm: unknown) => {
    if (confirm !== true) {
      throw new HarnessError("删除不可恢复，必须显式传 confirm=true", "RECORDER_CONFIRM_REQUIRED");
    }
  };

  ctx.tools.register(defineTool({
    name: "recorder_delete",
    description: "删除设备上的单个文件（不可恢复）。必须显式传 confirm=true。删除后建议 recorder_list 刷新。",
    parameters: {
      index: { type: "integer", required: true, description: "recorder_list 返回的文件序号" },
      confirm: { type: "boolean", required: true, description: "必须为 true 才会执行" },
    },
    output: output({ type: "object", additionalProperties: false, properties: { message: { type: "string", required: true } } }),
    async execute(args: any) {
      requireConnected();
      deleteGuard(args.confirm);
      const entry = entryByIndex(args.index);
      const code = await recorder.deleteFile(entry);
      return { message: code === null ? "删除命令已发送（该固件不回应答），请 recorder_list 核对" : (code === 0 ? "删除成功" : `删除失败（code=${code}）`) };
    },
    presentCall: (args: any) => ({ card: "generic", title: "删除文件", kind: "delete", rawInput: `#${args.index}` }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_deleteall",
    description: "删除设备上的全部录音（不可恢复）。必须显式传 confirm=true。",
    parameters: { confirm: { type: "boolean", required: true, description: "必须为 true 才会执行" } },
    output: output({ type: "object", additionalProperties: false, properties: { message: { type: "string", required: true } } }),
    async execute(args: any) {
      requireConnected();
      deleteGuard(args.confirm);
      const code = await recorder.deleteAll();
      filesCache = [];
      return { message: code === null ? "删除命令已发送（该固件不回应答），请 recorder_list 核对" : (code === 0 ? "全部删除成功" : `删除失败（code=${code}）`) };
    },
    presentCall: () => ({ card: "generic", title: "删除全部", kind: "delete" }),
  }));

  // ---------------- 录音控制 ----------------

  ctx.tools.register(defineTool({
    name: "recorder_rec",
    description: "远程录音控制：action 为 start/save/pause/resume/state/time/name。state 返回录音状态，time 返回时长与当前大小，name 返回当前文件名（设备未录音时可能无应答）。",
    parameters: { action: { type: "string", required: true, enum: ["start", "save", "pause", "resume", "state", "time", "name"] } },
    output: output({ type: "object", additionalProperties: false, properties: { message: { type: "string", required: true } } }),
    async execute(args: any) {
      requireConnected();
      const action = args.action;
      if (action === "start") return { message: `开始录音：${RESULT_LABELS[await recorder.recordStart()] ?? "未知"}` };
      if (action === "save") return { message: `保存录音：${RESULT_LABELS[await recorder.recordSave()] ?? "未知"}` };
      if (action === "pause") return { message: `暂停录音：${RESULT_LABELS[await recorder.recordPause()] ?? "未知"}` };
      if (action === "resume") return { message: `继续录音：${RESULT_LABELS[await recorder.recordResume()] ?? "未知"}` };
      if (action === "state") return { message: `录音状态:${STATE_LABELS[await recorder.recordState()] ?? "未知"}` };
      if (action === "time") {
        const [duration, size] = await recorder.recordTime();
        return { message: `录音时长 ${formatDuration(duration)}，当前大小 ${formatBytes(size)}` };
      }
      if (action === "name") return { message: `当前文件名：${await recorder.recordFilename()}` };
      throw new HarnessError("action 无效", "RECORDER_BAD_ARGS");
    },
    presentCall: (args: any) => ({ card: "generic", title: `录音${args.action}`, kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_gain",
    description: "查询或设置录音增益：action=get 查询，action=set 时 level 为 1（低）/2（中）/3（高）。",
    parameters: {
      action: { type: "string", required: true, enum: ["get", "set"] },
      level: { type: "integer", description: "set 时必填：1/2/3" },
    },
    output: output({ type: "object", additionalProperties: false, properties: { message: { type: "string", required: true } } }),
    async execute(args: any) {
      requireConnected();
      if (args.action === "get") {
        const g = await recorder.getGain();
        return { message: `当前增益：${GAIN_LABELS[g] ?? g}` };
      }
      if (args.action === "set") {
        if (![1, 2, 3].includes(args.level)) throw new HarnessError("level 须为 1/2/3", "RECORDER_BAD_ARGS");
        const r = await recorder.setGain(args.level);
        return { message: r === 0 ? "设置增益成功" : `设置失败（code=${r}）` };
      }
      throw new HarnessError("action 无效", "RECORDER_BAD_ARGS");
    },
    presentCall: () => ({ card: "generic", title: "增益", kind: "other" }),
  }));

  // ---------------- 实时码流 ----------------

  ctx.tools.register(defineTool({
    name: "recorder_rt",
    description: "实时音频流控制：action=start 发送开始实时推流（设备随后推送音频，原始码流自动备份到输出目录 .opus）；action=stop 停止并返回备份路径与接收字节数；pause/resume 暂停/继续。",
    parameters: { action: { type: "string", required: true, enum: ["start", "stop", "pause", "resume"] } },
    output: output({
      type: "object", additionalProperties: false,      properties: {
        message: { type: "string", required: true },
        path: { type: "string" },
        received: { type: "integer" },
      },
    }),
    async execute(args: any) {
      requireConnected();
      const action = args.action;
      if (action === "start") {
        await recorder.realtimeStart();
        return { message: "已发送开始实时推流，等待设备推送音频；原始码流会自动备份" };
      }
      if (action === "stop") {
        const session = await recorder.realtimeStop();
        if (session?.path) {
          return { message: `实时码流已保存：${session.path}（${formatBytes(session.received)}）`, path: session.path, received: session.received };
        }
        return { message: "实时会话已结束" };
      }
      if (action === "pause" || action === "resume") {
        await recorder.realtimePause(action === "pause");
        return { message: action === "pause" ? "已暂停" : "已继续" };
      }
      throw new HarnessError("action 无效", "RECORDER_BAD_ARGS");
    },
    presentCall: (args: any) => ({ card: "generic", title: `实时${args.action}`, kind: "other" }),
  }));

  // ---------------- 调试 ----------------

  ctx.tools.register(defineTool({
    name: "recorder_raw",
    description: "调试：按协议封包发送任意命令 raw <type> <cmd> [params_hex]。params_hex 为十六进制字符串（如 \"01ff\"）。本工具不等待应答。",
    parameters: {
      type: { type: "integer", required: true },
      cmd: { type: "integer", required: true },
      params_hex: { type: "string", description: "十六进制参数，如 \"01ff\"，可省略" },
    },
    output: output({ type: "object", additionalProperties: false, properties: { message: { type: "string", required: true } } }),
    async execute(args: any) {
      requireConnected();
      let params = new Uint8Array(0);
      if (args.params_hex) {
        const cleaned = String(args.params_hex).replace(/0x/g, "").replace(/\s+/g, "");
        if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new HarnessError("params_hex 无效", "RECORDER_BAD_ARGS");
        params = Buffer.from(cleaned, "hex");
      }
      await recorder.sendRawCommand(args.type, args.cmd, params);
      return { message: `已发送 ${args.type}-${args.cmd} params=${params.length ? Buffer.from(params).toString("hex") : "-"}` };
    },
    presentCall: (args: any) => ({ card: "generic", title: "原始命令", kind: "other", rawInput: `${args.type}-${args.cmd}` }),
  }));

  // ---------------- 转写 ----------------

  ctx.tools.register(defineTool({
    name: "recorder_transcribe",
    description: "本地转写：index 转写设备文件（未下载自动下载并复用本地），local_file 转写输出目录内的文件（仅文件名）。依赖 ffmpeg 与可插拔 ASR 命令（默认 whisper-cli/whisper.cpp，配置 asrCommand/asrModel）。结果保存为同名 .txt。",
    parameters: {
      index: { type: "integer", description: "设备文件序号（与 local_file 二选一）" },
      local_file: { type: "string", description: "输出目录内的本地文件名（与 index 二选一）" },
      language: { type: "string", enum: [...asr.LANGUAGES], description: "语言：auto/zh/en/yue/ja/ko，默认 auto" },
    },
    output: output({
      type: "object", additionalProperties: false,      properties: {
        text: { type: "string", required: true },
        txt_path: { type: "string", required: true },
        source: { type: "string", required: true },
        reused: { type: "boolean", required: true },
      },
    }),
    async execute(args: any) {
      const language = args.language ?? resolved.language;
      if (!asr.LANGUAGES.includes(language)) throw new HarnessError(`language 须为 ${asr.LANGUAGES.join("/")}`, "RECORDER_BAD_ARGS");
      return withBusy(async () => {
        let filePath: string | null = null;
        let reused = false;
        if (args.index !== undefined) {
          const entry = entryByIndex(args.index);
          const existing = recorder.findLocalFile(entry);
          if (existing) {
            filePath = existing;
            reused = true;
          } else {
            requireConnected();
            const result = await recorder.download(entry);
            filePath = result.path;
          }
        } else if (args.local_file) {
          // 仅允许输出目录内的文件，防目录穿越
          const pathMod = await import("node:path");
          const fsMod = await import("node:fs");
          const name = pathMod.basename(String(args.local_file));
          const p = pathMod.join(resolved.outputDir, name);
          if (!fsMod.existsSync(p)) {
            throw new HarnessError("本地文件不存在", "RECORDER_BAD_ARGS");
          }
          filePath = p;
        } else {
          throw new HarnessError("index 或 local_file 必须提供一个", "RECORDER_BAD_ARGS");
        }
        if (filePath === null) {
          throw new HarnessError("index 或 local_file 必须提供一个", "RECORDER_BAD_ARGS");
        }
        const ready = asr.isAsrReady(asrOpts);
        if (!ready.ok) {
          throw new HarnessError(`转写依赖缺失：${ready.missing.join(", ")}。需要 ffmpeg 和 ASR 命令（默认 whisper-cli；见插件 README 安装说明）`, "RECORDER_ASR_UNAVAILABLE");
        }
        const textOut = await asr.transcribeFile(filePath, { ...asrOpts, language });
        const fsMod = await import("node:fs");
        const txtPath = filePath.replace(/\.[^.]*$/, "") + ".txt";
        fsMod.writeFileSync(txtPath, (textOut || "") + "\n", "utf8");
        return { text: textOut || "（未识别到语音）", txt_path: txtPath, source: filePath, reused };
      });
    },
    presentCall: (args: any) => ({ card: "generic", title: "转写", kind: "other", rawInput: args.index !== undefined ? `#${args.index}` : args.local_file }),
  }));

  // ---------------- 智能处理流水线 ----------------

  const llmService = () => (ctx as any).llm ?? {
    stream: () => { throw new Error("LLM 服务不可用（插件需注入 llm 服务）"); },
  };

  // 幂等去重：autoProcess 与 dirWatch 可能命中同一文件，短时间不重复处理
  const recentlyProcessed = new Set<string>();
  const runAutoProcess = (audioPath: string, mode: ProcessMode = "meeting") => {
    const real = path.resolve(audioPath);
    if (recentlyProcessed.has(real)) {
      console.error("[recorder] 跳过重复处理:", audioPath);
      return Promise.resolve({
        degraded: true, title: "", mdPath: null, txtPath: audioPath, audioPath,
        error: "已处理过（去重跳过）",
      } as Awaited<ReturnType<typeof processFile>>);
    }
    recentlyProcessed.add(real);
    setTimeout(() => recentlyProcessed.delete(real), 60_000);
    return processFile({
      audioPath,
      transcribe: (p) => asr.transcribeFile(p, asrOpts),
      llm: llmService(),
      route: { provider: resolved.llmProvider, model: resolved.llmModel },
      mode,
      archiveRoot: resolved.archiveRoot,
    });
  };

  ctx.tools.register(defineTool({
    name: "recorder_process",
    description: "智能处理录音：转写 → LLM 生成会议纪要/课堂笔记 → 归档到日期目录。参数：index（设备文件，自动下载）或 local_file（输出目录内文件）；mode=meeting/note（会议纪要/课堂笔记）。返回归档路径、主题与是否降级（LLM 不可用时保留转写）。",
    parameters: {
      index: { type: "integer", description: "设备文件序号（与 local_file 二选一）" },
      local_file: { type: "string", description: "输出目录内的音频文件名（与 index 二选一）" },
      mode: { type: "string", enum: ["meeting", "note"], description: "meeting 会议纪要 / note 课堂笔记，默认 meeting" },
    },
    output: output({
      type: "object", additionalProperties: false,      properties: {
        degraded: { type: "boolean", required: true },
        title: { type: "string", required: true },
        md_path: { type: "string" },
        txt_path: { type: "string", required: true },
        audio_path: { type: "string", required: true },
        mode: { type: "string", required: true },
        error: { type: "string" },
      },
    }),
    async execute(args: any) {
      const mode: ProcessMode = args.mode === "note" ? "note" : "meeting";
      return withBusy(async () => {
        let audioPath: string | null = null;
        if (args.index !== undefined) {
          const entry = entryByIndex(args.index);
          const existing = recorder.findLocalFile(entry);
          if (existing) {
            audioPath = existing;
          } else {
            requireConnected();
            audioPath = (await recorder.download(entry)).path;
          }
        } else if (args.local_file) {
          const name = path.basename(String(args.local_file));
          const p = path.join(resolved.outputDir, name);
          const fsMod = await import("node:fs");
          if (!fsMod.existsSync(p)) {
            throw new HarnessError("本地文件不存在", "RECORDER_BAD_ARGS");
          }
          audioPath = p;
        } else {
          throw new HarnessError("index 或 local_file 必须提供一个", "RECORDER_BAD_ARGS");
        }
        if (audioPath === null) {
          throw new HarnessError("无法定位音频文件", "RECORDER_BAD_ARGS");
        }
        const result = await runAutoProcess(audioPath, mode);
        return {
          degraded: result.degraded,
          title: result.title,
          md_path: result.mdPath,
          txt_path: result.txtPath,
          audio_path: result.audioPath,
          mode,
          ...(result.error ? { error: result.error } : {}),
        };
      });
    },
    presentCall: (args: any) => ({ card: "generic", title: "智能处理录音", kind: "execute", rawInput: args.local_file ?? `#${args.index}` }),
  }));

  // 可选：轮询监听下载目录，新音频自动处理
  let watcherStop: (() => void) | null = null;
  if (resolved.dirWatch) {
    watcherStop = startWatcher(resolved.outputDir, {
      onNew: (name) => {
        const full = path.join(resolved.outputDir, name);
        runAutoProcess(full).catch((e) => {
          console.error("[recorder] dirWatch 处理失败:", (e as Error).message);
        });
      },
    });
  }

  // 生命周期：卸载时断开
  ctx.on("dispose", () => {
    watcherStop?.();
    recorder.disconnect().catch(() => {});
    if (transport instanceof PythonBridgeTransport) {
      transport.stop().catch(() => {});
    }
  });
}

export default { name, inject, Config, apply };
