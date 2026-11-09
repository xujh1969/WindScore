# Offline notation fonts

These faces approximate a traditional printed jianpu appearance. They are not the
original font used in the JPW reference image.

- `notation-digits.woff2` (21,468 bytes): Arimo, static weight 700, with the
  narrow, base-free numeral one derived from Roboto 700. Latin, punctuation,
  mathematical and music symbols retained where available in Arimo; other
  symbols use system fallback. All digits have advance 1139 per 2048 units per em.
  Zero has ink bounds x=81..1055, y=-20..1430. One is centered at x=293..845 and
  scaled to the same y=-20..1430 extent; its width/height ratio is 552/1450
  (0.381), matching the reference's narrow numeral one. No JPW font was copied.
- `notation-text.woff2` (6,028,756 bytes): Noto Sans SC Regular 2.002, static weight 400. Latin, Chinese
  punctuation, Bopomofo, CJK radicals, CJK Extension A, unified and compatibility
  ideographs retained. The runtime stack prefers locally available Microsoft
  YaHei to best match the reference; Android and other devices without it use
  this freely distributable approximation. Microsoft YaHei is not bundled.
  The mean ink height of 祈/福/那/是 is 888.75 per 1000 units per em; the shared
  lyric size helper targets 1.024 times the numeral-zero ink height. After fonts
  load, a 100px canvas measurement of the actual selected text face replaces this
  default ratio, so local Microsoft YaHei and the bundled fallback keep the same
  visible lyric height. Node or tests without Canvas retain the bundled ratio.
- `notation-title.woff2` (5,514,808 bytes): Noto Serif SC, static weight 400. Latin, Chinese
  punctuation, Bopomofo, CJK radicals, CJK Extension A, unified and compatibility
  ideographs retained. Characters outside the font's coverage use system fallback.

All bundled faces are distributed under SIL Open Font License 1.1. Copyright and full license
texts are in `OFL-Arimo.txt`, `OFL-Roboto.txt`, `OFL-NotoSansSC.txt` and
`OFL-NotoSerifSC.txt` beside the font files.
The modified/subset faces use the internal family names `WindScore Notation
Digits` and `WindScore Notation Text`. The title resource retains its previous
internal text-face name and is registered under the CSS alias `WindScore Notation
Title`. Its stack prefers locally installed SimSun; no SimSun file is bundled.

Official upstream sources retrieved on 2026-11-08/09:

- https://github.com/google/fonts/tree/main/ofl/arimo
- https://github.com/google/fonts/tree/main/ofl/roboto
- https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/SC
- https://github.com/google/fonts/tree/main/ofl/notoserifsc

The Noto Sans SC 2.002 static source was read from the existing local installation
(`C:/Windows/Fonts/Noto Sans SC (TrueType).otf`); its embedded copyright is
2014–2020 Adobe and its embedded license is SIL OFL 1.1. The other sources were
retrieved from the official repositories above.

Processing: fontTools 4.57.0 `instantiateVariableFont` at the weights above,
then `fontTools.subset` with WOFF2/Brotli compression. Original variable TTF files
are not required at runtime. The WOFF2 files are bundled with browser, Android and
desktop builds and make no network font requests.
