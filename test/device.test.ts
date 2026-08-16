import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as P from "../src/protocol.js";
import { Recorder, FileNotFoundOnDevice, RecorderError } from "../src/device.js";
import { SimulatedTransport, type SimResponseHandler } from "../src/transport.js";

function entryBytes(duration: number, size: number, name: string): Buffer {
  const b = Buffer.allocUnsafe(28);
  b.writeUInt32BE(duration, 0);
  b.writeUInt32BE(size, 4);
  Buffer.from(name).copy(b, 8);
  return b;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-test-"));
}

async function makeRecorder(handler: SimResponseHandler, outputDir: string): Promise<Recorder> {
  const transport = new SimulatedTransport([{ name: "CB08", address: "AA:BB:CC:DD:EE:FF" }], handler);
  const rec = new Recorder(transport, outputDir);
  await rec.connect({ name: "CB08", address: "AA:BB:CC:DD:EE:FF" });
  return rec;
}

test("请求应答匹配：电量", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder((t, c) =>
    t === P.TYPE_CONTROL && c === P.CTRL_GET_BATTERY
      ? [Buffer.from([P.TYPE_CONTROL, P.CTRL_BATTERY_RESP, 85])]
      : [], dir);
  assert.equal(await rec.getBattery(), 85);
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("多帧文件列表 + CMD=18 收尾", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder((t, c) => {
    if (t === P.TYPE_FILE && c === P.FILE_LIST_REQ) {
      const f1 = Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_LIST_DATA]),
        (() => { const h = Buffer.alloc(4); h.writeUInt32BE(1, 0); return h; })(),
        entryBytes(75, 38444, "note20260710-162938.")]);
      const f2 = Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_LIST_DATA]),
        (() => { const h = Buffer.alloc(4); h.writeUInt32BE(1, 0); return h; })(),
        entryBytes(10, 5000, "note20260711-090000.")]);
      return [f1, f2, Buffer.from([P.TYPE_FILE, P.FILE_LIST_DONE, 0])];
    }
    return [];
  }, dir);
  const files = await rec.getFileList(3000);
  assert.deepEqual(files.map((f) => f.name), ["note20260710-162938.", "note20260711-090000."]);
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("列表无 CMD=18 时空闲收尾", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder((t, c) => {
    if (t === P.TYPE_FILE && c === P.FILE_LIST_REQ) {
      return [Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_LIST_DATA]),
        (() => { const h = Buffer.alloc(4); h.writeUInt32BE(1, 0); return h; })(),
        entryBytes(5, 100, "a.")])];
    }
    return [];
  }, dir);
  const files = await rec.getFileList(5000);
  assert.equal(files.length, 1);
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("下载成功 + 2-2 整帧单写 + WAV 校验", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder((t, c, body) => {
    if (t === P.TYPE_FILE && c === P.FILE_IMPORT_REQ) {
      const name = Buffer.from(body.subarray(4)).toString("utf8").split("\0")[0] ?? "";
      const payload = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4),
        Buffer.from("WAVE"), Buffer.alloc(32)]);
      payload.writeUInt32LE(36, 4);
      const chunks: Buffer[] = [];
      for (let i = 0; i < payload.length; i += 16) {
        chunks.push(Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_DATA]), payload.subarray(i, i + 16)]));
      }
      return [
        Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_IMPORT_START]), Buffer.from(name)]),
        ...chunks,
        Buffer.from([P.TYPE_FILE, P.FILE_IMPORT_END, P.IMPORT_END_OK]),
      ];
    }
    return [];
  }, dir);
  const entry = new P.FileEntry({ duration: 1, size: 44, name: "note20260710-162938." });
  const result = await rec.download(entry);
  assert.equal(result.filename, "note20260710-162938.wav");
  assert.ok(result.isWav);
  assert.ok(result.wavInfo?.ok);
  assert.ok(result.path && fs.existsSync(result.path));
  // 2-2 请求帧必须整帧单写且为 36B
  const sim = rec.transport as SimulatedTransport;
  assert.equal(sim.atomicFrames.length, 1);
  assert.equal(sim.atomicFrames[0]!.length, 36);
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("下载候选名回退：.wav code=1 后改试 .opus", async () => {
  const dir = tmpdir();
  const requested: string[] = [];
  const rec = await makeRecorder((t, c, body) => {
    if (t === P.TYPE_FILE && c === P.FILE_IMPORT_REQ) {
      const name = Buffer.from(body.subarray(4)).toString("utf8").split("\0")[0] ?? "";
      requested.push(name);
      if (name.endsWith(".wav")) {
        return [Buffer.from([P.TYPE_FILE, P.FILE_IMPORT_END, P.IMPORT_END_NOT_FOUND])];
      }
      return [
        Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_IMPORT_START]), Buffer.from(name)]),
        Buffer.concat([Buffer.from([P.TYPE_FILE, P.FILE_DATA]), Buffer.from("OPUSDATA")]),
        Buffer.from([P.TYPE_FILE, P.FILE_IMPORT_END, P.IMPORT_END_OK]),
      ];
    }
    return [];
  }, dir);
  const entry = new P.FileEntry({ duration: 1, size: 32, name: "a." });
  const result = await rec.download(entry);
  assert.deepEqual(requested, ["a.wav", "a.opus"]);
  assert.equal(result.data.toString(), "OPUSDATA");
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("续传 offset>0 时 code=1 不换候选名", async () => {
  const dir = tmpdir();
  const requested: string[] = [];
  const rec = await makeRecorder((t, c, body) => {
    if (t === P.TYPE_FILE && c === P.FILE_IMPORT_REQ) {
      requested.push(Buffer.from(body.subarray(4)).toString("utf8").split("\0")[0] ?? "");
      return [Buffer.from([P.TYPE_FILE, P.FILE_IMPORT_END, P.IMPORT_END_NOT_FOUND])];
    }
    return [];
  }, dir);
  const entry = new P.FileEntry({ duration: 1, size: 32, name: "a." });
  await assert.rejects(() => rec.download(entry, 1024), FileNotFoundOnDevice);
  assert.deepEqual(requested, ["a.wav"]);
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AE23 到达的匹配帧也能满足挂起请求（真机行为）", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder(() => [], dir);
  const sim = rec.transport as SimulatedTransport;
  const seen: P.Frame[] = [];
  rec.onDeviceEvent = (f) => seen.push(f);
  const task = rec.recordState();
  await new Promise((r) => setTimeout(r, 10));
  // 应答经 AE23 到达（真机上电量 0-4 即如此）
  sim.feedKeyFrame(P.buildFrame(1, Buffer.from([P.TYPE_KEY, P.KEY_STATE_RESP, 1])));
  const state = await task;
  assert.equal(state, 1);
  assert.equal(seen.length, 0); // 被 waiter 接住，不再作为事件上报
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("删除应答与旧固件无应答兼容", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder((t, c) => {
    if (t === P.TYPE_FILE && c === P.FILE_DELETE_ONE) {
      return [Buffer.from([P.TYPE_FILE, P.FILE_DELETE_ONE_RESP, 0])];
    }
    return []; // 删除全部不回应答
  }, dir);
  const entry = new P.FileEntry({ duration: 1, size: 1, name: "a.", raw: Buffer.alloc(28) });
  assert.equal(await rec.deleteFile(entry), 0);
  assert.equal(await rec.deleteAll(), null); // 超时按已发送处理
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("实时会话：文件名/音频/状态 + 码流备份", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder(() => [], dir);
  const events: { kind: string; value: unknown }[] = [];
  rec.onRealtime = (e) => events.push({ kind: e.kind, value: e.value });
  await rec.realtimeStart();
  // 注入设备帧
  rec.feedMain(P.buildFrame(1, Buffer.concat([Buffer.from([P.TYPE_REALTIME, P.RT_START]),
    Buffer.from("meeting.opus\0")])));
  rec.feedMain(P.buildFrame(2, Buffer.concat([Buffer.from([P.TYPE_REALTIME, P.RT_AUDIO_DATA]),
    Buffer.from("opus-audio")])));
  await new Promise((r) => setTimeout(r, 50));
  // 手动停止：返回会话并关闭备份文件
  const session = await rec.realtimeStop();
  assert.equal(session?.path && fs.existsSync(session.path), true);
  if (session?.path) {
    const data = fs.readFileSync(session.path);
    assert.equal(data.length, Buffer.byteLength("opus-audio"));
    assert.equal(data.toString(), "opus-audio");
  }
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("filename"));
  assert.ok(kinds.includes("audio"));
  assert.ok(!kinds.includes("state"));
  // 设备端停止（state=2）单独验证：会话自动结束
  await rec.realtimeStart();
  rec.feedMain(P.buildFrame(3, Buffer.from([P.TYPE_REALTIME, P.RT_DEV_STATE, 2])));
  await new Promise((r) => setTimeout(r, 20));
  const ended = await rec.realtimeStop();
  assert.equal(ended, null); // 会话已被设备端停止清空
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findLocalFile 复用碰撞后缀文件", async () => {
  const dir = tmpdir();
  const rec = await makeRecorder(() => [], dir);
  const entry = new P.FileEntry({ duration: 9, size: 18640, name: "call20260728-211836." });
  fs.writeFileSync(path.join(dir, "call20260728-211836_9s_18640.wav"), "x");
  const found = rec.findLocalFile(entry);
  assert.equal(found, path.join(dir, "call20260728-211836_9s_18640.wav"));
  const missing = rec.findLocalFile(new P.FileEntry({ duration: 1, size: 1, name: "none0000000000." }));
  assert.equal(missing, null);
  await rec.disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
