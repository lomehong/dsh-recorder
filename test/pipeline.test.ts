import { test } from "node:test";
import assert from "node:assert/strict";
import { collectLlmText, sanitizeTitle } from "../src/pipeline.js";

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
