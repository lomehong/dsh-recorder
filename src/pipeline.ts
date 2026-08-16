import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import * as fs from "node:fs";
import * as path from "node:path";

export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "").replace(/[. ]+$/, "");
  return cleaned.slice(0, 40);
}

export async function collectLlmText(chunks: AsyncIterable<any>): Promise<string> {
  const asm = new BlockAssembler();
  for await (const chunk of chunks) {
    // LLM 提供方失败：dsh-llm 以 finish(reason.kind=error) 终止流，这里转成可读错误，
    // 避免 BlockAssembler 对未知 chunk 抛 "unreachable variant" 掩盖真实原因。
    if (chunk?.type === "finish" && chunk.reason?.kind === "error" && chunk.reason?.failure) {
      const failure = chunk.reason.failure;
      const message = typeof failure.message === "string"
        ? failure.message
        : (failure.code ? `LLM 调用失败（${failure.code}）` : "LLM 调用失败");
      throw new Error(message);
    }
    asm.push(chunk);
  }
  const text = asm
    .blocks()
    .filter((b: any) => b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
  return text.trim();
}

export interface LlmLike {
  stream: (opts: any) => AsyncIterable<any>;
}

export interface LlmRoute {
  provider: string;
  model: string;
}

export async function streamChat(llm: LlmLike, route: LlmRoute, prompt: string): Promise<string> {
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    maxTokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  return collectLlmText(stream);
}

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
    } catch {
      // fallthrough
    }
  }
  return { title: "", body: text };
}

export interface ArchiveInput {
  audioPath: string;
  transcript: string;
  title: string;
  body: string;
  date: Date;
  archiveRoot: string;
  mode: ProcessMode;
  /** 降级模式：不生成 .md（LLM 结构化失败时）。 */
  skipMd?: boolean;
}

export interface ArchiveResult {
  mdPath: string | null;
  txtPath: string;
  audioPath: string;
}

export function archiveFile(input: ArchiveInput): ArchiveResult {
  const ym = `${input.date.getFullYear()}-${String(input.date.getMonth() + 1).padStart(2, "0")}`;
  const day = `${ym}-${String(input.date.getDate()).padStart(2, "0")}`;
  const dir = path.join(input.archiveRoot, ym);
  fs.mkdirSync(dir, { recursive: true });
  const base = sanitizeTitle(input.title) || "未命名录音";
  // 冲突检测以 .txt 为基准（.md 可能因降级缺失，避免两者计数不同步）
  let stem = `${day}_${base}`;
  let n = 1;
  while (fs.existsSync(path.join(dir, `${stem}.txt`))) {
    stem = `${day}_${base}_${n++}`;
  }
  const mdPath = input.skipMd ? null : path.join(dir, `${stem}.md`);
  const txtPath = path.join(dir, `${stem}.txt`);
  const ext = path.extname(input.audioPath) || ".wav";
  const audioPath = path.join(dir, `${stem}${ext}`);
  const modeLabel = input.mode === "meeting" ? "会议纪要" : "课堂笔记";
  if (mdPath) {
    // 本地时间（文件名用本地日期，头部时间戳保持一致）
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${input.date.getFullYear()}-${pad(input.date.getMonth() + 1)}-${pad(input.date.getDate())} ${pad(input.date.getHours())}:${pad(input.date.getMinutes())}`;
    const md = `# ${input.title || stem}\n\n- 类型：${modeLabel}\n- 时间：${local}\n\n${input.body}\n\n---\n\n## 全文转写\n\n${input.transcript}\n`;
    fs.writeFileSync(mdPath, md, "utf8");
  }
  fs.writeFileSync(txtPath, input.transcript + "\n", "utf8");
  // 移动原件；跨盘（EXDEV）时回退为复制+删除
  try {
    fs.renameSync(input.audioPath, audioPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(input.audioPath, audioPath);
      fs.unlinkSync(input.audioPath);
    } else {
      throw error;
    }
  }
  return { mdPath, txtPath, audioPath };
}

export interface ProcessOptions {
  audioPath: string;
  transcribe: (p: string) => Promise<string>;
  llm: LlmLike;
  route: LlmRoute;
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
    archiveRoot: opts.archiveRoot, mode: opts.mode, skipMd: degraded,
  });
  return { degraded, title, mdPath: degraded ? null : archived.mdPath, txtPath: archived.txtPath, audioPath: archived.audioPath, ...(error ? { error } : {}) };
}

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
  } catch {
    // 目录尚不存在
  }
  const timer = setInterval(() => {
    let current: string[];
    try {
      current = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of current) {
      if (!audioExts.has(path.extname(name).toLowerCase())) continue;
      if (!known.has(name)) {
        known.add(name);
        opts.onNew(name);
      }
    }
    known = new Set(current.filter((f) => audioExts.has(path.extname(f).toLowerCase())));
  }, intervalMs);
  return () => clearInterval(timer);
}