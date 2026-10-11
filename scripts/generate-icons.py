from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'dist' / 'icons'
image = Image.new('RGB', (1024, 1024), '#244c40')
draw = ImageDraw.Draw(image)
cream = '#faf4de'
draw.line([(276, 496), (748, 496)], fill=cream, width=40)
draw.arc((276, 244, 748, 748), 0, 180, fill=cream, width=40)
draw.line([(430, 812), (594, 812)], fill=cream, width=40)
draw.ellipse((410, 792, 450, 832), fill=cream)
draw.ellipse((574, 792, 614, 832), fill=cream)
for x in (406, 532):
    points = [(x, 390), (x-20, 364), (x-12, 340), (x+16, 314), (x+16, 286), (x, 252)]
    draw.line(points, fill=cream, width=30, joint='curve')
    draw.ellipse((x-15, 375, x+15, 405), fill=cream)
draw.polygon([(626, 400), (610, 350), (622, 298), (656, 260), (716, 244), (764, 250), (754, 310), (730, 356), (690, 389)], fill='#ccda9d')
draw.line([(635, 387), (718, 295)], fill='#244c40', width=14)
for name, size in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / name, optimize=True)
