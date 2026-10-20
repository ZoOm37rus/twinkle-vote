"""Generate original geometric Twinkle icons. Development only: requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "extension" / "icons"
root.mkdir(parents=True, exist_ok=True)
size = 512
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((4, 4, 508, 508), radius=88, fill="#22272B")
draw.rectangle((100, 112, 412, 188), fill="#E8EAEB")
draw.rectangle((218, 188, 294, 404), fill="#E8EAEB")
draw.rectangle((338, 330, 412, 404), fill="#C99B65")
for edge in (16, 32, 48, 128):
    if edge == 128:
        icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        icon.paste(image.resize((96, 96), Image.Resampling.LANCZOS), (16, 16))
    else:
        icon = image.resize((edge, edge), Image.Resampling.LANCZOS)
    icon.save(root / f"{edge}.png")
print("Generated 4 icons.")
