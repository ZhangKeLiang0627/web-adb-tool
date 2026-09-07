# web-adb-tool

A browser-side ADB tool powered by **WebUSB**. No driver or `adb` binary needed — open the page and connect to your device. Built for Allwinner / Rockchip Linux boards, and also works with Android devices.

![preview](docs/preview.png)

## Features

- Real terminal — interactive shell based on [xterm.js](https://xtermjs.org/). Direct keyboard input, real-time echo, arrow-key history, Ctrl+C, clear — feels like SSH. Auto-detects `bash` (Tab completion + line editing).
- File manager — directory browsing (name / size / permission), multi-select, mkdir, rename, chmod, breadcrumbs + path-jump. Use `rm` in the Shell pane for deletion.
- File transfer — upload single files / multiple files / whole folders (drag-and-drop supported), download single files, and **recursively zip-and-download entire directories** with live progress and speed.
- Device info — model, product name, system version, SDK, etc.
- Draggable layout — resize handles between Connect / Shell / Files panes (width persisted). Minor columns auto-hide when the file pane gets narrow.
- Theme switch — built-in light / dark skins, terminal palette follows the theme.

## Tech Stack

- Frontend: HTML / CSS / TypeScript + [Vite](https://vite.dev/)
- ADB protocol: [`@yume-chan/adb`](https://github.com/yume-chan/ya-webadb) (pure JS, no WASM)
- Terminal: [`@xterm/xterm`](https://xtermjs.org/) + `@xterm/addon-fit`
- Transport: WebUSB (`@yume-chan/adb-daemon-webusb`)
- Credentials: WebCrypto RSA (`@yume-chan/adb-credential-web`)
- Deployment: GitHub Pages (pure static, no backend)

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build   # output goes to dist/
```

## Deployment

Pushing the `deploy` branch triggers GitHub Actions to build and publish to GitHub Pages:

```
https://<your-account>.github.io/web-adb-tool/
```

## Usage

1. Use a **Chromium-based** browser (Chrome / Edge). WebUSB is not supported by Firefox / Safari.
2. The page must be served over **HTTPS** (or `localhost`). GitHub Pages satisfies this.
3. Close any local process that holds ADB first (`adb kill-server`), otherwise you'll get "Unable to claim interface".
4. Click "Connect", pick your device in the popup, and complete authorization (Linux boards usually skip it).

## Architecture (theming / layout)

- **Theming** — all colors, spacing, radius and font are defined as design tokens (CSS variables) in `src/styles/themes.css`. To add a theme, add a new `[data-theme="xxx"]` block.
- **Layout** — the pane arrangement lives in `src/styles/layout.css` (currently "top bar + 3 columns"). Edit `grid-template-*` to reshape it, no DOM changes needed.
- **Component visuals** — kept in `src/styles/components.css`, referencing tokens only.
- **Protocol decoupling** — all ADB I/O is wrapped in `AdbClient` (`src/core/adb.ts`). The UI never touches the protocol directly.

## Known Limitations

- Wireless ADB (over Wi-Fi) needs a WebSocket relay or a browser extension. A pure static page cannot open TCP sockets directly, so it is not implemented yet.
