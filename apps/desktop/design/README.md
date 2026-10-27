# Desktop and mobile artwork

The SVGs here are the sources; the PNG, ICNS, ICO and TIFF files in the apps are generated from them.

| Source | Becomes |
|---|---|
| `icon.svg` | The macOS icon (`src-tauri/icons/icon.icns`) on Apple's icon grid, and the mobile web favicon |
| `icon-tight.svg` | The other desktop icons (Windows, Linux) and the web favicon, with a narrow margin |
| `icon-full.svg` | `apps/mobile/assets/icon.png` (iOS rounds the corners itself) |
| `android-*.svg` | The adaptive icon layers in `apps/mobile/assets` |
| `splash.svg` | `apps/mobile/assets/splash-icon.png` |
| `dmg-background.svg` | `src-tauri/dmg/background.tiff`, the macOS installer window |

Regenerate them on macOS from this folder with `rsvg-convert` (Homebrew `librsvg`):

```bash
rsvg-convert -w 1024 icon-tight.svg -o /tmp/tresso-icon.png
rsvg-convert -w 1024 icon.svg -o /tmp/tresso-icon-macos.png
npm run tauri --workspace @tresso/desktop -- icon /tmp/tresso-icon.png
npm run tauri --workspace @tresso/desktop -- icon /tmp/tresso-icon-macos.png -o /tmp/tresso-icons-macos
cp /tmp/tresso-icons-macos/icon.icns ../src-tauri/icons/icon.icns
rm -rf ../src-tauri/icons/android ../src-tauri/icons/ios ../src-tauri/icons/64x64.png
cp ../src-tauri/icons/icon.ico ../../web/public/favicon.ico
```

```bash
rsvg-convert -w 1024 icon-full.svg -o ../../mobile/assets/icon.png
rsvg-convert -w 512 android-background.svg -o ../../mobile/assets/android-icon-background.png
rsvg-convert -w 512 android-foreground.svg -o ../../mobile/assets/android-icon-foreground.png
rsvg-convert -w 512 android-monochrome.svg -o ../../mobile/assets/android-icon-monochrome.png
rsvg-convert -w 1024 splash.svg -o ../../mobile/assets/splash-icon.png
rsvg-convert -w 48 icon.svg -o ../../mobile/assets/favicon.png
```

The installer background is one TIFF with a 1x and a 2x image, so it stays sharp on Retina screens:

```bash
rsvg-convert -w 660 dmg-background.svg -o /tmp/dmg.png
rsvg-convert -w 1320 dmg-background.svg -o /tmp/dmg@2x.png
tiffutil -cathidpicheck /tmp/dmg.png /tmp/dmg@2x.png -out ../src-tauri/dmg/background.tiff
```

Its text uses the system font, so render it on a Mac to keep the same letters.
