from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUILD.mkdir(parents=True, exist_ok=True)

SIZE = 2048
SS = 4
CANVAS = SIZE * SS

INK_TOP = (38, 41, 46)
INK_BOTTOM = (16, 17, 20)
GLYPH = (255, 255, 255)
TEXT = (26, 28, 30)
MUTED = (138, 143, 152)
BG = (255, 255, 255)

BOLD = "C:/Windows/Fonts/segoeuib.ttf"
REGULAR = "C:/Windows/Fonts/segoeui.ttf"

RADIUS = 0.225
BASE_Y = 0.715
MAIN_PEAK = ((0.175, BASE_Y), (0.425, 0.29), (0.675, BASE_Y))
SIDE_PEAK = ((0.545, BASE_Y), (0.705, 0.475), (0.865, BASE_Y))


def scale(point: tuple[float, float]) -> tuple[float, float]:
    return (point[0] * CANVAS, point[1] * CANVAS)


def make_master() -> Image.Image:
    gradient = Image.new("RGB", (CANVAS, CANVAS))
    draw = ImageDraw.Draw(gradient)
    for y in range(CANVAS):
        t = y / (CANVAS - 1)
        color = tuple(round(INK_TOP[i] + (INK_BOTTOM[i] - INK_TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (CANVAS, y)], fill=color)

    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, CANVAS - 1, CANVAS - 1], radius=round(RADIUS * CANVAS), fill=255
    )

    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    for peak in (SIDE_PEAK, MAIN_PEAK):
        draw.polygon([scale(point) for point in peak], fill=GLYPH)

    return icon.resize((SIZE, SIZE), Image.LANCZOS)


def paste_icon(canvas: Image.Image, icon: Image.Image, xy: tuple[int, int], size: int) -> None:
    scaled = icon.resize((size, size), Image.LANCZOS)
    canvas.paste(scaled, xy, scaled)


def make_installer_header(icon: Image.Image) -> Image.Image:
    header = Image.new("RGB", (150, 57), BG)
    paste_icon(header, icon, (10, 10), 37)
    draw = ImageDraw.Draw(header)
    font = ImageFont.truetype(BOLD, 20)
    draw.text((58, 29), "Altiora", font=font, fill=TEXT, anchor="lm")
    return header


def make_installer_sidebar(icon: Image.Image) -> Image.Image:
    sidebar = Image.new("RGB", (164, 314), BG)
    paste_icon(sidebar, icon, (46, 42), 72)
    draw = ImageDraw.Draw(sidebar)
    title = ImageFont.truetype(BOLD, 17)
    tagline = ImageFont.truetype(REGULAR, 11)
    draw.text((82, 134), "Altiora", font=title, fill=TEXT, anchor="mm")
    draw.text((82, 156), "coding agent", font=tagline, fill=MUTED, anchor="mm")
    return sidebar


def main() -> None:
    icon = make_master()
    icon.save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    make_installer_header(icon).save(BUILD / "installerHeader.bmp")
    make_installer_sidebar(icon).save(BUILD / "installerSidebar.bmp")
    icon.resize((512, 512), Image.LANCZOS).save(BUILD / "icon.png")
    print("wrote", BUILD / "icon.ico")
    print("wrote", BUILD / "installerHeader.bmp")
    print("wrote", BUILD / "installerSidebar.bmp")
    print("wrote", BUILD / "icon.png")


if __name__ == "__main__":
    main()
