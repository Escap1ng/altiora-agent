from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUILD.mkdir(parents=True, exist_ok=True)

SIZE = 2048
BLUE_TOP = (59, 130, 246)
BLUE_BOTTOM = (29, 78, 216)
TEXT = (30, 39, 51)
MUTED = (107, 114, 128)
BG = (255, 255, 255)

BOLD = "C:/Windows/Fonts/segoeuib.ttf"
REGULAR = "C:/Windows/Fonts/segoeui.ttf"


def make_master() -> Image.Image:
    gradient = Image.new("RGB", (SIZE, SIZE))
    draw = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(round(BLUE_TOP[i] + (BLUE_BOTTOM[i] - BLUE_TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (SIZE, y)], fill=color)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=470, fill=255)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    font = ImageFont.truetype(BOLD, 1230)
    left, top, right, bottom = draw.textbbox((0, 0), "A", font=font)
    width = right - left
    height = bottom - top
    draw.text(
        ((SIZE - width) / 2 - left, (SIZE - height) / 2 - top - 24),
        "A",
        font=font,
        fill=(255, 255, 255),
    )
    return icon


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


if __name__ == "__main__":
    main()
