"""Rebuild the approved groove-C vector and desktop icons (requires Pillow)."""

from pathlib import Path
import math
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'apps/ui/public/brand'
ICONS = ROOT / 'apps/desktop/build/icons'
ARCS = [(90, -56, -264), (66, -65, -290), (42, -76, -282)]
APRICOT = '#f4a377'


def point(radius, angle):
    """Locate a groove endpoint on the shared optical center."""
    radians = math.radians(angle)
    return 132 + radius * math.cos(radians), 128 + radius * math.sin(radians)


def svg(icon=False):
    """Use the same round-ended groove geometry in every vector asset."""
    paths = []
    for radius, start, end in ARCS:
        x1, y1 = point(radius, start)
        x2, y2 = point(radius, end)
        paths.append(f'<path d="M{x1:.3f} {y1:.3f} A{radius} {radius} 0 1 0 {x2:.3f} {y2:.3f}"/>')
    backdrop = '<rect width="256" height="256" rx="56" fill="#19181b"/>' if icon else ''
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' + backdrop + f'<g fill="none" stroke="{APRICOT}" stroke-width="12" stroke-linecap="round">' + ''.join(paths) + '</g></svg>\n'


def raster(size, icon=True, color=APRICOT):
    """Supersample the vector's arcs for crisp small desktop exports."""
    scale = max(4, 1024 // size)
    pixels = size * scale
    unit = pixels / 256
    image = Image.new('RGBA', (pixels, pixels))
    draw = ImageDraw.Draw(image)
    if icon:
        draw.rounded_rectangle((0, 0, pixels - 1, pixels - 1), radius=56 * unit, fill='#19181b')
    width = round(12 * unit)
    for radius, start, end in ARCS:
        # Pillow paints arcs inside their bounds; expand by half the stroke.
        edge = radius * unit + width / 2
        cx, cy = 132 * unit, 128 * unit
        draw.arc((cx - edge, cy - edge, cx + edge, cy + edge), start=end, end=start, fill=color, width=width)
        for angle in (start, end):
            px, py = point(radius, angle)
            x, y = px * unit, py * unit
            half = width / 2
            draw.ellipse((x - half, y - half, x + half, y + half), fill=color)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    """Write committed assets; no image tooling is needed at app runtime."""
    PUBLIC.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)
    (PUBLIC / 'mark.svg').write_text(svg(), encoding='utf-8')
    (PUBLIC / 'icon.svg').write_text(svg(icon=True), encoding='utf-8')
    master = raster(1024)
    master.save(ICONS / 'icon.png')
    master.save(ICONS / 'icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    master.save(ICONS / 'icon.icns', sizes=[(n, n) for n in (16, 32, 64, 128, 256, 512, 1024)])
    raster(44, icon=False, color='#ffffff').save(ICONS / 'trayTemplate@2x.png')
    raster(22, icon=False, color='#ffffff').save(ICONS / 'trayTemplate.png')
    raster(32).save(PUBLIC / 'favicon.png')


if __name__ == '__main__':
    main()
