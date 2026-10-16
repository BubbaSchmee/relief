"""Draw the app icon: a bold embossed "R" on a dark tile. No fonts, no brand marks:
the letter is plain geometry, so the output is identical on every machine.

  desktop\\.venv\\Scripts\\python.exe -m pip install pillow     (once; the build itself does not need it)
  desktop\\.venv\\Scripts\\python.exe desktop\\make_icon.py

Writes relief.ico (16 to 256 px) beside this script.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024  # drawn large, then scaled down for each size
OUT = Path(__file__).resolve().parent / "relief.ico"


def letter_mask() -> Image.Image:
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    d.rectangle([300, 210, 430, 810], fill=255)  # stem
    d.rounded_rectangle([300, 210, 740, 570], radius=175, fill=255)  # bowl, outer
    d.rectangle([300, 210, 430, 570], fill=255)  # keep the stem's top-left corner square
    d.polygon([(450, 540), (600, 540), (775, 810), (620, 810)], fill=255)  # leg
    d.rounded_rectangle([430, 345, 610, 435], radius=45, fill=0)  # bowl, counter
    return m


def render() -> Image.Image:
    # tile: dark graphite with a soft top light
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.linear_gradient("L").resize((S, S))  # black at the top to white at the bottom
    base = Image.merge("RGB", [grad.point(lambda v, a=a, b=b: round(a + (b - a) * v / 255)) for a, b in ((52, 22), (55, 24), (62, 28))])
    corner = Image.new("L", (S, S), 0)
    ImageDraw.Draw(corner).rounded_rectangle([0, 0, S - 1, S - 1], radius=220, fill=255)
    tile.paste(base, mask=corner)
    ImageDraw.Draw(tile).rounded_rectangle([6, 6, S - 7, S - 7], radius=214, outline=(255, 255, 255, 38), width=4)

    mask = letter_mask()
    # drop shadow under the letter
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 170), mask=mask.filter(ImageFilter.GaussianBlur(14)).transform((S, S), Image.AFFINE, (1, 0, -10, 0, 1, -18)))
    tile.alpha_composite(shadow)

    # the letter: a vertical metal ramp ...
    face = Image.merge("RGBA", [Image.linear_gradient("L").resize((S, S)).point(lambda v, a=a, b=b: round(a + (b - a) * v / 255)) for a, b in ((250, 176), (250, 184), (252, 198))] + [mask])
    tile.alpha_composite(face)
    # ... with a bevel: light on edges facing up-left, shade on edges facing down-right
    k = 16
    up_left = ImageChops.subtract(mask, mask.transform((S, S), Image.AFFINE, (1, 0, -k, 0, 1, -k)))
    down_right = ImageChops.subtract(mask, mask.transform((S, S), Image.AFFINE, (1, 0, k, 0, 1, k)))
    light = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    light.putalpha(up_left.point(lambda v: v * 230 // 255))
    dark = Image.new("RGBA", (S, S), (20, 22, 30, 0))
    dark.putalpha(down_right.point(lambda v: v * 150 // 255))
    tile.alpha_composite(light)
    tile.alpha_composite(dark)
    return tile


if __name__ == "__main__":
    big = render()
    sizes = [(n, n) for n in (16, 24, 32, 48, 64, 128, 256)]
    big.resize((256, 256), Image.LANCZOS).save(OUT, format="ICO", sizes=sizes)
    print(f"wrote {OUT.name}")
