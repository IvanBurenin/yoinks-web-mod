# Fork notes

This repository is an **unofficial fork** of
[pablostanley/yoinks](https://github.com/pablostanley/yoinks). The original
terminal app is MIT-licensed; this fork keeps it and adds a local web UI.

It is not affiliated with, sponsored by, or endorsed by the original author.

## Chosen publishing plan: private now, public fork later

The private repository is live and the first commit is pushed:

- Repository: `https://github.com/IvanBurenin/yoinks-web-mod` (private)
- Branch: `main`
- `origin`: `git@github.com:IvanBurenin/yoinks-web-mod.git` (SSH)
- `upstream`: `https://github.com/pablostanley/yoinks.git`
- Author: `vanombus <bureninivan792@gmail.com>`

No public fork has been created yet.

### Fork-ready history

The private `main` branch was created from a ZIP snapshot, so it has no shared
history with upstream. A separate `public-main` branch is prepared locally for
the future public fork: its parent is `upstream/main`, and its tree is this
fork. Push that branch — not the private `main` — to the fork:

```sh
git remote add public https://github.com/IvanBurenin/yoinks.git
git push public public-main:main
```

If you want the public fork to keep the `yoinks-web-mod` name, rename the
private repository to `yoinks-web-mod-private` first, then fork and rename the
fork to `yoinks-web-mod`. The package metadata already points there.

1. The Git identity is already set for this repository:

   ```sh
   git config user.name "vanombus"
   git config user.email "bureninivan792@gmail.com"
   ```

2. When the project is ready to be public, you have two options:

   **A. Make this repository public** (simplest, no fork badge):

   GitHub → repository → Settings → Danger Zone → Change visibility → Make public.

   **B. Create a public fork** (gets the "forked from" badge) and push the same
   branch to it. GitHub will name the fork `yoinks` by default; rename it to
   `yoinks-web-mod` only if you first rename or delete this private repository,
   otherwise the names collide.

   ```sh
   git remote add public https://github.com/IvanBurenin/yoinks.git
   git push -u public main
   ```

   If the public fork ends up under a different name, update the `repository`,
   `homepage` and `bugs` fields in `package.json` and the clone URL in
   `README.md` before announcing it. The private `origin` can stay as a backup
   or be removed.

3. If you later change your public name or email, amend the commit before
   pushing publicly:

   ```sh
   git add README.md LICENSE package.json
   git commit --amend --reset-author
   ```

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

## Creating the public fork (not done yet)

The code is already committed and pushed to the private repository. When you
are ready, use GitHub's **Fork** button on
[pablostanley/yoinks](https://github.com/pablostanley/yoinks). You do not need
to copy the files again — just add the fork as a second remote and push:

```sh
git remote add public https://github.com/IvanBurenin/yoinks.git
git push public public-main:main
```

Use `public-main`, not the private `main`: it is based on `upstream/main` and
therefore fast-forwards cleanly into the fork, while keeping the "forked from"
badge. GitHub will name the fork `yoinks` by default. If you want it under a
different name, rename it in repository settings (or rename the private
repository first if the name collides), then update `package.json` and
`README.md`.

This preserves upstream history and makes syncing easy. If you instead make the
private repository public, it will be a standalone project without the
"forked from" badge.

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
