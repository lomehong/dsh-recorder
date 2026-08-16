"""BLE 桥接进程：供 dsh-recorder 插件（Node/TypeScript）调用。

Node 侧没有纯 Windows 内置蓝牙方案（noble 需要 USB 适配器 + WinUSB 驱动），
而 Python bleak 在 Windows 上使用 WinRT 后端，可直接使用内置蓝牙适配器。

协议：stdin/stdout 逐行 JSON。
    请求：{"id": n, "op": "...", ...参数}
    响应：{"id": n, "ok": true, ...} 或 {"id": n, "ok": false, "error": "..."}
    事件：{"event": "main"|"key", "data": "hex"} / {"event": "disconnect"}

支持的操作：
    scan  {timeout: 秒, compat: bool}
    connect {address: str}
    disconnect {}
    write {frame: hex, atomic: bool}
    status {}
    stop {}   # 退出进程

依赖：pip install bleak
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

SERVICE_UUID = "0000ae20-0000-1000-8000-00805f9b34fb"
CHAR_WRITE = "0000ae21-0000-1000-8000-00805f9b34fb"
CHAR_NOTIFY_MAIN = "0000ae22-0000-1000-8000-00805f9b34fb"
CHAR_NOTIFY_KEY = "0000ae23-0000-1000-8000-00805f9b34fb"

DEFAULT_CHUNK = 20
MTU_TARGET = 247


class Bridge:
    def __init__(self) -> None:
        self.client: BleakClient | None = None
        self.loop = asyncio.get_running_loop()
        self.scan_cache: dict[str, BLEDevice] = {}

    # ------------------------------------------------------------ 输出

    def respond(self, req_id, **payload) -> None:
        self._write({"id": req_id, **payload})

    def emit(self, event: str, **payload) -> None:
        self._write({"event": event, **payload})

    def _write(self, obj) -> None:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def error(self, req_id, exc: Exception) -> None:
        self.respond(req_id, ok=False, error=str(exc))

    # ------------------------------------------------------------ 操作

    async def scan(self, req_id, timeout: float, compat: bool) -> None:
        found: list[BLEDevice] = []
        try:
            devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
        except Exception as exc:
            self.error(req_id, exc)
            return
        for device, adv in devices.values():
            name = (device.name or adv.local_name or "")
            uuids = [u.lower() for u in (adv.service_uuids or [])]
            if SERVICE_UUID in uuids or "cb08" in name.lower() or "qs668" in name.lower():
                found.append(device)
            elif compat and name:
                found.append(device)
        self.scan_cache = {}
        for d in found:
            self.scan_cache[d.address] = d
        self.respond(req_id, ok=True, devices=[
            {"name": d.name or "", "address": d.address} for d in found
        ])

    async def connect(self, req_id, address: str) -> None:
        if self.client is not None:
            self.error(req_id, RuntimeError("已连接，请先 disconnect"))
            return
        device = self.scan_cache.get(address)
        try:
            client = BleakClient(device or address,
                                 disconnected_callback=self._handle_disconnect)
            await client.connect()
            self.client = client
            await self._negotiate_mtu(client)
            await client.start_notify(CHAR_NOTIFY_MAIN, self._notify_main)
            try:
                await client.start_notify(CHAR_NOTIFY_KEY, self._notify_key)
            except Exception as exc:
                self.emit("log", text=f"AE23 订阅失败（忽略）：{exc}")
        except Exception as exc:
            self.client = None
            self.error(req_id, exc)
            return
        self.respond(req_id, ok=True, mtu=self._mtu(client),
                     payload=self._payload(client))

    async def disconnect(self, req_id=None) -> None:
        client, self.client = self.client, None
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
        if req_id is not None:
            self.respond(req_id, ok=True)

    async def write(self, req_id, frame_hex: str, atomic: bool) -> None:
        if self.client is None:
            self.error(req_id, RuntimeError("BLE 未连接"))
            return
        frame = bytes.fromhex(frame_hex)
        limit = self._payload(self.client)
        if len(frame) <= limit:
            await self.client.write_gatt_char(CHAR_WRITE, frame, response=False)
        elif atomic:
            self.error(req_id, RuntimeError(
                f"帧长 {len(frame)}B 超过单写上限 {limit}B，该命令要求整帧单写，请确认 MTU 协商结果"))
            return
        else:
            for i in range(0, len(frame), limit):
                await self.client.write_gatt_char(
                    CHAR_WRITE, frame[i:i + limit], response=False)
                await asyncio.sleep(0.01)
        self.respond(req_id, ok=True)

    async def status(self, req_id) -> None:
        client = self.client
        self.respond(req_id, ok=True, connected=client is not None,
                     mtu=self._mtu(client), payload=self._payload(client))

    # ------------------------------------------------------------ 辅助

    async def _negotiate_mtu(self, client: BleakClient) -> None:
        set_mtu = getattr(client, "set_mtu", None)
        if set_mtu is None:
            return
        try:
            await set_mtu(MTU_TARGET)
        except Exception:
            pass  # 后端不支持时忽略，退回自动协商结果

    def _mtu(self, client: BleakClient | None) -> int:
        if client is not None:
            try:
                return client.mtu_size
            except Exception:
                pass
        return 23

    def _payload(self, client: BleakClient | None) -> int:
        return max(self._mtu(client) - 3, DEFAULT_CHUNK)

    # ------------------------------------------------------------ 回调

    def _notify_main(self, _sender, data: bytearray) -> None:
        payload = bytes(data).hex()
        self.loop.call_soon_threadsafe(self._emit, "main", payload)

    def _notify_key(self, _sender, data: bytearray) -> None:
        payload = bytes(data).hex()
        self.loop.call_soon_threadsafe(self._emit, "key", payload)

    def _emit(self, event: str, payload: str) -> None:
        # call_soon_threadsafe 只接受位置参数，包装一层再转 emit 的关键字参数
        self.emit(event, data=payload)

    def _handle_disconnect(self, _client) -> None:
        self.client = None
        self.loop.call_soon_threadsafe(self.emit_disconnect)

    def emit_disconnect(self) -> None:
        self.emit("disconnect")


async def run() -> None:
    bridge = Bridge()
    loop = asyncio.get_running_loop()

    def read_stdin() -> None:
        # 阻塞线程逐行读 stdin，调度回事件循环处理
        for raw in sys.stdin:
            text = raw.strip()
            if not text:
                continue
            loop.call_soon_threadsafe(_dispatch, text)

    def _dispatch(text: str) -> None:
        try:
            req = json.loads(text)
        except json.JSONDecodeError as exc:
            bridge.respond(-1, ok=False, error=f"JSON 解析失败：{exc}")
            return
        asyncio.create_task(handle(req))

    async def handle(req: dict) -> None:
        req_id = req.get("id")
        op = req.get("op")
        try:
            if op == "scan":
                await bridge.scan(req_id, float(req.get("timeout", 6)),
                                  bool(req.get("compat", False)))
            elif op == "connect":
                await bridge.connect(req_id, str(req.get("address", "")))
            elif op == "disconnect":
                await bridge.disconnect(req_id)
            elif op == "write":
                await bridge.write(req_id, str(req.get("frame", "")),
                                   bool(req.get("atomic", False)))
            elif op == "status":
                await bridge.status(req_id)
            elif op == "stop":
                bridge.respond(req_id, ok=True)
                sys.exit(0)
            else:
                bridge.respond(req_id, ok=False, error=f"未知操作：{op}")
        except Exception as exc:  # 兜底：任何异常都不让进程崩溃
            try:
                bridge.error(req_id, exc)
            except Exception:
                pass

    threading.Thread(target=read_stdin, daemon=True).start()
    await asyncio.Event().wait()  # 事件循环保持运行


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()