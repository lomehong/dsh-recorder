import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveFile, buildStructurePrompt, collectLlmText, parseStructured, sanitizeTitle, streamChat } from "../src/pipeline.js";

test("sanitizeTitle 清理非法文件名字符", () => {
  assert.equal(sanitizeTitle('项目周会/讨论: "预算"*'), "项目周会讨论预算");
  assert.equal(sanitizeTitle(""), "");
});

test("sanitizeTitle 超长标题截断到 40 字符", () => {
  assert.equal(sanitizeTitle("的".repeat(45)), "的".repeat(40));
  assert.ok(sanitizeTitle("的".repeat(45)).length === 40);
});

test("collectLlmText 从流式 chunk 中聚合文本", async () => {
  async function* chunks() {
    yield { type: "text-delta", index: 0, text: "你好" };
    yield { type: "text-delta", index: 0, text: "世界" };
  }
  assert.equal(await collectLlmText(chunks()), "你好世界");
});

test("collectLlmText 真实流形状不重复聚合", async () => {
  async function* chunks() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "你好" };
    yield { type: "text-delta", index: 0, text: "世界" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "你好世界" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  assert.equal(await collectLlmText(chunks()), "你好世界");
});

test("collectLlmText 空流返回空串", async () => {
  async function* chunks() {}
  assert.equal(await collectLlmText(chunks()), "");
});

test("collectLlmText 支持纯 delta 协议", async () => {
  async function* chunks() {
    yield { type: "text-delta", index: 0, text: "A" };
    yield { type: "text-delta", index: 0, text: "B" };
  }
  assert.equal(await collectLlmText(chunks()), "AB");
});

test("streamChat 组装消息并返回全文", async () => {
  const calls: any[] = [];
  const fakeLlm = {
    stream: (opts: any) => {
      calls.push(opts);
      return (async function* () {
        yield { type: "text-delta", index: 0, text: "摘要" };
      })();
    },
  };
  const text = await streamChat(fakeLlm as any, { provider: "p", model: "m" }, "我的提示");
  assert.equal(text, "摘要");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "p");
  assert.equal(calls[0].messages[0].role, "user");
  assert.match(calls[0].messages[0].content[0].text, /我的提示/);
});

test("buildStructurePrompt 生成 meeting 模式 prompt", () => {
  const p = buildStructurePrompt("meeting", "全文内容");
  assert.match(p, /会议/);
  assert.match(p, /全文内容/);
  assert.match(p, /待办/);
});

test("parseStructured 解析 JSON 块", () => {
  const text = '{"title":"项目周会","body":"## 议题\\n- A"}';
  const r = parseStructured(text);
  assert.equal(r.title, "项目周会");
  assert.equal(r.body, "## 议题\n- A");
});

test("parseStructured 无 JSON 时整体视为 body", () => {
  const r = parseStructured("纯文本说明");
  assert.equal(r.title, "");
  assert.ok(r.body.includes("纯文本说明"));
});


test("archiveFile 生成三件套并移动原件", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  const audio = path.join(srcDir, "a.wav");
  fs.writeFileSync(audio, "RIFFfake");
  const result = archiveFile({
    audioPath: audio,
    transcript: "全文",
    title: "周会",
    body: "## 议题",
    date: new Date(2026, 7, 16, 10, 30),
    archiveRoot: path.join(root, "archive"),
    mode: "meeting",
  });
  assert.ok(fs.existsSync(result.mdPath));
  assert.ok(fs.existsSync(result.txtPath));
  assert.ok(fs.existsSync(result.audioPath), "原件应移入归档目录");
  assert.ok(!fs.existsSync(audio), "原位置应不再有文件");
  const md = fs.readFileSync(result.mdPath, "utf8");
  assert.match(md, /周会/);
  assert.match(md, /全文/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("archiveFile 文件名冲突自动加后缀", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  const audio = path.join(srcDir, "a.wav");
  fs.writeFileSync(audio, "RIFFfake");
  const r1 = archiveFile({ audioPath: audio, transcript: "t", title: "主题", body: "b", date: new Date(), archiveRoot: path.join(root, "archive"), mode: "note" });
  const audio2 = path.join(srcDir, "b.wav");
  fs.writeFileSync(audio2, "RIFFfake");
  const r2 = archiveFile({ audioPath: audio2, transcript: "t", title: "主题", body: "b", date: new Date(), archiveRoot: path.join(root, "archive"), mode: "note" });
  assert.notEqual(r2.mdPath, r1.mdPath, "冲突时路径应不同");
  assert.match(r2.mdPath, /_1\.md$/, "第二个文件应带 _1 后缀");
  fs.rmSync(root, { recursive: true, force: true });
});


