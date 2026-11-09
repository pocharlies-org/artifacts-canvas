# artifacts-canvas

A shared, live drawing canvas on top of any published artifact (an HTML page): people annotate it together,
Miro-style, and the canvas keeps who drew what. It is the first plugin of
[`pocharlies-org/artifacts`](https://github.com/pocharlies-org/artifacts).

![The canvas over a sample artifact, three people annotating](docs/screenshots/desktop-1440x900.png)

- **The full toolset**: select / move / resize / rotate / marquee, hand and space-pan, freehand pen with
  pressure-like smoothing, highlighter, eraser, arrows that bind to shapes and follow them, line, text, sticky
  notes, rectangle, ellipse and 17 more shapes, frames, pasted or dropped images, and a laser pointer that is
  never stored. Style panel with 12 colours, fills, strokes (solid, dashed, dotted, sketchy), sizes, fonts,
  arrowheads, opacity, order, group and lock. Per-user undo, zoom, zoom to fit, minimap.
- **Live**: strokes appear on every screen while they are drawn; live cursors with names; presence avatars;
  *Presentar* (everyone follows the presenter) and *Seguir a* (follow one person).
- **Attribution**: every shape records who created and last edited it, and when. Name tags, a hover card, an
  authors panel with counts and a per-person show/hide toggle, and a history timeline. Attribution is stamped by
  the server, so it cannot be forged.
- **Isolation**: the artifact runs in a sandboxed, opaque-origin iframe (`sandbox="allow-scripts"`), unchanged; the
  drawings are anchored to its content and move with it.
- **Export** to PNG and PDF, current view or the whole artifact.
- Spanish UI by default, English with `?lang=en` (or the server config).

This is a re-implementation of the behaviour of tools like tldraw, written from scratch. It contains no tldraw
code, assets or fonts. Runtime dependencies are MIT-licensed: [Yjs](https://github.com/yjs/yjs),
y-websocket, y-protocols, lib0, [perfect-freehand](https://github.com/steveruizok/perfect-freehand) and
[html-to-image](https://github.com/bubkoo/html-to-image).

## Layout

| Path | What |
|---|---|
| `client/` | The wrapper page: TypeScript + SVG, no framework, built with Vite. |
| `server/` | The canvas service (rooms, authz with the core, persistence). |
| `chart/` | Helm chart. |
| `docs/design.md` | Product decisions and design. |
| `docs/protocol.md` | The client ⇄ server contract: routes, frame, WebSocket messages, attribution, document schema. |
| `docs/mockups/` | The approved UI mockup. |

## Client development

Requires Node 22+.

```sh
cd client
npm install
npm run dev          # http://127.0.0.1:5173/ -> the sample artifact with the canvas
```

`npm run dev` serves the client, a sample artifact (`client/dev/artifacts/`) through the same frame route the
service uses, and an in-memory reference room server (`client/dev/yroom.ts`) that implements
`docs/protocol.md`, attribution stamping included. Open the same URL in two windows to collaborate; add
`?as=Your%20Name` to pick a development identity (without it you are an anonymous visitor), `?room=x` for a
separate room and `?lang=en` for English.

```sh
npm run typecheck
npm test             # unit tests (vitest)
npx playwright install chromium
npm run e2e          # end-to-end, two browser contexts against the dev stack (Playwright)
npm run build        # dist/, served by the service under /_canvas/_/
```

Keyboard: V select, H hand (or hold Space), D pen, ⇧D highlighter, E eraser, A arrow, L line, T text, N note,
R rectangle, O ellipse, F frame, K laser, ⌘Z / ⇧⌘Z undo/redo, ⌘A, ⌘D duplicate, ⌘G / ⇧⌘G group, ⇧L lock,
[ / ] back/front, ⇧1 zoom to fit, ⇧0 100%, Delete, Esc.

## License

Apache License 2.0. Copyright 2026 Daniel Ibáñez. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
