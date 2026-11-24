# SiteClass v2 — Workspace Context

## Stack
- React 19 + TypeScript + Vite 6 + Tailwind CSS v4
- Offline-first PWA (`public/sw.js`, `public/manifest.webmanifest`)
- Local persistence: `localStorage` (`siteclass.projects.v2`) + IndexedDB (`siteclass` / `blobs`)

## Architecture Rules
- Never buffer all full-resolution photo blobs into an array during export; use `createStreamingZipBlob` in `src/zipStream.ts`.
- Always release temporary `<canvas>` buffers (`width = 0; height = 0`) and close `ImageBitmap` instances after drawing.
- Keep `field_notes.md` and `photo_manifest.json` schemas backward-compatible with downstream Phase I ESA / PCA Antigravity report pipelines.
- Ignore `node_modules/` and `dist/` during codebase scans.
