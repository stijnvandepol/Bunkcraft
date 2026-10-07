"""Contact sheet of the centre of aim screenshots: python3 scripts/qa/montage.py out.png dir prefix name1 name2 ... [--crop=x0,y0,x1,y1] [--cols=4]"""
import sys
from PIL import Image, ImageDraw

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = dict(a[2:].split('=') for a in sys.argv[1:] if a.startswith('--'))
out, d, prefix, names = args[0], args[1], args[2], args[3:]
x0, y0, x1, y1 = map(int, opt.get('crop', '480,230,800,490').split(','))
cols = int(opt.get('cols', 4))
scale = float(opt.get('scale', 1.25))
tw, th = int((x1 - x0) * scale), int((y1 - y0) * scale)
rows = (len(names) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * th))
for i, n in enumerate(names):
    im = Image.open(f'{d}/{prefix}-{n}.png').crop((x0, y0, x1, y1)).resize((tw, th), Image.NEAREST)
    ImageDraw.Draw(im).text((4, 4), n, fill=(255, 255, 0))
    sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
sheet.save(out)
