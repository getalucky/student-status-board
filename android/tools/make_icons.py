"""生成 App 图标（自绘，不依赖素材）。

产出：
  res/mipmap-<density>/ic_launcher.png         传统图标（API 24/25 用）
  res/mipmap-<density>/ic_launcher_foreground.png  自适应图标前景（API 26+ 用，透明背景）
  res/mipmap-anydpi-v26/ic_launcher.xml        自适应图标描述
  res/values/ic_launcher_background.xml        自适应图标底色

图形：蓝色圆角底 + 白色看板卡片 + 三行条目 + 一个勾。
"""
from PIL import Image, ImageDraw
import os

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "app", "src", "main", "res")

BLUE = (37, 99, 235, 255)      # #2563EB
BLUE_DARK = (30, 64, 175, 255)  # #1E40AF
WHITE = (255, 255, 255, 255)
MUTED = (219, 234, 254, 255)   # #DBEAFE
GREEN = (34, 197, 94, 255)     # #22C55E

DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}


def draw_glyph(img, size, scale=1.0):
    """在 size×size 画布上画看板图形；scale 控制内容占比（自适应图标要留安全区）。"""
    d = ImageDraw.Draw(img)
    u = size / 100.0 * scale          # 以 100 为设计单位
    cx, cy = size / 2, size / 2

    card_w = 58 * u
    card_h = 50 * u
    left = cx - card_w / 2
    top = cy - card_h / 2
    r = 8 * u

    d.rounded_rectangle([left, top, left + card_w, top + card_h],
                        radius=r, fill=WHITE)

    # 三行条目：小方块 + 横线
    row_h = 7 * u
    gap = 4.5 * u
    pad_x = 7 * u
    first_y = top + 10 * u
    for i in range(3):
        y = first_y + i * (row_h + gap)
        d.rounded_rectangle([left + pad_x, y,
                             left + pad_x + row_h, y + row_h],
                            radius=2 * u, fill=BLUE if i else GREEN)
        line_x = left + pad_x + row_h + 4 * u
        d.rounded_rectangle([line_x, y + 1.4 * u,
                             left + card_w - pad_x, y + row_h - 1.4 * u],
                            radius=2 * u, fill=MUTED)


def legacy_icon(size):
    """传统图标：满幅蓝色圆角方 + 白色卡片图形。"""
    ss = 4  # 超采样，边缘更干净
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1],
                        radius=size * ss * 0.22, fill=BLUE)
    # 顶部一道深色装饰，避免死板
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss * 0.42],
                        radius=size * ss * 0.22, fill=BLUE_DARK)
    d.rectangle([0, size * ss * 0.22, size * ss - 1, size * ss * 0.42],
                fill=BLUE_DARK)
    draw_glyph(big, size * ss, scale=0.82)
    return big.resize((size, size), Image.LANCZOS)


def foreground_icon(size):
    """自适应图标前景：透明底，内容缩到中间 66%（108dp 安全区）。"""
    ss = 4
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    draw_glyph(big, size * ss, scale=0.62)
    return big.resize((size, size), Image.LANCZOS)


def main():
    for density, size in DENSITIES.items():
        out_dir = os.path.join(BASE, "mipmap-" + density)
        os.makedirs(out_dir, exist_ok=True)
        legacy_icon(size).save(os.path.join(out_dir, "ic_launcher.png"), "PNG")
        foreground_icon(size).save(os.path.join(out_dir, "ic_launcher_foreground.png"), "PNG")
        print("wrote", out_dir, size)

    anydpi = os.path.join(BASE, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)
    with open(os.path.join(anydpi, "ic_launcher.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background" />\n'
                '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
                '</adaptive-icon>\n')

    values = os.path.join(BASE, "values")
    os.makedirs(values, exist_ok=True)
    with open(os.path.join(values, "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<resources>\n'
                '    <color name="ic_launcher_background">#2563EB</color>\n'
                '</resources>\n')
    print("wrote adaptive icon xml")


if __name__ == "__main__":
    main()
