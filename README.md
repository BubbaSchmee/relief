# RELIEF

Drop in a flat logo and get a transparent video of it as a 3D object, spinning or rocking, ready to lay over your own footage. RELIEF traces the logo, builds a closed 3D mesh that keeps the exact brand colours, plays the loop live, and exports a ProRes 4444, transparent WebM or PNG-sequence file. Everything happens in your browser: nothing is uploaded. No machine learning, no account, free and open source.

**Try it: <https://bubbaschmee.github.io/relief/>**

## What you can do

- Load an SVG, PNG, JPEG or WebP. Flat colours work best. Multi-colour logos become stacked layers.
- Shape it: extrude, bevel, inflate, layer depth.
- Choose the motion (spin or rock), loop length, tilt, hover, size and frame rate. The loop is seamless: the last frame leads straight into the first.
- Export a transparent video, or a `.glb` of the 3D model.
- "Unlit front" gives the exact brand colour with no shading, for when the colour is contractual. The default look is glossy, with chrome sides.

## Run it locally

**As an app on your own machine:** on Windows, double-click `RELIEF.bat`; anywhere, run `pnpm app`. It builds RELIEF, serves it on `http://127.0.0.1:5180/` (reachable from your machine only) and opens it in your browser. Your logo never leaves your computer, and everything except ProRes export works offline (ProRes downloads its encoder the first time you use it). Close the window to stop it.

**For development:**

```
pnpm install
pnpm dev          # the app, on http://localhost:5173
pnpm test         # unit tests
pnpm typecheck
pnpm build:app    # static site in app/dist
```

Needs Node 22 or newer and [pnpm](https://pnpm.io). The design rationale is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Which format for which editor

Pick your editor under "I'll use it in..." and RELIEF chooses. No single transparent format works in every editor, so there are three.

| You use | Format | Notes |
|---|---|---|
| DaVinci Resolve, Premiere Pro, After Effects, Final Cut Pro, iMovie | ProRes 4444 `.mov` | Up to 1080p. Needs a one-off 32 MB download (see below). Not CapCut. |
| CapCut (desktop), OBS, web pages | Transparent WebM `.webm` | Small and quick. Not Resolve, Premiere or Final Cut. CapCut on a phone varies. |
| Anything else, not sure, or 4K | PNG sequence `.zip` | Opens everywhere, any size. Unzip, import as an image sequence, and set the frame rate written in the file names. |

**An honest note on compatibility.** None of these has yet been tested inside the editors themselves. DaVinci Resolve's row comes from Blackmagic's official codec list and OBS's from its source code; the rest come from documentation and user reports. What *is* verified is the files: transparent corners in every frame, exact colour, no dark edge fringe, a seamless loop. If a format misbehaves in your editor, please open an issue saying which editor and version.

## Third-party software

RELIEF is MIT licensed (see [`LICENSE`](LICENSE)). It uses:

| Package | Licence | Used for |
|---|---|---|
| earcut | ISC | Triangulation |
| clipper2-js | Boost Software License 1.0 | Polygon booleans and offsets |
| svgpath | MIT | SVG path normalisation |
| fflate | MIT | ZIP and PNG compression |
| mediabunny | MPL-2.0 | Transparent WebM (VP9 with alpha) |
| @ffmpeg/ffmpeg | MIT | JavaScript wrapper that drives ffmpeg.wasm |

**@ffmpeg/core (GPL-2.0-or-later) is not part of RELIEF.** Only when you choose ProRes, your browser downloads the ffmpeg.wasm core, version 0.12.10, from the jsDelivr or unpkg CDN. RELIEF checks its SHA-256 before running it. It is never bundled, never installed, and never distributed with RELIEF. Its source is at <https://github.com/ffmpegwasm/ffmpeg.wasm> and <https://ffmpeg.org>.

The PNG sequence and WebM formats never contact a server.

## Licence

[MIT](LICENSE), copyright RELIEF contributors.
