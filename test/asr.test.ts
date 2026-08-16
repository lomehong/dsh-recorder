import { test } from "node:test";
import assert from "node:assert/strict";
import { isAsrReady } from "../src/asr.js";

test("isAsrReady 支持绝对路径命令", () => {
  const exe = process.execPath; // node.exe 绝对路径，必然存在
  const r = isAsrReady({ asrCommand: exe, ffmpegPath: "ffmpeg" });
  assert.ok(r.ok, "绝对路径命令应被识别为可用: " + JSON.stringify(r.missing));
});
