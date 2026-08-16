import { test } from "node:test";
import assert from "node:assert/strict";
import { collectLlmText, sanitizeTitle } from "../src/pipeline.js";

test("sanitizeTitle 清理非法文件名字符", () => {
  assert.equal(sanitizeTitle('项目周会/讨论: "预算"*'), "项目周会讨论预算");
  assert.equal(sanitizeTitle(""), "");
  assert.ok(sanitizeTitle("很长" + "的".repeat(30)).length <= 40);
});

test("collectLlmText 从流式 chunk 中聚合文本", async () => {
  async function* chunks() {
    yield { type: "text-delta", text: "你好" };
    yield { type: "text-delta", text: "世界" };
    yield { type: "block-end", block: { type: "text", text: "！" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  assert.equal(await collectLlmText(chunks()), "你好世界！");
});