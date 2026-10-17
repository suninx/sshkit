#!/usr/bin/env python3
"""bench/probes/ansi-palette.py — 从截图量终端调色板/字体度量(两侧同用)

为什么要它:原版终端走 canvas 渲染,颜色**不在 DOM 里**(computed style 拿不到),
只能从像素反推;而两侧截图布局不同,必须按"已知字符格"取样才可比。

用法:
    python3 bench/probes/ansi-palette.py <原版截图> <原版 terminal.json> <sshkit截图> <sshkit terminal.json>
    # terminal.json 由:node bench/grab.mjs --port <p> --eval-file bench/probes/terminal-style.js 得到

配套命令(在两侧终端里跑同一串,才能类比):
    clear; printf '\\033[30mK\\033[31mR\\033[32mG\\033[33mY\\033[34mB\\033[35mM\\033[36mC\\033[37mW\\033[0m '
    printf '\\033[90mk\\033[91mr\\033[92mg\\033[93my\\033[94mb\\033[95mm\\033[96mc\\033[97mw\\033[0m\\n'
    printf 'MWmw iIlL1 0Oo 0123456789\\n'
    # …用 node bench/drive.mjs --insert-file 投进去

⚠️ 两个实测踩过的坑(改脚本前先读):
 1. 那 17 格里有**一个空格**(8 暗 + 空格 + 8 亮)。漏掉它会让亮色整排错位一格,
    于是"亮绿"取到亮红 —— 本脚本第一版就是这么错的。
 2. 终端默认前景 ≠ 当前 SGR。远端 shell 常在 prompt 后留着 SGR 32 不复位,
    于是普通输出显示的是 **ANSI 绿**,而不是主题默认前景。
    要看默认前景,必须在行首显式 `\\033[0m` 或 `\\033[39m`。
"""
import json
import sys
from collections import Counter

from PIL import Image

LAYOUT = "KRGYBMCW krgybmcw"          # 17 格:暗 8 + 空格 + 亮 8
NAMES = ["黑", "红", "绿", "黄", "蓝", "品红", "青", "白"]
BG_THR = 40
FG_THR = 45


def _bands(px, W, H, bg):
    rows = [sum(1 for x in range(W) if _far(px[x, y], bg) > BG_THR) for y in range(H)]
    out, y = [], 0
    while y < H:
        if rows[y] > 0:
            y0 = y
            while y < H and rows[y] > 0:
                y += 1
            if y - y0 >= 4:
                out.append((y0, y - 1))
        else:
            y += 1
    return out


def _far(p, bg):
    return sum((a - b) ** 2 for a, b in zip(p, bg)) ** 0.5


def _crop(png, jpath):
    j = json.load(open(jpath))
    g = j["geometry"]["xterm"]
    im = Image.open(png).convert("RGB").crop((g["x"], g["y"], g["x"] + g["w"], g["y"] + g["h"]))
    return im, j


def analyze(png, jpath, label):
    im, j = _crop(png, jpath)
    W, H = im.size
    px = im.load()
    bg = Counter(im.getdata()).most_common(1)[0][0]
    bs = _bands(px, W, H, bg)
    print(f"--- {label} ---   bg #{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}   区域 {W}x{H}")
    if len(bs) < 2:
        print("  文字带不足,跳过")
        return

    def extent(ya, yb):
        cols = [x for x in range(W)
                if any(_far(px[x, y], bg) > BG_THR for y in range(ya, yb + 1))]
        return (min(cols), max(cols)) if cols else (0, 0)

    y1a, y1b = bs[0]
    y2a, y2b = bs[1]
    l2, r2 = extent(y2a, y2b)
    cell_w = (r2 - l2 + 1) / 25.0            # 第 2 行是 25 个等宽字符,用来反推格宽
    l1, _ = extent(y1a, y1b)
    print(f"  行距 {bs[1][0] - bs[0][0]}px   格宽 {cell_w:.2f}px   带高 {[b[1] - b[0] + 1 for b in bs[:3]]}")

    for i, ch in enumerate(LAYOUT):
        if ch == " ":
            continue
        x0, x1 = int(l1 + i * cell_w), int(l1 + (i + 1) * cell_w)
        cands = [px[x, y] for y in range(y1a, y1b + 1) for x in range(max(x0, 0), min(x1, W))
                 if _far(px[x, y], bg) > FG_THR]
        tag = NAMES[(i - 9) % 8] if i > 8 else NAMES[i]
        bright = "(亮)" if i > 8 else "(暗)"
        if not cands:
            print(f"    {tag}{bright}: —")
            continue
        cands.sort(key=lambda p: max(p) - min(p), reverse=True)
        top = cands[:max(1, len(cands) // 4)]
        c = tuple(sum(t[k] for t in top) // len(top) for k in range(3))
        print(f"    {tag}{bright}: #{c[0]:02x}{c[1]:02x}{c[2]:02x}")

    cnt = Counter(px[x, y] for y in range(y2a, y2b + 1) for x in range(l2, r2 + 1)
                  if _far(px[x, y], bg) > FG_THR)
    tot = sum(cnt.values()) or 1
    print("    第2行是无颜色码的纯文本,其主色=该会话当前 SGR 下的前景:",
          [f"#{c[0][0]:02x}{c[0][1]:02x}{c[0][2]:02x}×{round(c[1] / tot * 100)}%" for c in cnt.most_common(3)])


if __name__ == "__main__":
    if len(sys.argv) != 5:
        print(__doc__)
        sys.exit(2)
    analyze(sys.argv[1], sys.argv[2], "原版")
    print()
    analyze(sys.argv[3], sys.argv[4], "sshkit")
