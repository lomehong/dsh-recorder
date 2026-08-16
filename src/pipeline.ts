import { BlockAssembler } from "@deepseek-ai/dsh-llm";

export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "").replace(/[. ]+$/, "");
  return cleaned.slice(0, 40);
}

export async function collectLlmText(chunks: AsyncIterable<any>): Promise<string> {
  const asm = new BlockAssembler();
  for await (const chunk of chunks) {
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