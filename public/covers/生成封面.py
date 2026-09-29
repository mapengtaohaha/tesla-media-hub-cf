#!/usr/bin/env python3
"""生成默认封面：极简风景海报（天空渐变 + 日/月 + 山脊或天际线剪影 + 暗角 + 颗粒）。

所有距离用像素计算、抗锯齿按像素给带宽；山脊/天际线的高度按列预计算，只算一遍。

环境变量：COVER_W COVER_H COVER_OUT COVER_N COVER_GRAIN
"""
import zlib, struct, math, os, random

W = int(os.environ.get("COVER_W", 720))
H = int(os.environ.get("COVER_H", 960))
OUT = os.environ.get("COVER_OUT", "/Users/a1/WorkBuddy/2026-09-29-08-29-20/上传用/public/covers")
N = int(os.environ.get("COVER_N", 6))
GRAIN = float(os.environ.get("COVER_GRAIN", "3"))

BAYER4 = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
AA = 1.6   # 抗锯齿带宽（像素）


def clamp(v, a=0.0, b=1.0):
    return a if v < a else (b if v > b else v)


def ss(t):
    t = clamp(t)
    return t * t * (3 - 2 * t)


def cov(v_px, w=AA):
    """v_px < 0 表示在形状内部"""
    return ss(0.5 - v_px / w)


def mix(c, d, t):
    return (c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t)


def shade(c, k):
    return (c[0] * k, c[1] * k, c[2] * k)


# ---------------- 按列预计算：山脊 / 天际线 ----------------
def ridge_cols(seed, amps, freqs, base):
    """几段正弦叠加出的山脊高度（归一化 y，越小越高）"""
    rnd = random.Random(seed)
    phases = [rnd.uniform(0, 2 * math.pi) for _ in amps]
    cols = []
    for x in range(W):
        nx = x / W
        h = base
        for a, f, ph in zip(amps, freqs, phases):
            h -= a * math.sin(f * 2 * math.pi * nx + ph)
        cols.append(h)
    return cols


def skyline_cols(seed, top, min_h, max_h):
    """城市天际线：随机宽度的方块，高度阶梯变化"""
    rnd = random.Random(seed)
    cols = []
    x = 0
    gaps = []
    while x < W:
        bw = rnd.randint(int(W * 0.035), int(W * 0.085))
        h = rnd.uniform(min_h, max_h)
        gaps.append((x, x + bw, h))
        x += bw + rnd.randint(2, 8)
    for x in range(W):
        h = top + 0.02
        for (a, b, hh) in gaps:
            if a <= x < b:
                h = top - hh
                break
        cols.append(h)
    return cols


# ---------------- 配方 ----------------
# sky:(上色, 下色)  glow/disc/cloud/ridge(可两层)/water
COVERS = [
    {   # 1 深空蓝：满月 + 山脊
        "sky": ((10, 22, 58), (32, 64, 132)),
        "sun": {"cx": .70, "cy": .25, "r": .105, "col": (226, 238, 255), "glow": (120, 170, 250), "gk": 2.4, "gs": .55},
        "ridges": [
            {"seed": 11, "amps": [.045, .022, .012], "freqs": [1.1, 2.7, 5.3], "base": .58, "col": (24, 44, 92), "k": .82},
            {"seed": 29, "amps": [.055, .026, .014], "freqs": [.7, 1.9, 4.1], "base": .71, "col": (8, 16, 38), "k": 1.0},
        ],
        "vignette": .46,
    },
    {   # 2 洋红：落日 + 水面倒影
        "sky": ((34, 8, 30), (150, 46, 92)),
        "sun": {"cx": .50, "cy": .44, "r": .145, "col": (255, 214, 232), "glow": (255, 110, 170), "gk": 2.0, "gs": .60},
        "clouds": [{"y": .52, "h": .022, "x": .30, "w": .55, "col": (255, 168, 208), "s": .30},
                   {"y": .565, "h": .014, "x": .62, "w": .48, "col": (255, 148, 196), "s": .26}],
        "water": {"y0": .61, "dark": .52, "streak": .10},
        "vignette": .44,
    },
    {   # 3 青绿：极光带 + 山脊
        "sky": ((6, 24, 28), (16, 92, 82)),
        "sun": {"cx": .64, "cy": .30, "r": .075, "col": (222, 255, 246), "glow": (70, 226, 190), "gk": 2.6, "gs": .45},
        "clouds": [{"y": .20, "h": .030, "x": .50, "w": .80, "col": (86, 236, 200), "s": .26},
                   {"y": .30, "h": .018, "x": .28, "w": .62, "col": (120, 255, 216), "s": .20}],
        "ridges": [
            {"seed": 5, "amps": [.050, .024, .013], "freqs": [.9, 2.3, 4.7], "base": .62, "col": (18, 72, 66), "k": .85},
            {"seed": 41, "amps": [.060, .028, .015], "freqs": [.6, 1.7, 3.9], "base": .74, "col": (4, 22, 22), "k": 1.0},
        ],
        "vignette": .44,
    },
    {   # 4 琥珀：巨日 + 城市天际线
        "sky": ((26, 12, 4), (150, 76, 18)),
        "sun": {"cx": .68, "cy": .52, "r": .190, "col": (255, 224, 172), "glow": (255, 168, 76), "gk": 1.9, "gs": .62},
        "ridges": [
            {"skyline": {"seed": 77, "top": .62, "min_h": .10, "max_h": .26}, "col": (30, 14, 4), "k": .95},
            {"skyline": {"seed": 91, "top": .74, "min_h": .06, "max_h": .16}, "col": (14, 6, 2), "k": 1.0},
        ],
        "vignette": .48,
    },
    {   # 5 紫：星峰 + 光带
        "sky": ((14, 10, 42), (64, 48, 140)),
        "sun": {"cx": .28, "cy": .22, "r": .070, "col": (228, 220, 255), "glow": (150, 120, 255), "gk": 2.6, "gs": .50},
        "clouds": [{"y": .26, "h": .026, "x": .70, "w": .70, "col": (168, 148, 255), "s": .24}],
        "ridges": [
            {"seed": 13, "amps": [.048, .024, .012], "freqs": [1.0, 2.5, 5.1], "base": .60, "col": (38, 28, 88), "k": .85},
            {"seed": 63, "amps": [.058, .027, .014], "freqs": [.65, 1.8, 4.3], "base": .73, "col": (10, 7, 28), "k": 1.0},
        ],
        "vignette": .46,
    },
    {   # 6 绛红：低日 + 沙丘
        "sky": ((30, 8, 8), (156, 40, 36)),
        "sun": {"cx": .44, "cy": .56, "r": .150, "col": (255, 214, 196), "glow": (255, 108, 92), "gk": 2.0, "gs": .58},
        "ridges": [
            {"seed": 3, "amps": [.026, .012, .006], "freqs": [.55, 1.3, 3.1], "base": .62, "col": (92, 26, 24), "k": .90},
            {"seed": 55, "amps": [.032, .015, .008], "freqs": [.4, 1.0, 2.4], "base": .75, "col": (30, 7, 7), "k": 1.0},
        ],
        "vignette": .46,
    },
]


def render(recipe):
    c1, c2 = recipe["sky"]
    sun = recipe.get("sun")
    clouds = recipe.get("clouds") or []
    ridges = []
    for r in recipe.get("ridges") or []:
        if "skyline" in r:
            cols = skyline_cols(r["skyline"]["seed"], r["skyline"]["top"],
                                r["skyline"]["min_h"], r["skyline"]["max_h"])
        else:
            cols = ridge_cols(r["seed"], r["amps"], r["freqs"], r["base"])
        ridges.append((cols, r["col"], r.get("k", 1.0)))
    water = recipe.get("water")
    vig_k = recipe.get("vignette", .46)


    out = bytearray()
    for y in range(H):
        row = bytearray()
        ny = y / H
        base_row = mix(c1, c2, ss(ny))
        if water and ny > water["y0"]:
            # 镜像取样：地平线下方取的是"上方对称位置"的天色，压暗后作为倒影
            my = clamp(water["y0"] - (ny - water["y0"]) * 0.85, 0, 1)
            base_row = shade(mix(c1, c2, ss(my)), 1.0 - water["dark"])
            base_row = shade(base_row, 1.0 + water["streak"] * math.sin(ny * 70.0))
        for x in range(W):
            nx = x / W
            col = list(base_row)
            # 云雾带（软椭圆）
            for cl in clouds:
                dx = (nx - cl["x"]) / cl["w"]
                dy = (ny - cl["y"]) / cl["h"]
                d2 = dx * dx + dy * dy
                if d2 < 4:
                    col = list(mix(col, cl["col"], math.exp(-d2 * 1.6) * cl["s"]))
            # 日/月
            if sun:
                dskin = math.hypot((nx - sun["cx"]) * W, (ny - sun["cy"]) * H)
                r = sun["r"] * W
                g = math.exp(-((dskin / (r * 2.9)) ** 2) * sun["gk"]) * sun["gs"]
                if g > 0.002:
                    col = list(mix(col, sun["glow"], g))
                disc = cov(dskin - r)
                if disc > 0.002:
                    col = list(mix(col, sun["col"], disc * 0.95))
            # 山脊 / 天际线（由远及近覆盖）
            for cols, rcol, rk in ridges:
                hcol = cols[x]
                # cov() 约定「负值=内部」；山脊在轮廓线下方，所以用 (hcol - ny)
                c = cov((hcol - ny) * H)
                if c > 0.002:
                    # 靠上边缘稍亮一点，做出体积感
                    edge = clamp(1.0 - (ny - hcol) * 22.0) * 0.22
                    col = list(mix(col, shade(rcol, rk * (1.0 + edge)), c))
            vx = (nx - .5) * 2
            vy = (ny - .5) * 2
            vig = 1.0 - vig_k * min(1.0, vx * vx * .5 + vy * vy * .5)
            gr = (BAYER4[y & 3][x & 3] / 16.0 - 0.5) * GRAIN
            row += bytes((
                max(0, min(255, int(col[0] * vig + gr))),
                max(0, min(255, int(col[1] * vig + gr))),
                max(0, min(255, int(col[2] * vig + gr))),
            ))
        out += b"\x00" + row
    return bytes(out)


def write_png(path, w, h, rows_bytes):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    hdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", hdr) + \
           chunk(b"IDAT", zlib.compress(rows_bytes, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for i, r in enumerate(COVERS[:N], start=1):
        n = write_png(os.path.join(OUT, f"cover-{i}.png"), W, H, render(r))
        total += n
        print(f"  cover-{i}.png  {n/1024:.0f} KB", flush=True)
    print(f"完成：{min(N, len(COVERS))} 张，合计 {total/1024/1024:.2f} MB → {OUT}")
