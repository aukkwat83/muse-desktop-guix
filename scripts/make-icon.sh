#!/usr/bin/env bash
# Build assets/icon.png (1024²) from ImageMagick primitives.
#
# Deliberately not rendered from assets/icon.svg: ImageMagick's built-in SVG
# renderer silently discards gradients, masks and radial glows (it needs an
# rsvg-convert delegate that is not installed here), so an SVG-derived icon
# comes out as flat shapes on black. Drawing directly keeps this reproducible
# on a bare machine. assets/icon.svg stays as the design reference.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/assets/icon.png"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BG_TOP='#10294f'
BG_BOTTOM='#050a18'
SPARK_TOP='#f2feff'
SPARK_BOTTOM='#2f7de1'
ACCENT='#38bdf8'
INK='#eaf6ff'

# 4-point sparkle with concave quadratic sides + a small satellite spark.
SPARK_PATH="M 512,130 Q 573,339 782,400 Q 573,461 512,670 Q 451,461 242,400 Q 451,339 512,130 Z"
SPARK_SAT="M 770,590 Q 781,629 820,640 Q 781,651 770,690 Q 759,651 720,640 Q 759,629 770,590 Z"

# 1. Rounded-square base with a vertical gradient.
magick -size 1024x1024 "gradient:${BG_TOP}-${BG_BOTTOM}" "$TMP/bg.png"
magick -size 1024x1024 xc:black -fill white \
  -draw "roundrectangle 0,0 1023,1023 228,228" "$TMP/round.png"
magick "$TMP/bg.png" "$TMP/round.png" -alpha off -compose CopyOpacity -composite "$TMP/base.png"

# 2. Soft glow behind where the spark will sit.
#    Composited Over, not Screen: Screen ignores the gradient's alpha ramp and
#    renders the glow as a hard-edged disc that swallows the mark.
magick -size 900x900 "radial-gradient:${ACCENT}-none" -alpha set \
  -channel A -evaluate multiply 0.25 +channel -blur 0x24 "$TMP/glow.png"
magick "$TMP/base.png" "$TMP/glow.png" -geometry +62-50 -compose Over -composite "$TMP/lit.png"

# 3. Spark: a gradient sheet with the sparkle punched into its alpha.
magick -size 1024x1024 "gradient:${SPARK_TOP}-${SPARK_BOTTOM}" "$TMP/sparkgrad.png"
magick -size 1024x1024 xc:black \
  -fill white -draw "path '${SPARK_PATH}'" \
  -fill white -draw "path '${SPARK_SAT}'" "$TMP/spark-mask.png"
magick "$TMP/sparkgrad.png" "$TMP/spark-mask.png" \
  -alpha off -compose CopyOpacity -composite "$TMP/spark.png"
magick "$TMP/lit.png" "$TMP/spark.png" -compose Over -composite "$TMP/sparked.png"

# 4. Shell prompt mark — this is a coding agent, not a chat toy.
magick "$TMP/sparked.png" \
  -fill none -stroke "$INK" -strokewidth 34 \
  -draw "stroke-linecap round stroke-linejoin round polyline 340,716 424,772 340,828" \
  -stroke none -fill '#7dd3fc' \
  -draw "roundrectangle 466,800 696,830 15,15" \
  "$TMP/marked.png"

# 5. Re-apply the corner mask so nothing bleeds past the squircle.
magick "$TMP/marked.png" "$TMP/round.png" -alpha off -compose CopyOpacity -composite \
  -strip "$OUT"

cp -f "$OUT" "$ROOT/src/renderer/icon.png"
cp -f "$OUT" "$ROOT/macos/MuseDesktopShell/Sources/MuseDesktopShell/Resources/icon.png"
echo "icon → $OUT ($(magick identify -format '%wx%h' "$OUT"))"
