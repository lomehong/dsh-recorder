/** QS668/CB08 录音笔 BLE 通讯协议层（Node/TS 移植，行为与 Python 参考实现一致）。

通用帧格式（协议第 3 节）：
    [0]   MAGIC   1B  固定 0x5A
    [1]   SEQ     1B  0~255 循环递增
    [2:4] CRC     2B  LE, CRC-16/XMODEM(LEN原始2B + DATA)
    [4:6] LEN     2B  LE, DATA 真实字节数
    [6:]  DATA    LEN [TYPE:1B][CMD:1B][PARAMS...]；ACK 可仅含 TYPE

字节序：帧头 LEN/CRC 为小端；文件列表 count/time/size 为大端。
*/

export const MAGIC = 0x5a;
export const HEADER_LEN = 6;
export const MAX_DATA_LEN = 8192; // LEN 字段合理上限，超出视为假帧头（参考厂家测试页）

// ---------------------------------------------------------------- DATA 类型
export const TYPE_CONTROL = 0;   // 控制命令：时间、电量、容量、固件、授权码
export const TYPE_REALTIME = 1;  // 实时音频 / 转写
export const TYPE_FILE = 2;      // 文件操作
export const TYPE_KEY = 3;       // 按键 / 录音控制

// --------------------------------------------------------- 控制命令 TYPE=0
export const CTRL_SYNC_TIME = 0;
export const CTRL_GET_CAPACITY = 1;
export const CTRL_CAPACITY_RESP = 2;
export const CTRL_GET_BATTERY = 3;
export const CTRL_BATTERY_RESP = 4;
export const CTRL_GET_VERSION = 10;
export const CTRL_VERSION_RESP = 11;
export const CTRL_GET_AUTH = 12;
export const CTRL_AUTH_RESP = 13;

export const BATTERY_CHARGING = 110;

// ----------------------------------------------------- 实时音频命令 TYPE=1
export const RT_START = 0;
export const RT_AUDIO_DATA = 1;
export const RT_STOP = 2;
export const RT_PAUSE_RESUME = 3;
export const RT_DEV_STATE = 4;

// --------------------------------------------------------- 文件命令 TYPE=2
export const FILE_LIST_REQ = 0;
export const FILE_LIST_DATA = 1;
export const FILE_IMPORT_REQ = 2;
export const FILE_IMPORT_START = 3;
export const FILE_DATA = 4;
export const FILE_IMPORT_END = 5;
export const FILE_IMPORT_ABORT = 7;
export const FILE_DELETE_ONE = 8;
export const FILE_DELETE_ALL = 9;
export const FILE_DELETE_ALL_RESP = 10;
export const FILE_ABORT_RESP = 11;
export const FILE_IMPORT_SEG = 12;
export const FILE_DELETE_ONE_RESP = 13;
export const FILE_LIST_DONE = 18;

// 导入结束状态码（2-5）
export const IMPORT_END_OK = 0;
export const IMPORT_END_NOT_FOUND = 1;
export const IMPORT_END_BAD_OFFSET = 2;
export const IMPORT_END_STOPPED = 3;

// --------------------------------------------------- 按键/录音控制 TYPE=3
export const KEY_REC_START = 1;
export const KEY_REC_START_RESP = 2;
export const KEY_REC_SAVE = 3;
export const KEY_REC_SAVE_RESP = 4;
export const KEY_REC_PAUSE = 5;
export const KEY_REC_PAUSE_RESP = 6;
export const KEY_REC_RESUME = 7;
export const KEY_REC_RESUME_RESP = 8;
export const KEY_GET_STATE = 19;
export const KEY_STATE_RESP = 20;
export const KEY_GET_TIME = 21;
export const KEY_TIME_RESP = 22;
export const KEY_GET_FILENAME = 23;
export const KEY_FILENAME_RESP = 24;
export const KEY_GET_GAIN = 25;
export const KEY_GAIN_RESP = 26;
export const KEY_SET_GAIN = 27;
export const KEY_SET_GAIN_RESP = 28;

export const FILENAME_FIELD_LEN = 24;
export const LIST_NAME_LEN = 20;
export const LIST_ENTRY_LEN = 28;

// ================================================================ CRC-16/XMODEM

const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[i] = crc;
  }
  return table;
})();

/** CRC-16/XMODEM：输入为帧头 LEN 原始 2 字节 + DATA（不含 MAGIC/SEQ/CRC）。 */
export function crc16Xmodem(data: Uint8Array, crc = 0): number {
  for (const byte of data) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ byte) & 0xff]!;
  }
  return crc;
}

// ================================================================ 帧构造

export class SeqGenerator {
  private seq = -1;
  next(): number {
    this.seq = (this.seq + 1) & 0xff;
    return this.seq;
  }
}

/** 构造完整协议帧：MAGIC + SEQ + CRC(LE) + LEN(LE) + DATA。 */
export function buildFrame(seq: number, data: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16LE(data.length);
  const crc = crc16Xmodem(Buffer.concat([length, data]));
  const frame = Buffer.allocUnsafe(HEADER_LEN + data.length);
  frame[0] = MAGIC;
  frame[1] = seq & 0xff;
  frame.writeUInt16LE(crc, 2);
  frame.writeUInt16LE(data.length, 4);
  Buffer.from(data).copy(frame, HEADER_LEN);
  return frame;
}

/** 构造 DATA=[TYPE][CMD][PARAMS...] 的命令帧。 */
export function buildCommand(seq: number, type: number, cmd: number, params: Uint8Array = new Uint8Array(0)): Buffer {
  const data = Buffer.allocUnsafe(2 + params.length);
  data[0] = type & 0xff;
  data[1] = cmd & 0xff;
  Buffer.from(params).copy(data, 2);
  return buildFrame(seq, data);
}

/** 0-0 同步时间参数：year:2B LE + month/day/hour/minute/second 各1B。 */
export function encodeSyncTime(year: number, month: number, day: number, hour: number, minute: number, second: number): Buffer {
  const buf = Buffer.allocUnsafe(7);
  buf.writeUInt16LE(year, 0);
  buf[2] = month;
  buf[3] = day;
  buf[4] = hour;
  buf[5] = minute;
  buf[6] = second;
  return buf;
}

/** 将文件名编码为固定 24B 字段，NUL 填充；超长截断。 */
export function encodeFilename24(name: string): Buffer {
  const raw = Buffer.from(name, "utf8").subarray(0, FILENAME_FIELD_LEN);
  const out = Buffer.alloc(FILENAME_FIELD_LEN);
  raw.copy(out);
  return out;
}

/** 构造 2-2 文件导入请求帧（完整 36B，必须一次 GATT 写入）。 */
export function buildImportRequest(seq: number, filename: string, offset = 0): Buffer {
  const params = Buffer.allocUnsafe(4 + FILENAME_FIELD_LEN);
  params.writeUInt32LE(offset, 0);
  encodeFilename24(filename).copy(params, 4);
  return buildCommand(seq, TYPE_FILE, FILE_IMPORT_REQ, params);
}

/** 构造 2-12 分段导入请求帧：start:4B LE + end:4B LE + filename。 */
export function buildSegmentRequest(seq: number, filename: string, start: number, end: number): Buffer {
  const params = Buffer.allocUnsafe(8 + FILENAME_FIELD_LEN);
  params.writeUInt32LE(start, 0);
  params.writeUInt32LE(end, 4);
  encodeFilename24(filename).copy(params, 8);
  return buildCommand(seq, TYPE_FILE, FILE_IMPORT_SEG, params);
}

// ================================================================ 帧解析

/** 解析后的一个完整协议帧。 */
export class Frame {
  constructor(
    public readonly seq: number,
    public readonly data: Buffer,
  ) {}

  get type(): number {
    return this.data[0]!;
  }

  get cmd(): number | null {
    // DATA 仅含 TYPE 一个字节时按 ACK 处理，无 CMD
    return this.data.length >= 2 ? this.data[1]! : null;
  }

  get isAck(): boolean {
    return this.data.length === 1;
  }

  /** TYPE、CMD 之后的参数/载荷字节。 */
  get body(): Buffer {
    return this.data.length >= 2 ? this.data.subarray(2) : Buffer.alloc(0);
  }
}

export class CrcError extends Error {
  constructor(
    public readonly source: string,
    public readonly seq: number,
    public readonly raw: Buffer,
  ) {
    super(`CRC mismatch on ${source || "stream"} seq=${seq}: ${raw.toString("hex")}`);
  }
}

/**
 * 流式帧解析器。
 * AE22 与 AE23 必须各用一个独立实例，避免两个通知特征的字节交织破坏半帧。
 * 一个通知可能含半帧，也可能含多帧。
 */
export class FrameParser {
  private buf = Buffer.alloc(0);
  crcErrors = 0;

  constructor(public readonly name = "") {}

  /** 喂入一段通知字节，产出所有可完整解析的帧。 */
  *feed(chunk: Uint8Array): Generator<Frame> {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    while (true) {
      const frame = this.tryParseOne();
      if (frame === null) return;
      yield frame;
    }
  }

  private tryParseOne(): Frame | null {
    // 丢弃 MAGIC 之前的噪声字节
    let offset = 0;
    while (offset < this.buf.length && this.buf[offset] !== MAGIC) offset++;
    if (offset > 0) this.buf = this.buf.subarray(offset);
    if (this.buf.length < HEADER_LEN) return null;
    const seq = this.buf[1]!;
    const crcRecv = this.buf.readUInt16LE(2);
    const length = this.buf.readUInt16LE(4);
    if (length > MAX_DATA_LEN) {
      // LEN 异常：当前 MAGIC 是假帧头，跳一字节重同步
      this.buf = this.buf.subarray(1);
      return this.tryParseOne();
    }
    if (this.buf.length < HEADER_LEN + length) return null; // 等待后续通知补齐
    const data = Buffer.from(this.buf.subarray(HEADER_LEN, HEADER_LEN + length));
    const crcCalc = crc16Xmodem(Buffer.concat([this.buf.subarray(4, 6), data]));
    if (crcCalc !== crcRecv) {
      this.crcErrors++;
      const bad = Buffer.from(this.buf.subarray(0, HEADER_LEN + length));
      this.buf = this.buf.subarray(1);
      throw new CrcError(this.name, seq, bad);
    }
    this.buf = this.buf.subarray(HEADER_LEN + length);
    if (length === 0) return this.tryParseOne(); // 空 DATA 帧无意义，继续
    return new Frame(seq, data);
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

// ================================================================ 字段解码

export interface FileEntryOptions {
  duration: number;
  size: number;
  name: string;
  raw?: Buffer;
}

/** 文件列表条目（7.1 节，28B，整数按大端）。 */
export class FileEntry {
  duration: number;
  size: number;
  name: string;
  raw: Buffer;

  constructor(opts: FileEntryOptions) {
    this.duration = opts.duration;
    this.size = opts.size;
    this.name = opts.name;
    this.raw = opts.raw ?? Buffer.alloc(0);
  }

  /** 下载候选文件名：优先 base.wav，其次 base.opus，最后原始截断名。 */
  candidateNames(): string[] {
    let base = this.name.replace(/\.+$/, ""); // rstrip(".")
    // 截断名形如 note20260710-162938. —— 需重建扩展名
    for (const ext of [".wav", ".opus", ".mp3"]) {
      if (base.toLowerCase().endsWith(ext)) {
        base = base.slice(0, -ext.length);
        break;
      }
    }
    return [base + ".wav", base + ".opus", this.name];
  }

  /** WAV 进度估算：时长 × 32000 B/s + 44（16kHz/16bit/mono）。 */
  get estimatedWavSize(): number {
    return this.duration * 32000 + 44;
  }
}

/** 解码 2-1 文件列表帧 body：count:4B BE + N×28B 条目。 */
export function decodeFileList(body: Uint8Array): FileEntry[] {
  const buf = Buffer.from(body);
  if (buf.length < 4) return [];
  const count = buf.readUInt32BE(0);
  const entries: FileEntry[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    if (offset + LIST_ENTRY_LEN > buf.length) break; // 帧内条目不足声明数量，保守截止
    const raw = buf.subarray(offset, offset + LIST_ENTRY_LEN);
    const duration = raw.readUInt32BE(0);
    const size = raw.readUInt32BE(4);
    const nameBytes = raw.subarray(8, 8 + LIST_NAME_LEN);
    const nul = nameBytes.indexOf(0);
    const name = Buffer.from(nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes)
      .toString("utf8");
    entries.push(new FileEntry({ duration, size, name, raw: Buffer.from(raw) }));
    offset += LIST_ENTRY_LEN;
  }
  return entries;
}

/** 解码 0-2 容量应答：remain:4B LE + total:4B LE，单位按 1KB 显示。 */
export function decodeCapacity(body: Uint8Array): [number, number] {
  const buf = Buffer.from(body);
  return [buf.readUInt32LE(0), buf.readUInt32LE(4)];
}

/** 解码 0-4 电量应答：0~100，110 表示充电中。 */
export function decodeBattery(body: Uint8Array): number {
  return body[0]!;
}

/** 解码 3-22 录音时间应答：duration:2B LE + currentSize:4B LE。 */
export function decodeRecordTime(body: Uint8Array): [number, number] {
  const buf = Buffer.from(body);
  return [buf.readUInt16LE(0), buf.readUInt32LE(2)];
}

export interface WavInfo {
  ok: boolean;        // RIFF/WAVE 头有效且声明长度等于实际长度
  declared: number;   // RIFF 声明总长（含8B头）
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/** 校验 WAV：RIFF/WAVE 魔数、声明长度与实际长度一致，并提取音频参数。 */
export function inspectWav(data: Uint8Array): WavInfo {
  const buf = Buffer.from(data);
  if (buf.length < 44 || buf.subarray(0, 4).toString("latin1") !== "RIFF" ||
      buf.subarray(8, 12).toString("latin1") !== "WAVE") {
    return { ok: false, declared: 0, channels: 0, sampleRate: 0, bitsPerSample: 0 };
  }
  const declared = buf.readUInt32LE(4) + 8;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  return { ok: declared === buf.length, declared, channels, sampleRate, bitsPerSample: bits };
}

/** 校验 WAV 头：bytes[0:4]=RIFF 且 bytes[8:12]=WAVE。 */
export function isWav(data: Uint8Array): boolean {
  const buf = Buffer.from(data);
  return buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WAVE";
}

// 列表 time 字段启发式：个别固件用绝对时间戳而非时长（7.1 节）
const TS_MIN = 946684800;   // 2000-01-01
const TS_MAX = 4102444800;  // 2100-01-01

/** 判断列表 time 字段是否更像 Unix 时间戳而非录音时长。 */
export function isEpochTimestamp(value: number): boolean {
  return value > TS_MIN && value < TS_MAX;
}
