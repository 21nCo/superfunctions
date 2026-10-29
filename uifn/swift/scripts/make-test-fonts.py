"""Writes the brand-neutral test fonts UIFnSwiftUITests registers.

Run with fontTools installed: python3 uifn/swift/scripts/make-test-fonts.py
Each face draws every printable ASCII character as a box, so the files are
tiny and carry no third-party outlines or license.

Core Text registers fonts for the whole process and tests run in parallel, so
each test that depends on which files are registered has its own family, with
its own PostScript names.
"""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

FAMILIES = ["UIFn Test Sans", "UIFn Test Repeat", "UIFn Test Rollback", "UIFn Test Owner"]
FACES = [("Regular", 400), ("Bold", 700)]
OUT = Path(__file__).resolve().parent.parent / "Tests" / "UIFnSwiftUITests" / "Fonts"
# 2024-01-01T00:00:00Z in seconds since 1904-01-01, so the output is reproducible.
TIMESTAMP = 3786825600


def box():
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0))
    pen.lineTo((50, 700))
    pen.lineTo((550, 700))
    pen.lineTo((550, 0))
    pen.closePath()
    return pen.glyph()


def build(family, style, weight):
    names = [".notdef", "space"] + [f"uni{code:04X}" for code in range(0x21, 0x7F)]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x20: "space", **{code: f"uni{code:04X}" for code in range(0x21, 0x7F)}})
    empty = TTGlyphPen(None).glyph()
    glyphs = {name: box() for name in names}
    glyphs["space"] = empty
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (600, 50 if name != "space" else 0) for name in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    postscript = f"{family.replace(' ', '')}-{style}"
    fb.setupNameTable({
        "familyName": family,
        "styleName": style,
        "uniqueFontIdentifier": f"{postscript};1.000",
        "fullName": f"{family} {style}",
        "psName": postscript,
        "version": "Version 1.000",
    })
    fb.setupOS2(
        usWeightClass=weight,
        fsSelection=0x20 if style == "Bold" else 0x40,
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=800,
        usWinDescent=200,
    )
    fb.setupPost()
    fb.font["head"].created = TIMESTAMP
    fb.font["head"].modified = TIMESTAMP
    fb.font["head"].macStyle = 0x01 if style == "Bold" else 0
    OUT.mkdir(parents=True, exist_ok=True)
    fb.save(OUT / f"{postscript}.ttf")


for family in FAMILIES:
    for style, weight in FACES:
        build(family, style, weight)
