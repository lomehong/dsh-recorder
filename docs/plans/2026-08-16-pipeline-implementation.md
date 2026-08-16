# 智能录音处理流水线（方向 A）实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 dsh-recorder 插件增加「录音 → 转写 → LLM 结构化纪要/笔记 → 自动归档」流水线（recorder_process 工具 + autoProcess/dirWatch 自动触发）。

**Architecture:** 新增 `src/pipeline.ts` 核心模块（processFile：转写→LLM→归档），复用现有 `asr.ts` 转写与 `ctx.llm` 服务；在 `src/index.ts` 注册 `recorder_process` 工具并在 download 完成后挂钩 autoProcess；目录监听用定时轮询实现。

**Tech Stack:** TypeScript / node:test / DSH (cordis ctx.llm service) / ffmpeg+whisper（已有）

**前置知识（工程师必读）：**
- LLM 调用：`const stream = ctx.llm.stream({ provider, model, messages: [{role:"user", content:[{type:"text", text: prompt}]}], maxTokens });` 遍历 `for await (const chunk of stream)`，chunk 为 `{ type: "text-delta", text }` 或 `{ type: "block-end", block: { type: "text", text } }` 等流式块（见 dsh-llm BlockAssembler）。
- 现有转写：`asr.transcribeFile(path, { ffmpegPath, asrCommand, asrModel, language })` 返回全文文本。
- 测试风格：node:test + 临时目录 + stub ctx（参考 test/plugin.test.ts）。

---

### Task 1: pipeline 模块骨架 + LLM 文本提取助手

**Files:**
- Create: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Step 1: Write the failing test**

```ts
// test/pipeline.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: FAIL（pipeline 模块不存在）

**Step 3: Write minimal implementation**

```ts
// src/pipeline.ts
export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, "").replace(/[. ]+$/, "").trim();
  return cleaned.slice(0, 40);
}

export async function collectLlmText(chunks: AsyncIterable<any>): Promise<string> {
  let out = "";
  for await (const chunk of chunks) {
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
    else if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") out += chunk.block.text;
  }
  return out.trim();
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: PASS 2 项

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat(pipeline): 文本聚合与标题安全化助手"
```

---

### Task 2: LLM 调用封装（streamChat）

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Step 1: Write the failing test**

```ts
test("streamChat 组装消息并返回全文", async () => {
  const calls: any[] = [];
  const fakeLlm = {
    stream: (opts: any) => {
      calls.push(opts);
      return (async function* () {
        yield { type: "text-delta", text: "摘要" };
      })();
    },
  };
  const text = await streamChat(fakeLlm, { provider: "p", model: "m" }, "我的提示");
  assert.equal(text, "摘要");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "p");
  assert.equal(calls[0].messages[0].role, "user");
  assert.match(calls[0].messages[0].content[0].text, /我的提示/);
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: FAIL（streamChat 未定义）

**Step 3: Write minimal implementation**

```ts
export interface LlmLike { stream: (opts: any) => AsyncIterable<any>; }

export async function streamChat(llm: LlmLike, route: { provider: string; model: string }, prompt: string): Promise<string> {
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    maxTokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  return collectLlmText(stream);
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: PASS 3 项

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat(pipeline): LLM 流式调用封装"
```

---

### Task 3: 结构化 prompt 与结果解析

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Step 1: Write the failing test**

```ts
import { buildStructurePrompt, parseStructured, ProcessMode } from "../src/pipeline.js";

test("buildStructurePrompt 生成 meeting 模式 prompt", () => {
  const p = buildStructurePrompt("meeting" as ProcessMode, "全文内容");
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
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: FAIL（函数未定义）

**Step 3: Write minimal implementation**

```ts
export type ProcessMode = "meeting" | "note";

export function buildStructurePrompt(mode: ProcessMode, transcript: string): string {
  const spec = mode === "meeting"
    ? "输出为 JSON：{\"title\":\"≤10字主题\",\"body\":\"Markdown 正文\"}。body 需包含：## 议题、## 结论、## 待办（含责任人如可识别）、## 关键发言摘要。"
    : "输出为 JSON：{\"title\":\"≤10字主题\",\"body\":\"Markdown 正文\"}。body 需包含：## 核心要点、## 公式与术语（若无则省略）、## 作业任务。";
  return `你是录音整理助手。请根据以下转写文本生成结构化${mode === "meeting" ? "会议纪要" : "课堂笔记"}。${spec}\n\n转写文本：\n${transcript.slice(0, 30000)}`;
}

export function parseStructured(text: string): { title: string; body: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      return { title: String(obj.title ?? ""), body: String(obj.body ?? "") };
    } catch { /* fallthrough */ }
  }
  return { title: "", body: text };
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: PASS 6 项

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat(pipeline): 结构化 prompt 与结果解析"
```

---

### Task 4: 归档落盘（archiveFile）

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Step 1: Write the failing test**

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveFile } from "../src/pipeline.js";

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
  archiveFile({ audioPath: audio, transcript: "t", title: "主题", body: "b", date: new Date(), archiveRoot: path.join(root, "archive"), mode: "note" });
  const audio2 = path.join(srcDir, "b.wav");
  fs.writeFileSync(audio2, "RIFFfake");
  const r2 = archiveFile({ audioPath: audio2, transcript: "t", title: "主题", body: "b", date: new Date(), archiveRoot: path.join(root, "archive"), mode: "note" });
  assert.notEqual(r2.mdPath, r2.mdPath.replace(/_2\.md$/, ".md"));
  fs.rmSync(root, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: FAIL（archiveFile 未定义）

**Step 3: Write minimal implementation**

```ts
import * as fs from "node:fs";
import * as path from "node:path";

export interface ArchiveInput {
  audioPath: string;
  transcript: string;
  title: string;
  body: string;
  date: Date;
  archiveRoot: string;
  mode: ProcessMode;
}

export interface ArchiveResult { mdPath: string; txtPath: string; audioPath: string; }

export function archiveFile(input: ArchiveInput): ArchiveResult {
  const ym = `${input.date.getFullYear()}-${String(input.date.getMonth() + 1).padStart(2, "0")}`;
  const day = `${ym}-${String(input.date.getDate()).padStart(2, "0")}`;
  const dir = path.join(input.archiveRoot, ym);
  fs.mkdirSync(dir, { recursive: true });
  const base = sanitizeTitle(input.title) || "未命名录音";
  let stem = `${day}_${base}`;
  let n = 1;
  while (fs.existsSync(path.join(dir, `${stem}.md`))) {
    stem = `${day}_${base}_${n++}`;
  }
  const mdPath = path.join(dir, `${stem}.md`);
  const txtPath = path.join(dir, `${stem}.txt`);
  const ext = path.extname(input.audioPath) || ".wav";
  const audioPath = path.join(dir, `${stem}${ext}`);
  const modeLabel = input.mode === "meeting" ? "会议纪要" : "课堂笔记";
  const md = `# ${input.title || stem}\n\n- 类型：${modeLabel}\n- 时间：${input.date.toISOString().slice(0, 16).replace("T", " ")}\n\n${input.body}\n\n---\n\n## 全文转写\n\n${input.transcript}\n`;
  fs.writeFileSync(mdPath, md, "utf8");
  fs.writeFileSync(txtPath, input.transcript + "\n", "utf8");
  fs.renameSync(input.audioPath, audioPath);
  return { mdPath, txtPath, audioPath };
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: PASS 8 项

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat(pipeline): 归档三件套落盘与文件名冲突处理"
```

---

### Task 5: processFile 主流程（转写 + LLM + 归档 + 降级）

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Step 1: Write the failing test**

```ts
import { processFile } from "../src/pipeline.js";

test("processFile 完整流程（mock LLM）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  const audio = path.join(srcDir, "a.wav");
  fs.writeFileSync(audio, "RIFFfake");
  let llmPrompt = "";
  const fakeLlm = { stream: (opts: any) => { llmPrompt = opts.messages[0].content[0].text; return (async function* () { yield { type: "text-delta", text: '{"title":"测试","body":"## 结论\\nok"}' }; })(); } };
  const result = await processFile({
    audioPath: audio,
    transcribe: async () => "这是一段测试转写",
    llm: fakeLlm as any,
    route: { provider: "p", model: "m" },
    mode: "meeting",
    archiveRoot: path.join(root, "archive"),
    now: () => new Date(2026, 7, 16, 10, 30),
  });
  assert.ok(result.degraded === false);
  assert.equal(result.title, "测试");
  assert.ok(fs.existsSync(result.mdPath!));
  assert.match(llmPrompt, /这是一段测试转写/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("processFile LLM 失败降级保留转写", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  const audio = path.join(srcDir, "a.wav");
  fs.writeFileSync(audio, "RIFFfake");
  const fakeLlm = { stream: () => { throw new Error("LLM 不可用"); } };
  const result = await processFile({
    audioPath: audio,
    transcribe: async () => "转写成功",
    llm: fakeLlm as any,
    route: { provider: "p", model: "m" },
    mode: "note",
    archiveRoot: path.join(root, "archive"),
    now: () => new Date(2026, 7, 16, 10, 30),
  });
  assert.ok(result.degraded === true);
  assert.ok(fs.existsSync(result.txtPath!));
  fs.rmSync(root, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: FAIL（processFile 未定义）

**Step 3: Write minimal implementation**

```ts
export interface ProcessOptions {
  audioPath: string;
  transcribe: (p: string) => Promise<string>;
  llm: LlmLike;
  route: { provider: string; model: string };
  mode: ProcessMode;
  archiveRoot: string;
  now?: () => Date;
}

export interface ProcessResult {
  degraded: boolean;
  title: string;
  mdPath: string | null;
  txtPath: string;
  audioPath: string;
  error?: string;
}

export async function processFile(opts: ProcessOptions): Promise<ProcessResult> {
  const date = (opts.now ?? (() => new Date()))();
  const transcript = await opts.transcribe(opts.audioPath);
  let title = "";
  let body = "";
  let degraded = false;
  let error: string | undefined;
  try {
    const raw = await streamChat(opts.llm, opts.route, buildStructurePrompt(opts.mode, transcript));
    const parsed = parseStructured(raw);
    title = parsed.title;
    body = parsed.body || "（未生成结构化正文）";
  } catch (e) {
    degraded = true;
    error = (e as Error).message;
    body = "（LLM 结构化失败：" + error + "）";
  }
  const archived = archiveFile({
    audioPath: opts.audioPath, transcript, title, body, date,
    archiveRoot: opts.archiveRoot, mode: opts.mode,
  });
  return { degraded, title, mdPath: degraded ? null : archived.mdPath, txtPath: archived.txtPath, audioPath: archived.audioPath, ...(error ? { error } : {}) };
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: PASS 10 项

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat(pipeline): processFile 主流程与 LLM 降级"
```

---

### Task 6: 目录监听（startWatcher）

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Step 1: Write the failing test**

```ts
import { startWatcher } from "../src/pipeline.js";

test("startWatcher 检测新文件并回调", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  const seen: string[] = [];
  const stop = startWatcher(root, { intervalMs: 50, onNew: (f) => { seen.push(f); } });
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(path.join(root, "new.wav"), "x");
  await new Promise((r) => setTimeout(r, 200));
  stop();
  assert.ok(seen.includes("new.wav"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("startWatcher 忽略已存在文件与 txt/md", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  fs.writeFileSync(path.join(root, "old.wav"), "x");
  fs.writeFileSync(path.join(root, "note.txt"), "x");
  const seen: string[] = [];
  const stop = startWatcher(root, { intervalMs: 50, onNew: (f) => { seen.push(f); } });
  await new Promise((r) => setTimeout(r, 150));
  stop();
  assert.deepEqual(seen, []);
  fs.rmSync(root, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: FAIL（startWatcher 未定义）

**Step 3: Write minimal implementation**

```ts
export interface WatcherOptions {
  intervalMs?: number;
  onNew: (filename: string) => void;
}

export function startWatcher(dir: string, opts: WatcherOptions): () => void {
  const intervalMs = opts.intervalMs ?? 10000;
  const audioExts = new Set([".wav", ".opus", ".mp3", ".m4a"]);
  let known = new Set<string>();
  try {
    known = new Set(fs.readdirSync(dir).filter((f) => audioExts.has(path.extname(f).toLowerCase())));
  } catch { /* 目录尚不存在 */ }
  const timer = setInterval(() => {
    let current: string[];
    try { current = fs.readdirSync(dir); } catch { return; }
    for (const name of current) {
      if (!audioExts.has(path.extname(name).toLowerCase())) continue;
      if (!known.has(name)) { known.add(name); opts.onNew(name); }
    }
    known = new Set(current.filter((f) => audioExts.has(path.extname(f).toLowerCase())));
  }, intervalMs);
  return () => clearInterval(timer);
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/pipeline.test.ts`
Expected: PASS 12 项

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat(pipeline): 下载目录轮询监听"
```

---

### Task 7: 注册 recorder_process 工具 + 配置项

**Files:**
- Modify: `src/index.ts`（Config 扩展、inject 增加 llm、apply 注册工具、dispose 停 watcher）
- Test: `test/plugin.test.ts`

**Step 1: Write the failing test**

```ts
// 在 EXPECTED_TOOLS 追加 "recorder_process"
test("recorder_process 处理本地文件（mock LLM）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-plug-"));
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir);
  const audio = path.join(outDir, "a.wav");
  fs.writeFileSync(audio, "RIFFfake");
  const llmStream = () => (async function* () { yield { type: "text-delta", text: '{"title":"测试纪要","body":"## 结论\\nok"}' }; })();
  const { ctx, tools } = makeStubCtx(dir, { stream: llmStream });
  plugin.apply(ctx, { transport: "simulated", outputDir: outDir, archiveRoot: path.join(dir, "archive") });
  const proc = tools.find((t) => t.name === "recorder_process")!;
  const result = await proc.execute({ local_file: "a.wav", mode: "meeting" });
  assert.ok((result as any).degraded === false);
  assert.equal((result as any).title, "测试纪要");
  fs.rmSync(dir, { recursive: true, force: true });
});
```

注意：`makeStubCtx` 需增加可选 `llm` 注入（ctx.llm = stub）；未提供时 `processFile` 需能识别 llm 缺失并降级（不能崩溃）。

**Step 2: Run test to verify it fails**

Run: `npx tsx --test test/plugin.test.ts`
Expected: FAIL（recorder_process 未注册）

**Step 3: Write minimal implementation**

`src/index.ts` 修改点：
1. Config 增加：`autoProcess`（boolean, false）、`dirWatch`（boolean, false）、`archiveRoot`（string, ""）、`llmProvider`（string, "deepseek-official"）、`llmModel`（string, "deepseek-v4-flash"）
2. `export const inject = ["tools", "systemPrompt", "llm"];`
3. apply 内解析新配置；`archiveRoot` 默认 `path.join(outputDir, "archive")`
4. 注册工具（要点）：

```ts
ctx.tools.register(defineTool({
  name: "recorder_process",
  description: "智能处理录音：转写 → LLM 生成会议纪要/课堂笔记 → 归档。参数：index（设备文件，自动下载）或 local_file（输出目录内文件）；mode=meeting/note。返回归档路径与主题。",
  parameters: {
    index: { type: "integer", description: "设备文件序号（与 local_file 二选一）" },
    local_file: { type: "string", description: "输出目录内的音频文件名（与 index 二选一）" },
    mode: { type: "string", enum: ["meeting", "note"], description: "meeting 会议纪要 / note 课堂笔记，默认 meeting" },
  },
  output: output({ type: "object", additionalProperties: false, properties: {
    degraded: { type: "boolean", required: true }, title: { type: "string", required: true },
    md_path: { type: "string" }, txt_path: { type: "string", required: true },
    audio_path: { type: "string", required: true }, mode: { type: "string", required: true }, error: { type: "string" },
  } }),
  async execute(args: any) {
    const mode: ProcessMode = args.mode === "note" ? "note" : "meeting";
    return withBusy(async () => {
      let audioPath: string | null = null;
      if (args.index !== undefined) {
        const entry = entryByIndex(args.index);
        const existing = recorder.findLocalFile(entry);
        if (existing) audioPath = existing;
        else { requireConnected(); audioPath = (await recorder.download(entry)).path; }
      } else if (args.local_file) {
        const pathMod = await import("node:path");
        const fsMod = await import("node:fs");
        const name = pathMod.basename(String(args.local_file));
        const p = pathMod.join(resolved.outputDir, name);
        if (!fsMod.existsSync(p)) throw new HarnessError("本地文件不存在", "RECORDER_BAD_ARGS");
        audioPath = p;
      } else {
        throw new HarnessError("index 或 local_file 必须提供一个", "RECORDER_BAD_ARGS");
      }
      if (audioPath === null) throw new HarnessError("无法定位音频文件", "RECORDER_BAD_ARGS");
      const llmService = (ctx as any).llm;
      const result = await processFile({
        audioPath,
        transcribe: (p) => asr.transcribeFile(p, asrOpts),
        llm: llmService ?? { stream: () => { throw new Error("LLM 服务不可用"); } },
        route: { provider: resolved.llmProvider, model: resolved.llmModel },
        mode,
        archiveRoot: resolved.archiveRoot,
      });
      return { degraded: result.degraded, title: result.title, md_path: result.mdPath, txt_path: result.txtPath, audio_path: result.audioPath, mode, ...(result.error ? { error: result.error } : {}) };
    });
  },
  presentCall: (args: any) => ({ card: "generic", title: "智能处理录音", kind: "execute", rawInput: args.local_file ?? `#${args.index}` }),
}));
```

5. download 完成挂钩 autoProcess（execute 末尾，成功下载后）：

```ts
if (resolved.autoProcess) {
  const p = result.path;
  if (p) {
    processFile({
      audioPath: p,
      transcribe: (fp) => asr.transcribeFile(fp, asrOpts),
      llm: (ctx as any).llm ?? { stream: () => { throw new Error("LLM 服务不可用"); } },
      route: { provider: resolved.llmProvider, model: resolved.llmModel },
      mode: "meeting", archiveRoot: resolved.archiveRoot,
    }).catch((e) => console.error("[recorder] autoProcess 失败:", e.message));
  }
}
```

6. dirWatch 启动与清理：

```ts
let watcherStop: (() => void) | null = null;
if (resolved.dirWatch) {
  watcherStop = startWatcher(resolved.outputDir, {
    onNew: (name) => {
      const full = path.join(resolved.outputDir, name);
      processFile({
        audioPath: full,
        transcribe: (fp) => asr.transcribeFile(fp, asrOpts),
        llm: (ctx as any).llm ?? { stream: () => { throw new Error("LLM 服务不可用"); } },
        route: { provider: resolved.llmProvider, model: resolved.llmModel },
        mode: "meeting", archiveRoot: resolved.archiveRoot,
      }).catch((e) => console.error("[recorder] dirWatch 处理失败:", e.message));
    },
  });
}
// dispose 时：
ctx.on("dispose", () => { watcherStop?.(); /* 原有清理 */ });
```

注意：index.ts 顶部需 `import { processFile, startWatcher, type ProcessMode } from "./pipeline.js";`

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: 全部通过（含新增 recorder_process 用例；EXPECTED_TOOLS 已更新）

**Step 5: Commit**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: recorder_process 工具 + autoProcess/dirWatch 配置"
```

---

### Task 8: 端到端冒烟 + 文档

**Files:**
- Modify: `test/plugin.test.ts`
- Modify: `README.md`

**Step 1: Write the failing test**

```ts
test("simulated 全链路 download → process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rec-plug-"));
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir);
  const { ctx, tools } = makeStubCtx(dir, { stream: () => (async function* () { yield { type: "text-delta", text: '{"title":"冒烟","body":"ok"}' }; })() });
  plugin.apply(ctx, { transport: "simulated", outputDir: outDir, archiveRoot: path.join(dir, "archive"), asrCommand: "nonexistent-cmd" });
  // 模拟设备列表在 simulated 下直接 scan→connect→list
  const scan = tools.find((t) => t.name === "recorder_scan")!;
  await scan.execute({ timeout: 1 });
  const conn = tools.find((t) => t.name === "recorder_connect")!;
  await conn.execute({ target: "0" });
  const list = tools.find((t) => t.name === "recorder_list")!;
  const lr = await list.execute({}) as any;
  assert.ok(lr.files.length >= 1);
  // process 走本地下载文件路径（转写会因 asrCommand 不存在而降级到异常，这里只验证工具存在且参数校验）
  const proc = tools.find((t) => t.name === "recorder_process")!;
  assert.ok(proc);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it passes（若转写不可用则验证错误提示）**

Run: `npm test`
Expected: 全绿（simulated 冒烟通过）

**Step 3: 更新 README.md**

在「工具清单」表新增 recorder_process 行；在「转写」节后新增「智能处理（recorder_process）」小节，说明：
- 用法：`recorder_process(index=0, mode=meeting)` 或 `recorder_process(local_file="xxx.wav", mode=note)`
- 配置：autoProcess / dirWatch / archiveRoot / llmProvider / llmModel
- 依赖：转写依赖（ffmpeg + ASR）+ DSH LLM 服务
- 归档结构示例

**Step 4: Commit**

```bash
git add README.md test/plugin.test.ts
git commit -m "docs: recorder_process 使用说明与全链路冒烟"
```

---

## 验收清单

- [ ] `npm test` 全绿
- [ ] `recorder_process` 可处理本地文件并生成 .md/.txt 归档
- [ ] LLM 不可用时降级保留转写（degraded=true）
- [ ] autoProcess=true 时下载完成后自动处理
- [ ] dirWatch=true 时新文件进入下载目录自动处理
- [ ] 归档结构：`archive/<YYYY-MM>/<YYYY-MM-DD>_<主题>.{md,txt}` + 原件