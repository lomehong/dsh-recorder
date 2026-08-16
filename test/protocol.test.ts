import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/protocol.js";

// 7.3 节 2026-07-10 真机成功下载 note20260710-162938.wav 的 TX 帧
const REAL_FRAME = Buffer.from(
  "5a039e201e000202000000006e6f7465" +
  "32303236303731302d3136323933382e" +
  "77617600", "hex");

test("CRC-16/XMODEM 标准检验向量", () => {
  assert.equal(P.crc16Xmodem(Buffer.from("123456789")), 0x31c3);
  assert.equal(P.crc16Xmodem(Buffer.alloc(0)), 0);
});

test("复现 7.3 节真机 36B 下载请求帧", () => {
  const frame = P.buildImportRequest(3, "note20260710-162938.wav", 0);
  assert.equal(frame.length, 36);
  assert.deepEqual(frame, REAL_FRAME);
});

test("帧头小端与 CRC 计算范围", () => {
  const frame = P.buildCommand(0, P.TYPE_CONTROL, P.CTRL_GET_BATTERY);
  assert.equal(frame[0], P.MAGIC);
  assert.equal(frame.readUInt16LE(4), 2); // DATA=[TYPE][CMD]
  assert.equal(frame.readUInt16LE(2), P.crc16Xmodem(frame.subarray(4)));
});

test("文件名 24B NUL 填充", () => {
  const raw = P.encodeFilename24("a.wav");
  assert.equal(raw.length, 24);
  assert.equal(raw.subarray(0, 5).toString(), "a.wav");
  assert.ok(raw.subarray(5).every((b) => b === 0));
});

test("同步时间参数", () => {
  const params = P.encodeSyncTime(2026, 7, 28, 12, 34, 56);
  assert.equal(params.length, 7);
  assert.equal(params.readUInt16LE(0), 2026);
  assert.deepEqual([...params.subarray(2)], [7, 28, 12, 34, 56]);
});

test("流式解析：整帧 / 半帧 / 多帧 / 噪声", () => {
  const parser = new P.FrameParser("t");
  assert.equal([...parser.feed(REAL_FRAME)].length, 1);
  const half = new P.FrameParser("t");
  assert.equal([...half.feed(REAL_FRAME.subarray(0, 20))].length, 0);
  const frames = [...half.feed(REAL_FRAME.subarray(20))];
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.cmd, P.FILE_IMPORT_REQ);
  const multi = new P.FrameParser("t");
  assert.equal([...multi.feed(Buffer.concat([REAL_FRAME, REAL_FRAME]))].length, 2);
  const noisy = new P.FrameParser("t");
  assert.equal([...noisy.feed(Buffer.concat([Buffer.from([0, 0xff]), REAL_FRAME]))].length, 1);
});

test("CRC 错误抛出并继续重同步", () => {
  const parser = new P.FrameParser("t");
  const bad = Buffer.from(REAL_FRAME);
  bad[10] ^= 0xff;
  assert.throws(() => [...parser.feed(bad)], P.CrcError);
  assert.equal(parser.crcErrors, 1);
  assert.equal([...parser.feed(REAL_FRAME)].length, 1);
});

test("LEN 超限假帧头重同步", () => {
  const parser = new P.FrameParser("t");
  const bogus = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0xff, 0xff]); // LEN=0xFFFF
  const frames = [...parser.feed(Buffer.concat([bogus, REAL_FRAME]))];
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.cmd, P.FILE_IMPORT_REQ);
});

test("ACK 帧（DATA 仅 TYPE）", () => {
  const frame = P.buildFrame(9, Buffer.from([P.TYPE_FILE]));
  const parser = new P.FrameParser("t");
  const parsed = [...parser.feed(frame)][0]!;
  assert.ok(parsed.isAck);
  assert.equal(parsed.cmd, null);
});

test("文件列表大端解码", () => {
  const entry = (duration: number, size: number, name: string) => {
    const b = Buffer.allocUnsafe(28);
    b.writeUInt32BE(duration, 0);
    b.writeUInt32BE(size, 4);
    Buffer.from(name).copy(b, 8);
    return b;
  };
  const body = Buffer.concat([
    (() => { const h = Buffer.allocUnsafe(4); h.writeUInt32BE(2, 0); return h; })(),
    entry(75, 38444, "note20260710-162938."),
    entry(3600, 1000000, "note20260101-000000."),
  ]);
  const entries = P.decodeFileList(body);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.duration, 75);
  assert.equal(entries[0]!.name, "note20260710-162938.");
  assert.equal(entries[0]!.raw.length, 28);
});

test("候选名重建扩展名", () => {
  const entry = new P.FileEntry({ duration: 1, size: 1, name: "note20260710-162938." });
  assert.deepEqual(entry.candidateNames(), [
    "note20260710-162938.wav",
    "note20260710-162938.opus",
    "note20260710-162938.",
  ]);
  assert.equal(entry.estimatedWavSize, 32044);
});

test("WAV 检查", () => {
  const header = Buffer.alloc(44 + 100);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + 100, 4);
  header.write("WAVE", 8, "latin1");
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt16LE(16, 34);
  const info = P.inspectWav(header);
  assert.ok(info.ok);
  assert.equal(info.declared, 144);
  assert.equal(info.sampleRate, 16000);
  assert.ok(!P.inspectWav(Buffer.concat([header, Buffer.from([0])])).ok);
  assert.ok(!P.isWav(Buffer.from("OggS")));
});

test("时间戳启发式", () => {
  assert.ok(!P.isEpochTimestamp(75));
  assert.ok(!P.isEpochTimestamp(3600 * 24));
  assert.ok(P.isEpochTimestamp(1783412978));
});
