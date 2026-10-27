#!/usr/bin/env python3
"""Makes the Home Screen icons in docs/icons from tools/AppIcon-1024.png (needs Pillow).

Run from the project folder:  python3 tools/make_icons.py
The source has no transparency on purpose: iPhone fills transparent corners with black.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools' / 'AppIcon-1024.png'
OUT = ROOT / 'docs' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)

image = Image.open(SOURCE).convert('RGB')
for name, size in (('apple-touch-icon.png', 180), ('icon-192.png', 192), ('icon-512.png', 512)):
    image.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    print('wrote', OUT / name)
