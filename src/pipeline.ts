export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "").replace(/[. ]+$/, "");
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