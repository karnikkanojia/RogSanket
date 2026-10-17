#!/usr/bin/env python3
"""
Generate EpiCast app icons (1024x1024).
Design: navy background, teal radial glow, white medical cross, green map-pin overlay.

Usage:
    pip install pillow
    python generate_icon.py
"""
from PIL import Image, ImageDraw
import os, math

SIZE  = 1024
BG    = (15,  23,  42,  255)   # #0F172A  dark navy
TEAL  = (20,  184, 166, 255)   # #14B8A6  teal
GREEN = (34,  197, 94,  230)   # #22C55E  green (slightly transparent)
WHITE = (255, 255, 255, 255)

def lerp_color(a, b, t):
    return tuple(int(a[i] * t + b[i] * (1 - t)) for i in range(4))

def make_icon(size=SIZE):
    img  = Image.new('RGBA', (size, size), BG)
    draw = ImageDraw.Draw(img)
    cx, cy = size // 2, size // 2

    # ── Radial glow: teal center fading to navy ────────────────────────────────
    radius = int(size * 0.40)
    for r in range(radius, 0, -1):
        t = r / radius          # 1.0 at edge (navy), 0.0 at centre (teal)
        c = lerp_color(BG, TEAL, t)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)

    # ── Medical cross (white, rounded ends via overlapping rects + circles) ────
    arm_w  = int(size * 0.110)   # arm half-width  ≈ 113 px
    arm_l  = int(size * 0.230)   # arm half-length ≈ 236 px
    r_end  = arm_w               # radius of rounded end caps

    # Vertical bar
    draw.rectangle([cx - arm_w, cy - arm_l, cx + arm_w, cy + arm_l], fill=WHITE)
    # Horizontal bar
    draw.rectangle([cx - arm_l, cy - arm_w, cx + arm_l, cy + arm_w], fill=WHITE)
    # Round the four outer ends
    for ex, ey in [(cx, cy - arm_l), (cx, cy + arm_l), (cx - arm_l, cy), (cx + arm_l, cy)]:
        draw.ellipse([ex - r_end, ey - r_end, ex + r_end, ey + r_end], fill=WHITE)

    # ── Map pin (lower-right quadrant, green) ──────────────────────────────────
    px  = cx + int(size * 0.175)
    py  = cy + int(size * 0.155)
    pr  = int(size * 0.058)     # outer circle radius ≈ 59 px
    ph  = int(size * 0.052)     # pin-tail height below circle

    # Circle body
    draw.ellipse([px - pr, py - pr, px + pr, py + pr], fill=GREEN)
    # Triangular tail
    draw.polygon(
        [(px, py + pr + ph), (px - pr + 8, py + 8), (px + pr - 8, py + 8)],
        fill=GREEN,
    )
    # White dot in centre
    dot_r = int(pr * 0.40)
    draw.ellipse([px - dot_r, py - dot_r, px + dot_r, py + dot_r], fill=WHITE)

    return img


if __name__ == '__main__':
    os.makedirs('mobile/assets', exist_ok=True)
    icon = make_icon()

    icon.save('mobile/assets/icon.png')
    print('Saved mobile/assets/icon.png')

    # Android adaptive icon needs square image (same design)
    icon.save('mobile/assets/adaptive-icon.png')
    print('Saved mobile/assets/adaptive-icon.png')

    print('Done — 1024×1024 RGBA PNG icons generated.')
