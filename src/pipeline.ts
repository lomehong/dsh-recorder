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