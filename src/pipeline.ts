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