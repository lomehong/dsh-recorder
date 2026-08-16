import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plugin from "../src/index.js";

interface StubTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown };
  execute: (args: any, exec?: any) => Promise<unknown>;
}

function makeStubCtx(outputDir: string) {
  const tools: StubTool[] = [];
  const sections: { name: string; text: string }[] = [];
  const ctx = {
    tools: { register: (def: StubTool) => { tools.push(def); } },
    systemPrompt: { section: (s: { name: string; text: string }) => { sections.push(s); } },
    on: () => {},
  } as any;
  return { ctx, tools, sections };
}

const EXPECTED_TOOLS = [
  "recorder_scan", "recorder_connect", "recorder_disconnect", "recorder_status",
  "recorder_smoke", "recorder_list", "recorder_download", "recorder_delete",
  "recorder_deleteall", "recorder_rec", "recorder_gain", "recorder_rt",
  "recorder_raw", "recorder_transcribe",
];

test("插件元信息", () => {
  assert.equal(plugin.name, "recorder");
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.Config);
  assert.equal(typeof plugin.apply, "function");
});

test("apply 注册全部录音笔工具", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-plug-"));
  const { ctx, tools } = makeStubCtx(dir);
  plugin.apply(ctx, { transport: "simulated", outputDir: dir });
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺描述`);
    assert.ok(tool.output?.schema, `${tool.name} 缺输出 schema`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recorder_status 未连接时返回 connected:false", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-plug-"));
  const { ctx, tools } = makeStubCtx(dir);
  plugin.apply(ctx, { transport: "simulated", outputDir: dir });
  const status = tools.find((t) => t.name === "recorder_status")!;
  const result = await status.execute({});
  assert.deepEqual(result, { connected: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("模拟传输全链路：scan → connect → list → download → transcribe 依赖检查", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-plug-"));
  const { ctx, tools } = makeStubCtx(dir);
  plugin.apply(ctx, { transport: "simulated", outputDir: dir, asrCommand: "definitely-not-whisper" });
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  const scan = await byName("recorder_scan").execute({ timeout: 1 });
  assert.equal((scan as any).devices.length, 1);
  assert.equal((scan as any).devices[0].name, "CB08");

  const conn = await byName("recorder_connect").execute({ target: "0" });
  assert.equal((conn as any).connected, true);
  assert.ok((conn as any).mtu >= 36);

  const status = await byName("recorder_status").execute({});
  assert.equal((status as any).connected, true);
  assert.equal((status as any).battery, 85);

  const list = await byName("recorder_list").execute({});
  assert.equal((list as any).files.length, 1);
  assert.equal((list as any).files[0].name, "demo20260101-000000.");

  const dl = await byName("recorder_download").execute({ index: 0 });
  assert.equal((dl as any).is_wav, true);
  assert.ok(fs.existsSync((dl as any).path));

  // 转写依赖缺失应给出明确错误（模拟传输 + 不存在的 ASR 命令）
  await assert.rejects(
    () => byName("recorder_transcribe").execute({ index: 0 }),
    (err: any) => err?.message?.includes("转写依赖缺失"));

  const disc = await byName("recorder_disconnect").execute({});
  assert.deepEqual(disc, { connected: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("删除操作必须 confirm=true", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-plug-"));
  const { ctx, tools } = makeStubCtx(dir);
  plugin.apply(ctx, { transport: "simulated", outputDir: dir });
  const scan = tools.find((t) => t.name === "recorder_scan")!;
  const del = tools.find((t) => t.name === "recorder_delete")!;
  const conn = tools.find((t) => t.name === "recorder_connect")!;
  const list = tools.find((t) => t.name === "recorder_list")!;
  await scan.execute({ timeout: 1 });
  await conn.execute({ target: "0" });
  await list.execute({});
  await assert.rejects(() => del.execute({ index: 0 }), /confirm/);
  const ok = await del.execute({ index: 0, confirm: true });
  assert.equal((ok as any).message.includes("删除"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
