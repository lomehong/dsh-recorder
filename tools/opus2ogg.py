"""把裸 Opus 码流封装为 Ogg/Opus 文件。

录音笔下载的 .opus 是裸 Opus 包（每 40B 一包），不是 Ogg 容器，
ffmpeg 无法直接解码。本脚本逐包封装为 Ogg/Opus 后输出，供 ffmpeg 解码。
复用 Python 参考实现（recorder/realtime_asr.py）的 OggOpusPacketizer。

用法：python opus2ogg.py <input.opus> <output.ogg>
"""
from __future__ import annotations

import os
import sys

# 参考实现位于项目根 recorder/ 包；脚本在 dsh-recorder/tools/ 下，
# 项目根为其上两级目录。
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from recorder.realtime_asr import OggOpusPacketizer  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        print("用法: python opus2ogg.py <input.opus> <output.ogg>", file=sys.stderr)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        data = f.read()
    pkt = OggOpusPacketizer()
    out = bytearray()
    for i in range(0, len(data), 40):
        out.extend(pkt.packetize(data[i:i + 40]))
    out.extend(pkt.close())
    with open(dst, "wb") as f:
        f.write(bytes(out))
    print(f"wrote {len(out)} bytes -> {dst}")


if __name__ == "__main__":
    main()