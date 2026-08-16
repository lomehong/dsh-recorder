/** BLE 传输抽象：扫描、连接、Notify 订阅与 AE21 写入。

协议第 2 节：
    Service        0xAE20  录音笔业务服务
    Characteristic 0xAE21  WRITE_WITHOUT_RESPONSE  App→Dev 协议帧
    Characteristic 0xAE22  NOTIFY  Dev→App 控制应答、音频、列表、文件数据
    Characteristic 0xAE23  NOTIFY  Dev→App 机身按键及录音状态消息

关键约束：2-2 文件导入请求帧（36B）必须一次 GATT 写入，
不允许分包器拆分（拆成 20+16 会稳定返回“文件不存在”）。
*/

export const SERVICE_UUID = "0000ae20-0000-1000-8000-00805f9b34fb";
export const CHAR_WRITE = "0000ae21-0000-1000-8000-00805f9b34fb";
export const CHAR_NOTIFY_MAIN = "0000ae22-0000-1000-8000-00805f9b34fb";
export const CHAR_NOTIFY_KEY = "0000ae23-0000-1000-8000-00805f9b34fb";

export const DEFAULT_CHUNK = 20; // 未协商 MTU 时的保守单包载荷
export const MTU_TARGET = 247;  // 主动协商目标：36B 整帧单写需要 MTU ≥ 39

export const DEVICE_NAME_KEYWORDS = ["cb08", "qs668"];

export interface ScanDevice {
  name: string;
  address: string;
  /** 底层对象句柄（noble peripheral 等），连接时原样传回。 */
  handle?: unknown;
}

export interface BleTransportEvents {
  /** AE22 原始通知字节 */
  onMain?: (chunk: Uint8Array) => void;
  /** AE23 原始通知字节 */
  onKey?: (chunk: Uint8Array) => void;
  onDisconnect?: () => void;
}

/** BLE 传输层抽象。实现必须保证 onMain/onKey 回调可被任意线程调用（上层负责调度）。 */
export interface BleTransport extends BleTransportEvents {
  readonly isConnected: boolean;
  readonly mtu: number;
  /** 常规命令的单次写入载荷上限：MTU-3。 */
  readonly payloadSize: number;
  scan(timeoutMs?: number, compat?: boolean): Promise<ScanDevice[]>;
  connect(device: ScanDevice): Promise<void>;
  disconnect(): Promise<void>;
  /** atomic=true 用于 2-2 等必须整帧单写的命令，超限直接报错而不是拆分。 */
  writeFrame(frame: Uint8Array, atomic?: boolean): Promise<void>;
}

// ================================================================ 模拟传输

export type SimResponseHandler = (type: number, cmd: number, body: Buffer) => Buffer[];

/** 内存模拟设备：单元测试与无硬件演示用。handler 返回应答帧的 DATA 列表。 */
export class SimulatedTransport implements BleTransport {
  onMain?: (chunk: Uint8Array) => void;
  onKey?: (chunk: Uint8Array) => void;
  onDisconnect?: () => void;

  private _connected = false;
  private seq = 0;
  /** 记录被要求整帧单写的帧 */
  atomicFrames: Buffer[] = [];

  constructor(
    public readonly devices: ScanDevice[],
    private handler: SimResponseHandler,
    public readonly mtuValue = 247,
    private chunkSize = 20,
  ) {}

  get isConnected(): boolean {
    return this._connected;
  }

  get mtu(): number {
    return this.mtuValue;
  }

  get payloadSize(): number {
    return Math.max(this.mtuValue - 3, DEFAULT_CHUNK);
  }

  async scan(timeoutMs = 6000, _compat = false): Promise<ScanDevice[]> {
    return this.devices;
  }

  async connect(_device: ScanDevice): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    this.onDisconnect?.();
  }

  async writeFrame(frame: Uint8Array, atomic = false): Promise<void> {
    if (!this._connected) throw new Error("BLE 未连接");
    const buf = Buffer.from(frame);
    if (atomic) this.atomicFrames.push(buf);
    const data = buf.subarray(6);
    const type = data[0]!;
    const cmd = data[1]!;
    const body = data.subarray(2);
    for (const respData of this.handler(type, cmd, body) ?? []) {
      this.seq = (this.seq + 1) & 0xff;
      const { buildFrame } = await import("./protocol.js");
      const resp = buildFrame(this.seq, respData);
      // 模拟 BLE 通知分片
      for (let i = 0; i < resp.length; i += this.chunkSize) {
        this.onMain?.(resp.subarray(i, i + this.chunkSize));
      }
    }
  }

  /** 测试辅助：直接向 AE23 注入一帧（设备事件）。 */
  feedKeyFrame(frame: Uint8Array): void {
    this.onKey?.(Buffer.from(frame));
  }
}

// ================================================================ noble 适配器

type NoblePeripheral = {
  id: string;
  address: string;
  connectable?: boolean;
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverSomeServicesAndCharacteristicsAsync(
    services: string[],
    characteristics: string[],
  ): Promise<{ characteristics: NobleCharacteristic[] }>;
};

type NobleCharacteristic = {
  uuid: string;
  subscribeAsync(): Promise<void>;
  unsubscribeAsync(): Promise<void>;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  on(event: "data", listener: (data: Buffer) => void): void;
};

/**
 * @abandonware/noble 适配器。
 * 平台支持：Linux（BlueZ）、macOS（CoreBluetooth）、Windows（需 USB BLE 适配器
 * + WinUSB 驱动，实验性）。连接成功后先尽力协商 MTU，再订阅 AE22/AE23。
 */
export class NobleTransport implements BleTransport {
  onMain?: (chunk: Uint8Array) => void;
  onKey?: (chunk: Uint8Array) => void;
  onDisconnect?: () => void;

  private noble: any = null;
  private peripheral: NoblePeripheral | null = null;
  private writeChar: NobleCharacteristic | null = null;
  private _mtu = 23;
  private _connected = false;

  private async nobleModule(): Promise<any> {
    if (this.noble !== null) return this.noble;
    try {
      // @ts-expect-error noble is an optional runtime dependency
      this.noble = (await import("@abandonware/noble")).default;
    } catch (error) {
      throw new Error(
        "未安装 @abandonware/noble（BLE 真机传输需要）；npm install @abandonware/noble 后重试",
        { cause: error },
      );
    }
    return this.noble;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get mtu(): number {
    return this._mtu;
  }

  get payloadSize(): number {
    return Math.max(this._mtu - 3, DEFAULT_CHUNK);
  }

  async scan(timeoutMs = 6000, compat = false): Promise<ScanDevice[]> {
    const noble = await this.nobleModule();
    if (noble.state !== "poweredOn") {
      await new Promise<void>((resolve, reject) => {
        noble.once("stateChange", (state: string) =>
          state === "poweredOn" ? resolve() : reject(new Error(`蓝牙状态异常：${state}`)));
      });
    }
    const found: ScanDevice[] = [];
    const onDiscover = (peripheral: NoblePeripheral) => {
      const name = (peripheral as any).advertisement?.localName ?? "";
      const address = (peripheral as any).address ?? peripheral.id;
      const uuids: string[] = (peripheral as any).advertisement?.serviceUuids ?? [];
      if (uuids.some((u) => u.toLowerCase() === SERVICE_UUID) ||
          DEVICE_NAME_KEYWORDS.some((k) => name.toLowerCase().includes(k)) ||
          (compat && name.length > 0)) {
        found.push({ name, address, handle: peripheral });
      }
    };
    noble.on("discover", onDiscover);
    try {
      await noble.startScanningAsync([], compat);
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    } finally {
      await noble.stopScanningAsync().catch(() => {});
      noble.removeListener("discover", onDiscover);
    }
    return found;
  }

  async connect(device: ScanDevice): Promise<void> {
    const peripheral = device.handle as NoblePeripheral;
    if (!peripheral) throw new Error("缺少设备句柄（需使用 scan 返回的设备）");
    this.peripheral = peripheral;
    await peripheral.connectAsync();
    this._connected = true;
    await this.negotiateMtu(peripheral);
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SERVICE_UUID],
      [CHAR_WRITE, CHAR_NOTIFY_MAIN, CHAR_NOTIFY_KEY],
    );
    const find = (uuid: string) =>
      characteristics.find((c) => c.uuid.toLowerCase() === uuid.toLowerCase());
    const writeChar = find(CHAR_WRITE);
    const mainChar = find(CHAR_NOTIFY_MAIN);
    const keyChar = find(CHAR_NOTIFY_KEY);
    if (!writeChar || !mainChar) {
      throw new Error("未发现 AE21/AE22 特征，设备不兼容");
    }
    this.writeChar = writeChar;
    mainChar.on("data", (data: Buffer) => this.onMain?.(data));
    await mainChar.subscribeAsync();
    if (keyChar) {
      keyChar.on("data", (data: Buffer) => this.onKey?.(data));
      await keyChar.subscribeAsync().catch(() => {});
    }
  }

  private async negotiateMtu(peripheral: NoblePeripheral): Promise<void> {
    // noble 在 Linux 上可通过 peripheral.mtu 读取；协商能力有限，尽力读取
    const raw = (peripheral as any).mtu;
    if (typeof raw === "number" && raw > 23) this._mtu = raw;
  }

  async disconnect(): Promise<void> {
    if (!this.peripheral) return;
    const p = this.peripheral;
    this.peripheral = null;
    this._connected = false;
    try {
      await p.disconnectAsync();
    } catch {
      // 已断开则忽略
    }
    this.onDisconnect?.();
  }

  async writeFrame(frame: Uint8Array, atomic = false): Promise<void> {
    if (!this.writeChar) throw new Error("BLE 未连接");
    const limit = this.payloadSize;
    if (frame.length <= limit) {
      await this.writeChar.writeAsync(Buffer.from(frame), true);
      return;
    }
    if (atomic) {
      throw new Error(
        `帧长 ${frame.length}B 超过单写上限 ${limit}B，该命令要求整帧单写，请确认 MTU 协商结果`,
      );
    }
    for (let i = 0; i < frame.length; i += limit) {
      await this.writeChar.writeAsync(Buffer.from(frame.subarray(i, i + limit)), true);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
