# Fork notes

This repository is an **unofficial fork** of
[pablostanley/yoinks](https://github.com/pablostanley/yoinks). The original
terminal app is MIT-licensed; this fork keeps it and adds a local web UI.

It is not affiliated with, sponsored by, or endorsed by the original author.

## Published

The public fork is live:

- **Public fork:** https://github.com/IvanBurenin/yoinks-web-mod (fork of `pablostanley/yoinks`)
- **Private backup:** https://github.com/IvanBurenin/yoinks-web-mod-private
- **Branches:** both `main` branches point at the same upstream-based history
- **Author:** `vanombus <140816814+IvanBurenin@users.noreply.github.com>`
- `origin` = private backup (SSH)
- `public` = public fork (SSH)
- `upstream` = original project
- The old ZIP-root history is kept locally as `main-root-backup` and is not pushed.

### Daily workflow

Make changes on `main`, then update both repositories:

```sh
git push public main    # public fork
git push origin main    # private backup
```

### Sync with upstream

```sh
git fetch upstream
git merge upstream/main
git push public main
git push origin main
```

If you need to change the author of the latest commit, use:

```sh
git commit --amend --reset-author
```

and force-push both remotes. For older commits, prefer `git filter-repo` or ask
for help before rewriting public history.

## What changed

- `src/server.ts` — local HTTP server, queue scheduler, library API, settings,
  diagnostics, SSE events, file streaming.
- `src/lib/store.ts` — persisted jobs/settings/library at
  `~/.yoinks/web-state.json`.
- `src/lib/ytdlp.ts` — H.264-first format selection, H.265/AV1/VP9 detection
  and optional conversion, playlist probing, cookies-from-browser, UTF-8 output
  paths, process-tree cleanup on cancel.
- `web/` — the web UI (queue, library, settings, PWA, notifications).
- `assets/icon-192.png`, `assets/icon-512.png` — PWA icons.
- `package.json` — web scripts, `qrcode` dependency, fork metadata.

Everything else is inherited from upstream.

## Before publishing your fork

1. Identity is filled in for **IvanBurenin / vanombus**. Change it if you
   prefer a different public name or email.
2. Decide on the package name. This fork uses `yoinks-web` so it does not
   collide with the upstream `yoinks` package on npm.
3. Decide what to do with the `yoinks` binary:
   - it is convenient if this fork replaces the original package globally;
   - it shadows the upstream CLI if both are installed.
   - `yoinks-web` is always safe.
4. If you plan to distribute this fork widely, consider renaming it and
   replacing `assets/logo-*.svg`. MIT does not grant trademark rights to the
   original name or logo. For a personal fork, an "unofficial fork" disclaimer
   is usually enough.
5. Do **not** commit:
   - `node_modules/`, `dist/`, logs
   - downloaded media, `*.part` files
   - `~/.yoinks/web-state.json` (already outside the repo)
   - cookies, tokens, `.env` files
6. Optionally add a short demo screenshot/GIF of the web UI to the README.
   Crop browser tabs and personal paths first.

## Public fork

The fork is live at
https://github.com/IvanBurenin/yoinks-web-mod. It is a true GitHub fork of
`pablostanley/yoinks`, the default branch is `main`, and upstream history is
preserved. The private backup is
https://github.com/IvanBurenin/yoinks-web-mod-private.

Push changes with:

```sh
git push public main
git push origin main
```

## Syncing with upstream

```sh
git fetch upstream
git merge upstream/main
# or: git rebase upstream/main
```

Likely conflict points: `README.md`, `package.json`, `src/lib/ytdlp.ts`,
`src/app.tsx`. Keep the web UI files and re-apply upstream extractor fixes.

## Issue routing

- Web UI, queue, library, settings, PWA, API — issues in this fork.
- Original terminal CLI, yt-dlp extraction, format availability — upstream
  [issues](https://github.com/pablostanley/yoinks/issues).

## License and attribution

- Original code: Copyright (c) 2026 Pablo Stanley.
- Fork modifications: Copyright (c) 2026 vanombus.
- License: MIT. Keep the full text in `LICENSE` and the copyright notice in
  source/package distributions.
- The original README, screenshots and logo remain the work of the original
  author; keep the links and attribution.

## Optional GitHub setup

- Description: `Unofficial web UI fork of yoinks — queue, library, PWA`
- Topics: `yt-dlp`, `video-downloader`, `web-ui`, `pwa`, `self-hosted`
- Release tag: `v0.4.0`
- CI: `npm ci && npm run typecheck && npm test && npm run build`
- Do not upload downloaded media or build artifacts to releases.
