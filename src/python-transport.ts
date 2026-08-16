/** Python (bleak/WinRT) BLE 传输适配器。

Windows 内置蓝牙适配器没有可用的纯 Node BLE 方案：@abandonware/noble 在
Windows 上需要 USB BLE 适配器 + WinUSB 驱动，内置蓝牙无法直接使用。
本适配器通过子进程桥接到 Python bleak（Windows 上使用 WinRT 后端），
实现与 NobleTransport 相同的 BleTransport 接口，协议层完全复用。

桥接进程：tools/ble_bridge.py（逐行 JSON over stdin/stdout）。
*/

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import type { BleTransport, ScanDevice } from "./transport.js";

export const DEFAULT_CHUNK = 20;

interface PendingReq {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class PythonBridgeTransport implements BleTransport {
  onMain?: (chunk: Uint8Array) => void;
  onKey?: (chunk: Uint8Array) => void;
  onDisconnect?: () => void;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private lineBuf = "";
  private nextId = 1;
  private pending = new Map<number, PendingReq>();
  private _connected = false;
  private _mtu = 23;
  private lastScan: ScanDevice[] = [];

  constructor(
    /** python 可执行文件 */
    public pythonPath = "python",
    /** 桥接脚本路径；缺省为插件目录下 tools/ble_bridge.py */
    private bridgeScript?: string,
  ) {}

  get isConnected(): boolean {
    return this._connected;
  }

  get mtu(): number {
    return this._mtu;
  }

  get payloadSize(): number {
    return Math.max(this._mtu - 3, DEFAULT_CHUNK);
  }

  /** 懒启动桥接子进程。 */
  private ensureProc(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const script = this.bridgeScript
      ?? path.join(import.meta.dirname, "..", "tools", "ble_bridge.py");
    const proc = spawn(this.pythonPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.lineBuf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      // 桥接进程 stderr 仅用于诊断；不在协议内
      console.error("[recorder-python-bridge]", chunk.trimEnd());
    });
    proc.on("exit", (code) => {
      const err = new Error(`Python 桥接进程退出（code=${code}）`);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this._connected = false;
      this.proc = null;
      this.onDisconnect?.();
    });
    return proc;
  }

  private onStdout(chunk: string): void {
    this.lineBuf += chunk;
    for (;;) {
      const nl = this.lineBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.lineBuf.slice(0, nl).trim();
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event) {
      this.handleEvent(msg);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok === false) {
      pending.reject(new Error(String(msg.error ?? "桥接调用失败")));
    } else {
      pending.resolve(msg);
    }
  }

  private handleEvent(msg: any): void {
    if (msg.event === "main" && typeof msg.data === "string") {
      this.onMain?.(Buffer.from(msg.data, "hex"));
    } else if (msg.event === "key" && typeof msg.data === "string") {
      this.onKey?.(Buffer.from(msg.data, "hex"));
    } else if (msg.event === "disconnect") {
      this._connected = false;
      this.onDisconnect?.();
    }
  }

  /** 发送一个请求并等待应答。 */
  private call(op: string, params: Record<string, unknown> = {}): Promise<any> {
    const proc = this.ensureProc();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`桥接请求 ${op} 超时`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  async scan(timeoutMs = 6000, compat = false): Promise<ScanDevice[]> {
    const resp = await this.call("scan", {
      timeout: timeoutMs / 1000,
      compat: compat === true,
    });
    const devices: ScanDevice[] = (resp.devices ?? []).map((d: any) => ({
      name: String(d.name ?? ""),
      address: String(d.address ?? ""),
    }));
    this.lastScan = devices;
    return devices;
  }

  async connect(device: ScanDevice): Promise<void> {
    const resp = await this.call("connect", { address: device.address });
    this._connected = true;
    this._mtu = Number(resp.mtu) || 23;
  }

  async disconnect(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      try {
        await this.call("disconnect");
      } catch {
        // 忽略断开失败
      }
    }
    this._connected = false;
  }

  async writeFrame(frame: Uint8Array, atomic = false): Promise<void> {
    await this.call("write", {
      frame: Buffer.from(frame).toString("hex"),
      atomic: atomic === true,
    });
  }

  /** 关闭桥接子进程（插件卸载时调用）。 */
  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      try {
        await this.call("stop");
      } catch {
        // 忽略
      }
      try {
        this.proc.kill();
      } catch {
        // 忽略
      }
    }
    this.proc = null;
    this._connected = false;
  }
}