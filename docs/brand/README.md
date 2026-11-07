# Cadence logo

The approved identity is the three-groove C from concept-01.png, selected by the user after comparing the concepts. The later solid-disc C concepts are exploration, not the app logo.

## Assets

- `apps/ui/public/brand/mark.svg`: transparent apricot groove mark.
- `apps/ui/public/brand/icon.svg`: graphite app tile with the groove mark.
- `apps/ui/public/brand/favicon.png`: 32px browser fallback.
- `apps/desktop/build/icons/icon.png`: 1024px desktop master.
- `apps/desktop/build/icons/icon.ico`: Windows icon with 16–256px representations.
- `apps/desktop/build/icons/icon.icns`: macOS icon.
- `apps/desktop/build/icons/trayTemplate*.png`: monochrome macOS menu-bar images.

The sidebar pairs the vector mark with a lowercase wordmark using the app's bundled display font. The collapsed sidebar shows the symbol alone. The logo color is apricot `#F4A377`; the desktop tile is graphite `#19181B`. Product control colors are independent of the logo.

## Regeneration

Run `python scripts/generate-brand.py` from the repository root with Pillow installed. The script shares one set of arc measurements between the vector and raster exports. Generated assets are checked in, so app builds need no Python dependency.

Electron loads the icons from `build/icons` during development and `resources/icons` when packaged. The packaging configuration also assigns the platform installer icons. Restart the app to load its updated native icons; installed shortcuts receive them when a new package is built and installed.
