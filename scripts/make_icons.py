"""Generate original geometric Twinkle icons. Development only: requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "extension" / "icons"
root.mkdir(parents=True, exist_ok=True)
size = 512
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((4, 4, 508, 508), radius=128, fill="#222033")
draw.polygon([(248, 76), (292, 202), (420, 248), (292, 294),
              (248, 422), (204, 294), (76, 248), (204, 202)], fill="#b4a0ff")
draw.polygon([(390, 64), (405, 105), (448, 120), (405, 135),
              (390, 178), (375, 135), (334, 120), (375, 105)], fill="#83e6cc")
for edge in (16, 32, 48, 128):
    if edge == 128:
        icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        icon.paste(image.resize((96, 96), Image.Resampling.LANCZOS), (16, 16))
    else:
        icon = image.resize((edge, edge), Image.Resampling.LANCZOS)
    icon.save(root / f"{edge}.png")
print("Generated 4 icons.")
