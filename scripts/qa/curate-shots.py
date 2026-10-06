"""
QA: keeps a small set of arcade screenshots as 960 px JPEGs (sips, macOS) and deletes the other PNGs,
so docs/qa/shots/arcade stays small enough to commit.

  python3 scripts/qa/curate-shots.py name [name ...]   (names without extension)
"""
import glob
import os
import subprocess
import sys

d = 'docs/qa/shots/arcade'
keep = set(sys.argv[1:])
for name in keep:
    src = os.path.join(d, name + '.png')
    if os.path.exists(src):
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '960', src, '--out', os.path.join(d, name + '.jpg')],
                       check=True, capture_output=True)
for png in glob.glob(os.path.join(d, '*.png')):
    os.remove(png)
print(sorted(os.listdir(d)))
