/** 本地转写：ffmpeg 解码为 16kHz 单声道 PCM，再交给可插拔的 ASR 命令。

DSH 插件保持 Node 技术栈：ASR 后端是可配置的外部程序（默认 whisper-cli /
whisper.cpp），与 DSH 的 bash/pwsh 工具调用系统命令的模式一致。
若 ffmpeg 或 ASR 命令不可用，抛出带安装指引的错误。
*/

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class AsrNotAvailable extends Error {}

export const LANGUAGES = ["auto", "zh", "en", "yue", "ja", "ko"] as const;

export interface AsrOptions {
  ffmpegPath?: string;
  asrCommand?: string;
  asrModel?: string;
  language?: string;
}

function runProcess(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    proc.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function which(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32"
    ? [".exe", ".cmd", ".bat", ""]
    : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // 继续
      }
    }
  }
  return null;
}

function hasExecutable(cmd: string): boolean {
  return which(cmd) !== null;
}

/** 检查转写依赖（ffmpeg + ASR 命令）是否就绪。 */
export function isAsrReady(opts: AsrOptions = {}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  const asr = opts.asrCommand ?? "whisper-cli";
  if (!hasExecutable(ffmpeg)) missing.push(ffmpeg);
  if (!hasExecutable(asr)) missing.push(asr);
  return { ok: missing.length === 0, missing };
}

/**
 * 转写一个音频文件（wav/opus/mp3 等 ffmpeg 可解码格式）。
 * 流程：ffmpeg → 16kHz/16bit/mono WAV → ASR 命令 → 文本。
 * ASR 使用 whisper.cpp 兼容参数（-f wav -nt -np -ojf -of out），
 * 输出 out.json 的 transcription 字段（或 stdout 纯文本）。
 */
export async function transcribeFile(filePath: string, opts: AsrOptions = {}): Promise<string> {
  const ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  const asr = opts.asrCommand ?? "whisper-cli";
  const model = opts.asrModel;
  if (!hasExecutable(ffmpeg)) {
    throw new AsrNotAvailable(
      "找不到 ffmpeg，请安装并加入 PATH（Windows 可用 winget install Gyan.FFmpeg）");
  }
  if (!hasExecutable(asr)) {
    const guide = [
      "找不到 ASR 命令 " + asr + "。插件默认使用 whisper.cpp 的 whisper-cli：",
      "  1. 下载 https://github.com/ggerganov/whisper.cpp 的 release（含 whisper-cli.exe）",
      "  2. 下载 ggml 模型（如 ggml-base.bin）并放到模型目录",
      "  3. 在插件配置里设置 asrCommand 与 asrModel 路径",
      "也可把 asrCommand 配成其他输出纯文本的 ASR 程序（whisper.cpp 兼容参数）。",
    ].join("\n");
    throw new AsrNotAvailable(guide);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-recorder-"));
  const wavPath = path.join(tmpDir, "audio.wav");
  try {
    // 1) ffmpeg 转 16kHz mono
    const ff = await runProcess(ffmpeg, ["-loglevel", "error", "-y",
      "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
    if (ff.code !== 0) {
      throw new AsrNotAvailable("ffmpeg 转码失败：" + (ff.stderr.trim() || ff.stdout.trim() || "未知错误"));
    }

    // 2) ASR 命令（whisper.cpp 兼容参数）
    const asrArgs: string[] = ["-f", wavPath, "-nt", "-np", "-ojf", "-of", path.join(tmpDir, "out")];
    if (model) asrArgs.push("-m", model);
    if (opts.language && opts.language !== "auto") asrArgs.push("-l", opts.language);
    const run = await runProcess(asr, asrArgs);
    if (run.code !== 0) {
      throw new AsrNotAvailable("ASR 执行失败（" + run.code + "）：" + (run.stderr.trim() || run.stdout.trim() || "未知错误"));
    }

    // 3) 读输出（whisper.cpp -ojf 生成 out.json；无则退回 stdout）
    const jsonPath = path.join(tmpDir, "out.json");
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const segments: string[] = (data.transcription ?? []).map((s: any) => s.text ?? "");
      return segments.join("").trim();
    }
    return run.stdout.trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
