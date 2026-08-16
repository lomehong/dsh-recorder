/** 高层设备逻辑：请求/应答匹配、文件列表组装、下载会话、实时音频与录音控制。

超时与兼容策略（协议第 9 节）：
    - 列表无 CMD=18：收到数据后空闲约 1.2 秒 best-effort 收尾
    - 文件下载无数据：空闲约 12 秒判定超时；received=0 可换候选名
    - 传输中断且已有数据：不自动换文件名
    - 主动取消：发送 2-7，清理定时器与 Promise
    - 旧固件删除命令可能不回应答，等待超时按“已发送”处理
    - 应答可能从 AE22 或 AE23 任一特征到达（真机观察：电量 0-4 经 AE23），
      waiter 按 (type, cmd) 匹配不区分来源；无匹配 waiter 的帧作为设备事件上报
*/

import * as fs from "node:fs";
import * as path from "node:path";
import type { BleTransport, ScanDevice } from "./transport.js";
import * as P from "./protocol.js";

export const CMD_TIMEOUT = 5000;
export const LIST_IDLE_TIMEOUT = 1200;
export const DOWNLOAD_IDLE_TIMEOUT = 12000;
export const DELETE_RESP_TIMEOUT = 3000;

export class RecorderError extends Error {}
export class FileNotFoundOnDevice extends RecorderError {}

export interface DownloadResult {
  filename: string;         // 实际成功的请求文件名
  data: Buffer;             // 完整文件字节
  path: string | null;      // 写盘路径
  isWav: boolean;
  wavInfo: P.WavInfo | null;
  deviceName: string;       // 2-3 帧中设备回报的实际导入文件名
}

export type RealtimeEvent =
  | { kind: "filename"; value: string }
  | { kind: "audio"; value: Buffer }
  | { kind: "state"; value: number }
  | { kind: "error"; value: string };

interface RealtimeSession {
  filename: string;
  received: number;
  path: string | null;
  textPath: string | null;
  stream: fs.WriteStream | null;
}

interface Waiter {
  resolve: (frame: P.Frame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const key = (type: number, cmd: number | null) => `${type}:${cmd}`;

/** CB08 录音笔高层封装。 */
export class Recorder {
  transport: BleTransport;
  outputDir: string;

  private seq = new P.SeqGenerator();
  private parserMain = new P.FrameParser("AE22");
  private parserKey = new P.FrameParser("AE23");
  private waiters = new Map<string, Waiter>();

  // 文件列表组装状态
  private listEntries: P.FileEntry[] = [];
  private listResolve: ((v: P.FileEntry[]) => void) | null = null;
  private listIdleTimer: NodeJS.Timeout | null = null;

  // 下载会话状态
  private dlActive = false;
  private dlStarted = false;
  private dlDeviceName = "";
  private dlBuf: Buffer[] = [];
  private dlBytes = 0;
  private dlResolve: ((v: Buffer) => void) | null = null;
  private dlReject: ((e: Error) => void) | null = null;
  private dlIdleTimer: NodeJS.Timeout | null = null;
  private dlExpected = 0;
  private dlLastReport = 0;

  // 实时会话
  private rt: RealtimeSession | null = null;

  onProgress: ((received: number, expected: number) => void) | null = null;
  onRealtime: ((event: RealtimeEvent) => void) | null = null;
  onDeviceEvent: ((frame: P.Frame) => void) | null = null;

  constructor(transport: BleTransport, outputDir = "downloads") {
    this.transport = transport;
    this.outputDir = outputDir;
    transport.onMain = (chunk) => this.feedMain(chunk);
    transport.onKey = (chunk) => this.feedKey(chunk);
    transport.onDisconnect = () => this.cleanupSessions(new RecorderError("设备已断开"));
  }

  // ============================================================ 帧收发

  private dispatch(parser: P.FrameParser, chunk: Uint8Array, source: string): void {
    // Node 回调均在主事件循环；同步分发。CRC 错误时丢弃损坏帧并继续解析剩余缓冲。
    for (;;) {
      try {
        for (const frame of parser.feed(chunk)) this.handleFrame(frame, source);
        return;
      } catch (error) {
        if (error instanceof P.CrcError) {
          // 已从缓冲中移除坏 MAGIC，继续用空 chunk 重入以解析剩余好帧
          chunk = new Uint8Array(0);
        } else {
          throw error;
        }
      }
    }
  }

  feedMain(chunk: Uint8Array): void {
    this.dispatch(this.parserMain, chunk, "AE22");
  }

  feedKey(chunk: Uint8Array): void {
    this.dispatch(this.parserKey, chunk, "AE23");
  }

  private handleFrame(frame: P.Frame, source: string): void {
    if (frame.isAck) return;

    // 下载会话专用帧优先处理
    if (frame.type === P.TYPE_FILE && this.dlActive &&
        (frame.cmd === P.FILE_IMPORT_START || frame.cmd === P.FILE_DATA ||
         frame.cmd === P.FILE_IMPORT_END)) {
      this.handleDownloadFrame(frame);
      return;
    }

    // 文件列表帧
    if (frame.type === P.TYPE_FILE && frame.cmd === P.FILE_LIST_DATA) {
      this.handleListFrame(frame);
      return;
    }
    if (frame.type === P.TYPE_FILE && frame.cmd === P.FILE_LIST_DONE) {
      this.finishList();
      return;
    }

    // 实时音频帧
    if (frame.type === P.TYPE_REALTIME) {
      this.handleRealtimeFrame(frame);
      return;
    }

    // 文件数据帧但无下载会话：警告并丢弃，避免误报设备事件
    if (frame.type === P.TYPE_FILE && frame.cmd === P.FILE_DATA) {
      return;
    }

    // 一次性请求应答：按 (type, cmd) 匹配，不区分来源特征
    const waiter = this.waiters.get(key(frame.type, frame.cmd));
    if (waiter) {
      this.waiters.delete(key(frame.type, frame.cmd));
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }

    // 无人等待的帧：视为设备事件（机身按键触发）
    if (this.onDeviceEvent) this.onDeviceEvent(frame);
  }

  private request(type: number, cmd: number, params: Uint8Array, respCmd: number,
                  timeout = CMD_TIMEOUT): Promise<P.Frame> {
    return new Promise<P.Frame>((resolve, reject) => {
      const k = key(type, respCmd);
      const timer = setTimeout(() => {
        this.waiters.delete(k);
        reject(new Error("等待设备应答超时"));
      }, timeout);
      const waiter: Waiter = { resolve, reject, timer };
      this.waiters.set(k, waiter);
      const frame = P.buildCommand(this.seq.next(), type, cmd, params);
      this.transport.writeFrame(frame).catch((err) => {
        this.waiters.delete(k);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async send(type: number, cmd: number, params: Uint8Array = new Uint8Array(0)): Promise<void> {
    await this.transport.writeFrame(P.buildCommand(this.seq.next(), type, cmd, params));
  }

  // ============================================================ 连接管理

  async scan(timeoutMs = 6000, compat = false): Promise<ScanDevice[]> {
    return this.transport.scan(timeoutMs, compat);
  }

  async connect(device: ScanDevice): Promise<void> {
    await this.transport.connect(device);
  }

  async disconnect(): Promise<void> {
    this.cleanupSessions(new RecorderError("连接已断开"));
    await this.transport.disconnect();
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  private cleanupSessions(error: Error): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    if (this.listIdleTimer) { clearTimeout(this.listIdleTimer); this.listIdleTimer = null; }
    if (this.dlIdleTimer) { clearTimeout(this.dlIdleTimer); this.dlIdleTimer = null; }
    if (this.listResolve) { this.listResolve(this.listEntries); this.listResolve = null; }
    if (this.dlReject) { this.dlReject(error); this.dlResolve = null; this.dlReject = null; }
    this.dlActive = false;
    this.closeRealtimeFile();
    this.rt = null;
    this.parserMain.reset();
    this.parserKey.reset();
  }

  // ============================================================ 控制命令

  async syncTime(date = new Date()): Promise<void> {
    const params = P.encodeSyncTime(
      date.getFullYear(), date.getMonth() + 1, date.getDate(),
      date.getHours(), date.getMinutes(), date.getSeconds());
    await this.send(P.TYPE_CONTROL, P.CTRL_SYNC_TIME, params);
  }

  async getBattery(): Promise<number> {
    const frame = await this.request(P.TYPE_CONTROL, P.CTRL_GET_BATTERY, new Uint8Array(0), P.CTRL_BATTERY_RESP);
    return P.decodeBattery(frame.body);
  }

  async getCapacity(): Promise<[number, number]> {
    const frame = await this.request(P.TYPE_CONTROL, P.CTRL_GET_CAPACITY, new Uint8Array(0), P.CTRL_CAPACITY_RESP);
    return P.decodeCapacity(frame.body);
  }

  async getVersion(): Promise<string> {
    const frame = await this.request(P.TYPE_CONTROL, P.CTRL_GET_VERSION, new Uint8Array(0), P.CTRL_VERSION_RESP);
    const nul = frame.body.indexOf(0);
    return Buffer.from(nul >= 0 ? frame.body.subarray(0, nul) : frame.body).toString("latin1");
  }

  async getAuthCode(): Promise<string> {
    const frame = await this.request(P.TYPE_CONTROL, P.CTRL_GET_AUTH, new Uint8Array(0), P.CTRL_AUTH_RESP);
    return frame.body.toString("hex");
  }

  // ============================================================ 文件列表

  async getFileList(timeout = 15000): Promise<P.FileEntry[]> {
    if (this.listResolve) throw new RecorderError("已有列表请求进行中");
    this.listEntries = [];
    const promise = new Promise<P.FileEntry[]>((resolve) => {
      this.listResolve = resolve;
    });
    await this.send(P.TYPE_FILE, P.FILE_LIST_REQ);
    this.armListIdle();
    const timeoutTimer = setTimeout(() => this.finishList(), timeout);
    try {
      return await promise;
    } finally {
      clearTimeout(timeoutTimer);
      this.cancelListIdle();
      this.listResolve = null;
    }
  }

  private handleListFrame(frame: P.Frame): void {
    this.listEntries.push(...P.decodeFileList(frame.body));
    this.armListIdle(); // 每帧刷新空闲收尾计时
  }

  private armListIdle(): void {
    this.cancelListIdle();
    if (this.listResolve) {
      this.listIdleTimer = setTimeout(() => this.finishList(), LIST_IDLE_TIMEOUT);
    }
  }

  private cancelListIdle(): void {
    if (this.listIdleTimer) { clearTimeout(this.listIdleTimer); this.listIdleTimer = null; }
  }

  private finishList(): void {
    this.cancelListIdle();
    if (this.listResolve) {
      const resolve = this.listResolve;
      this.listResolve = null;
      resolve([...this.listEntries]);
    }
  }

  // ============================================================ 文件下载

  async download(entry: P.FileEntry, offset = 0, filename?: string): Promise<DownloadResult> {
    let names: string[];
    if (filename !== undefined || offset > 0) {
      names = [filename ?? entry.candidateNames()[0]!];
    } else {
      names = entry.candidateNames();
    }
    let lastError: Error | null = null;
    for (const name of names) {
      try {
        return await this.downloadOnce(name, entry, offset);
      } catch (error) {
        if (error instanceof FileNotFoundOnDevice) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new RecorderError("全部候选文件名均下载失败");
  }

  async downloadSegment(entry: P.FileEntry, start: number, end: number, filename?: string): Promise<DownloadResult> {
    const name = filename ?? entry.candidateNames()[0]!;
    return this.downloadOnce(name, entry, 0, { start, end });
  }

  private async downloadOnce(filename: string, entry: P.FileEntry, offset: number,
                             segment?: { start: number; end: number }): Promise<DownloadResult> {
    if (this.dlActive) throw new RecorderError("已有下载会话进行中");
    this.dlActive = true;
    this.dlStarted = false;
    this.dlDeviceName = "";
    this.dlBuf = [];
    this.dlBytes = 0;
    this.dlExpected = filename.toLowerCase().endsWith(".wav")
      ? entry.estimatedWavSize
      : entry.size;
    const promise = new Promise<Buffer>((resolve, reject) => {
      this.dlResolve = resolve;
      this.dlReject = reject;
    });
    try {
      const frame = segment
        ? P.buildSegmentRequest(this.seq.next(), filename, segment.start, segment.end)
        : P.buildImportRequest(this.seq.next(), filename, offset);
      await this.transport.writeFrame(frame, true); // 2-2 整帧单写强制约束
      this.armDownloadIdle();
      const data = await promise;
      const wavInfo = P.inspectWav(data);
      const result: DownloadResult = {
        filename,
        data,
        path: this.saveDownload(filename, entry, data),
        isWav: P.isWav(data),
        wavInfo,
        deviceName: this.dlDeviceName,
      };
      return result;
    } finally {
      this.cancelDownloadIdle();
      this.dlActive = false;
      this.dlResolve = null;
      this.dlReject = null;
    }
  }

  private handleDownloadFrame(frame: P.Frame): void {
    if (frame.cmd === P.FILE_IMPORT_START) {
      this.dlStarted = true;
      const nul = frame.body.indexOf(0);
      this.dlDeviceName = Buffer.from(nul >= 0 ? frame.body.subarray(0, nul) : frame.body).toString("utf8");
      this.armDownloadIdle();
    } else if (frame.cmd === P.FILE_DATA) {
      this.dlBuf.push(Buffer.from(frame.body));
      this.dlBytes += frame.body.length;
      this.armDownloadIdle();
      this.reportProgress();
    } else if (frame.cmd === P.FILE_IMPORT_END) {
      this.finishDownload(frame.body.length > 0 ? frame.body[0]! : P.IMPORT_END_STOPPED);
    }
  }

  private reportProgress(): void {
    const now = Date.now();
    if (this.onProgress && now - this.dlLastReport > 200) {
      this.dlLastReport = now;
      this.onProgress(this.dlBytes, this.dlExpected);
    }
  }

  private finishDownload(code: number): void {
    this.cancelDownloadIdle();
    const resolve = this.dlResolve;
    const reject = this.dlReject;
    this.dlResolve = null;
    this.dlReject = null;
    if (!resolve || !reject) return;
    if (code === P.IMPORT_END_OK) {
      resolve(Buffer.concat(this.dlBuf));
    } else if (code === P.IMPORT_END_NOT_FOUND) {
      reject(new FileNotFoundOnDevice("文件不存在（code=1）"));
    } else if (code === P.IMPORT_END_BAD_OFFSET) {
      reject(new RecorderError("offset 过大（code=2），请重置 offset 后重试"));
    } else {
      reject(new RecorderError(
        `导入停止（code=${code}），已接收 ${this.dlBytes}B；不要自动换文件名，可用 offset 续传`));
    }
  }

  private armDownloadIdle(): void {
    this.cancelDownloadIdle();
    if (this.dlActive) {
      this.dlIdleTimer = setTimeout(() => this.downloadIdleTimeout(), DOWNLOAD_IDLE_TIMEOUT);
    }
  }

  private cancelDownloadIdle(): void {
    if (this.dlIdleTimer) { clearTimeout(this.dlIdleTimer); this.dlIdleTimer = null; }
  }

  private downloadIdleTimeout(): void {
    const resolve = this.dlResolve;
    const reject = this.dlReject;
    this.dlResolve = null;
    this.dlReject = null;
    if (!resolve || !reject) return;
    if (this.dlBytes === 0) {
      // received=0 可换候选名
      reject(new FileNotFoundOnDevice("下载空闲超时且未收到数据，视为文件名无效"));
    } else {
      reject(new RecorderError(`下载空闲超时，已接收 ${this.dlBytes}B，传输中断`));
    }
  }

  async abortDownload(): Promise<void> {
    try {
      await this.send(P.TYPE_FILE, P.FILE_IMPORT_ABORT);
    } catch {
      // 忽略发送失败
    }
  }

  /** 写盘；同名文件加入 time/size 后缀避免覆盖。 */
  saveDownload(filename: string, entry: P.FileEntry, data: Buffer): string {
    fs.mkdirSync(this.outputDir, { recursive: true });
    let safe = filename.replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/, "");
    let filePath = path.join(this.outputDir, safe);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(safe);
      const stem = path.basename(safe, ext);
      filePath = path.join(this.outputDir, `${stem}_${entry.duration}s_${entry.size}${ext}`);
      let n = 1;
      while (fs.existsSync(filePath)) {
        filePath = path.join(this.outputDir, `${stem}_${entry.duration}s_${entry.size}_${n}${ext}`);
        n++;
      }
    }
    fs.writeFileSync(filePath, data);
    return filePath;
  }

  /** 定位设备文件对应的本地已下载文件，找不到返回 null。 */
  findLocalFile(entry: P.FileEntry): string | null {
    if (!fs.existsSync(this.outputDir)) return null;
    const candidates = entry.candidateNames();
    const stem = candidates[0]!.replace(/\.\w+$/, "");
    const prefix = `${stem}_${entry.duration}s_${entry.size}`;
    for (const name of fs.readdirSync(this.outputDir)) {
      const p = path.join(this.outputDir, name);
      if (!fs.statSync(p).isFile()) continue;
      if (candidates.includes(name) || name === stem) return p;
      if (name.startsWith(prefix) && [".wav", ".opus"].includes(path.extname(name).toLowerCase())) {
        return p;
      }
    }
    return null;
  }

  // ============================================================ 文件删除

  async deleteFile(entry: P.FileEntry): Promise<number | null> {
    try {
      const frame = await this.request(P.TYPE_FILE, P.FILE_DELETE_ONE, entry.raw,
        P.FILE_DELETE_ONE_RESP, DELETE_RESP_TIMEOUT);
      return frame.body.length > 0 ? frame.body[0]! : null;
    } catch (error) {
      if ((error as Error).message.includes("超时")) return null; // 已发送，固件未应答
      throw error;
    }
  }

  async deleteAll(): Promise<number | null> {
    try {
      const frame = await this.request(P.TYPE_FILE, P.FILE_DELETE_ALL, new Uint8Array(0),
        P.FILE_DELETE_ALL_RESP, DELETE_RESP_TIMEOUT);
      return frame.body.length > 0 ? frame.body[0]! : null;
    } catch (error) {
      if ((error as Error).message.includes("超时")) return null;
      throw error;
    }
  }

  // ============================================================ 实时音频

  async realtimeStart(): Promise<void> {
    if (this.rt) throw new RecorderError("实时会话已在进行中");
    this.rt = { filename: "", received: 0, path: null, textPath: null, stream: null };
    await this.send(P.TYPE_REALTIME, P.RT_START);
  }

  async realtimeStop(): Promise<RealtimeSession | null> {
    const session = this.rt;
    try {
      await this.send(P.TYPE_REALTIME, P.RT_STOP);
    } finally {
      this.closeRealtimeFile();
      this.rt = null;
    }
    return session;
  }

  async realtimePause(pause: boolean): Promise<void> {
    await this.send(P.TYPE_REALTIME, P.RT_PAUSE_RESUME, new Uint8Array([pause ? 1 : 0]));
  }

  private handleRealtimeFrame(frame: P.Frame): void {
    const rt = this.rt;
    if (frame.cmd === P.RT_START) {
      // 设备通告本次录音文件名
      const nul = frame.body.indexOf(0);
      const name = Buffer.from(nul >= 0 ? frame.body.subarray(0, nul) : frame.body).toString("utf8");
      if (rt) {
        rt.filename = name;
        this.openRealtimeFile(rt);
      }
      this.onRealtime?.({ kind: "filename", value: name });
    } else if (frame.cmd === P.RT_AUDIO_DATA) {
      if (rt) {
        rt.received += frame.body.length;
        rt.stream?.write(frame.body);
      }
      this.onRealtime?.({ kind: "audio", value: Buffer.from(frame.body) });
    } else if (frame.cmd === P.RT_DEV_STATE) {
      const state = frame.body.length > 0 ? frame.body[0]! : -1;
      this.onRealtime?.({ kind: "state", value: state });
      if (state === 2 && rt) { // 设备端停止
        this.closeRealtimeFile();
        this.rt = null;
      }
    }
  }

  /** 实时音频码流原样保存作为备份（OPUS 系码流）。 */
  private openRealtimeFile(rt: RealtimeSession): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    let base = rt.filename.replace(/[\\/:*?"<>|]/g, "_") ||
      `realtime-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (!base.toLowerCase().endsWith(".opus")) base += ".opus";
    let filePath = path.join(this.outputDir, base);
    let n = 1;
    while (fs.existsSync(filePath)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      filePath = path.join(this.outputDir, `${stem}_${n}${ext}`);
      n++;
    }
    rt.path = filePath;
    rt.textPath = filePath.replace(/\.opus$/, ".txt");
    rt.stream = fs.createWriteStream(filePath);
  }

  private closeRealtimeFile(): void {
    if (this.rt?.stream) {
      this.rt.stream.end();
      this.rt.stream = null;
    }
  }

  // ============================================================ 录音控制

  private keyRequest(cmd: number, respCmd: number, params: Uint8Array = new Uint8Array(0)): Promise<P.Frame> {
    return this.request(P.TYPE_KEY, cmd, params, respCmd);
  }

  async recordStart(): Promise<number> {
    const f = await this.keyRequest(P.KEY_REC_START, P.KEY_REC_START_RESP);
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  async recordSave(): Promise<number> {
    const f = await this.keyRequest(P.KEY_REC_SAVE, P.KEY_REC_SAVE_RESP);
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  async recordPause(): Promise<number> {
    const f = await this.keyRequest(P.KEY_REC_PAUSE, P.KEY_REC_PAUSE_RESP);
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  async recordResume(): Promise<number> {
    const f = await this.keyRequest(P.KEY_REC_RESUME, P.KEY_REC_RESUME_RESP);
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  async recordState(): Promise<number> {
    const f = await this.keyRequest(P.KEY_GET_STATE, P.KEY_STATE_RESP);
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  async recordTime(): Promise<[number, number]> {
    const f = await this.keyRequest(P.KEY_GET_TIME, P.KEY_TIME_RESP);
    return P.decodeRecordTime(f.body);
  }

  async recordFilename(): Promise<string> {
    const f = await this.keyRequest(P.KEY_GET_FILENAME, P.KEY_FILENAME_RESP);
    const nul = f.body.indexOf(0);
    return Buffer.from(nul >= 0 ? f.body.subarray(0, nul) : f.body).toString("utf8");
  }

  async getGain(): Promise<number> {
    const f = await this.keyRequest(P.KEY_GET_GAIN, P.KEY_GAIN_RESP);
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  async setGain(level: number): Promise<number> {
    if (![1, 2, 3].includes(level)) throw new RecorderError("增益取值 1~3");
    const f = await this.keyRequest(P.KEY_SET_GAIN, P.KEY_SET_GAIN_RESP, new Uint8Array([level]));
    return f.body.length > 0 ? f.body[0]! : -1;
  }

  // ============================================================ 原始命令

  async sendRawCommand(type: number, cmd: number, params: Uint8Array = new Uint8Array(0)): Promise<void> {
    await this.send(type, cmd, params);
  }

  async sendRawFrame(frame: Uint8Array): Promise<void> {
    await this.transport.writeFrame(Buffer.from(frame), true);
  }
}
