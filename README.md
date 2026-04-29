# yt-fetch

Get your YouTube watch history as formatted text, JSON, or YAML — **no API key, no Google Cloud project, no manual cookie export**.

`yt-fetch` finds your already-signed-in browser sessions, reads their cookies (decrypting them locally using your OS's own credential store), and loads your history page in a temporary private browser window. Everything runs on your machine.

## What you get

```
────────────────────────────────────────────────────────────
  ▶ 47 videos in watch history
────────────────────────────────────────────────────────────

  The Art of Code (1:00:49)
  Dylan Beattie · 1.8M views
  https://youtu.be/6avJHaC3C2U

  Inventing on Principle (54:20)
  Bret Victor · 2.2M views
  https://youtu.be/PUv66718DII

  Bun 1.0 (1:10:44)
  Jarred Sumner · 520K views
  https://youtu.be/BsnCpESUEqM
```

Or pipe to other tools:

```sh
bin/yt -q --output json | jq '[.[] | {title, url}]'
```

## Before you run

Make sure you are **signed in to YouTube** in at least one supported browser on this machine. `yt-fetch` reads your existing session — it does not log in for you.

## Quick Start

**1. Install Bun** (an all-in-one JavaScript runtime optimized for performance — [bun.sh](https://bun.sh)):

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Already have Bun? Skip to step 2.

**2. Clone and run:**

```sh
git clone https://github.com/specious/yt-fetch
cd yt-fetch
bun install    # also downloads the headless Chromium used for scraping (~300 MB)
bin/yt
```

`yt-fetch` scans your browsers automatically and picks the best signed-in session. No configuration needed.

### Windows

```powershell
git clone https://github.com/specious/yt-fetch
cd yt-fetch
bun install
bun .\bin\yt
```

Windows has no shebang equivalent, so prefix with `bun`. To create a plain `yt` command, save a `yt.cmd` file somewhere on your PATH:

```bat
@bun "C:\full\path\to\yt-fetch\bin\yt" %*
```

**Firefox and Opera work out of the box.** Chrome and Edge do not — see [below](#chrome-and-edge-on-windows--v20-encryption).

## Features

- **Zero configuration** — detects your installed browsers and profiles, picks the best signed-in session automatically
- **Fully local** — cookies are decrypted on your machine using the same OS credential store that already protects them; nothing leaves your machine
  - Firefox: cookies are stored in plaintext — no keyring, no prompt
  - Chrome, Edge, Brave, Opera: decrypted via macOS Keychain, Linux libsecret/KWallet, or Windows DPAPI
- **Multiple output formats** — human-readable (default), JSON, YAML
- **Interactive session picker** — `-i` to choose which browser profile to use
- **Debug tooling** — `--dry-run` verifies cookie extraction without opening a browser; `--debug` shows every stage of the pipeline

## Platform Notes

### macOS

All browsers work. You may see one or two Keychain prompts when using Chrome, Edge, Brave, or Opera — click **Allow** or **Always Allow** on each.

### Linux

All browsers work. Chrome-based browsers read their decryption key from whichever secret store was active when you first launched that browser:

- **GNOME Keyring** (libsecret) — queried automatically, no prompt
- **KWallet** — queried automatically via `kwallet-query`
- **No keyring** (basic mode) — works without any keyring daemon

Firefox always stores cookies in plaintext and needs no keyring at all.

### Windows (native)

**Firefox and Opera work out of the box.** Chrome and Edge do not — see below.

#### Chrome and Edge on Windows — v20 encryption

Chrome 127+ and Edge 127+ switched to **app-bound (v20) cookie encryption**, where the AES key is held by an OS elevation service (`IElevator` COM) that only the browser process itself can call. There is no practical way to decrypt these cookies from outside the browser.

```
  ✔  21 v20
  ⚠  All cookies use v20 app-bound encryption (Chrome/Edge 130+ blocks offline decryption)
     → Use Firefox instead:  bun .\bin\yt -b firefox
```

**Workaround:** Use Firefox on Windows. Firefox stores cookies in plaintext — no encryption, no keyring, no elevation service.

#### Opera on Windows

Opera uses DPAPI (v10) encryption and works correctly. Opera Developer is also supported.

### WSL (Windows Subsystem for Linux)

WSL is Microsoft's compatibility layer that lets you run Linux tools directly on Windows. `yt-fetch` works in WSL and gets the best of both worlds: it scans both Linux-native browser profiles **and** Windows-native profiles under `/mnt/c/Users/*/AppData/`.

#### Reading cookies

Cookie extraction works for all browsers found, subject to the same encryption rules as Windows native. In practice:

- **Windows Firefox** (found via `/mnt/c`): cookies extracted cleanly — recommended
- **Windows Opera** (found via `/mnt/c`): cookies extracted cleanly
- **Windows Chrome/Edge** (found via `/mnt/c`): v20 encryption — cannot decrypt, use Firefox instead
- **WSL-native Firefox** (installed inside WSL): works, cookies at `~/.mozilla/firefox/`

#### Launching the headless browser

Both Puppeteer's bundled Chromium and its downloadable Firefox need system libraries that a minimal WSL image (e.g. Debian slim) won't have. `yt-fetch` detects failures and tells you exactly which packages are missing:

```
  ✖  Browser launch failed in WSL

     Chrome:   missing libglib-2.0.so.0
     Firefox:  missing libgtk-3.so.0

     Install the missing system libraries and retry:
       sudo apt install -y libglib2.0-0 libgtk-3-0
```

Follow the suggested `apt install` command, then re-run. Depending on how minimal your install is, you may need to repeat this once or twice as additional libraries surface.

> **Note:** `bun x puppeteer browsers install firefox` downloads the Firefox binary but does **not** install the GTK/glib system libraries it depends on. You still need `apt` for those.

#### Recommended WSL workflow

`yt-fetch` has two distinct phases in WSL, and only the second runs into trouble:

1. **Cookie extraction** — reads browser profiles from disk, including Windows-native profiles under `/mnt/c`. Works automatically.

2. **Headless browser launch** — Puppeteer starts Chrome or Firefox inside WSL. This is where minimal distros hit missing-library errors.

Get step 2 working by following whatever `apt install` hint the tool prints, then re-run. The exact library set varies by distro and how minimal it is — `yt-fetch` identifies what's missing as you go.

> We haven't yet determined a fully tested, out-of-the-box headless browser setup for minimal WSL environments. Contributions and test reports are welcome.

## Usage

```sh
bin/yt [options]
```

```sh
bin/yt -i                     # choose which browser session to use interactively
bin/yt -b firefox             # use Firefox, auto-pick best profile
bin/yt -b firefox --debug     # see every step of the pipeline
bin/yt -q --output json       # clean JSON for piping to jq or other tools
bin/yt --dry-run              # verify cookies without launching a browser
bin/yt --video-url canonical  # full youtube.com/watch?v= URLs instead of youtu.be
bin/yt -n 20                  # stop after 20 videos
```

**Output formats:** `pretty` (default), `json`, `yaml`

**Note on sort order:** YouTube's history feed is reverse-chronological (most recently watched first), and `yt-fetch` preserves that. `--sort asc` (the default) keeps the most recent video at the top; `--sort desc` reverses the list so your oldest watched video comes first.

## Browser Support

| Browser | macOS | Linux | Windows | WSL |
|---|:---:|:---:|:---:|:---:|
| Firefox | ✅ | ✅ | ✅ | ✅ |
| Opera | ✅ | ✅ | ✅ | ✅ via `/mnt/c` |
| Chrome / Brave | ✅ | ✅ | ❌ v20 | ❌ v20 |
| Edge | ✅ | ✅ | ❌ v20 | ❌ v20 |
| Safari | 🚧 planned | — | — | — |

**v20** = Chrome/Edge 127+ app-bound encryption — cannot be decrypted outside the browser process. Use Firefox instead.

## How It Works

1. **Scan** — find cookie databases across all browser profiles installed on this machine
2. **Extract** — read and decrypt the YouTube cookies using your OS's own credential store
3. **Inject** — open a temporary, isolated headless browser window (Chromium or Firefox running invisibly in the background) and load those cookies into it, so the browser is authenticated as you
4. **Scrape** — navigate to `youtube.com/feed/history`, scroll through the page to load the full list, and extract video titles, channels, durations, and URLs from the DOM
5. **Output** — print results in the requested format and close the browser

No Google APIs. No tokens. No network requests beyond YouTube itself.

## Privacy & Security

All processing is local:

- **Cookies never leave your machine.** They are read from your browser's on-disk database and decrypted using the same OS credential store that already protects them (macOS Keychain, Linux libsecret/KWallet, Windows DPAPI).
- **The headless browser session is isolated.** It runs in a blank, temporary profile — completely separate from your normal browser. It cannot access your real browsing history, saved passwords, extensions, or other sessions. It opens, loads your history page, and closes.
- **No external services.** The only outbound network traffic is the headless browser loading `youtube.com`.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0.14
- macOS 13+, Linux (kernel 5.1+), or Windows 10 (1809+) / WSL 2
  - macOS 11 (Big Sur) and 12 (Monterey) support is attempted via a compatibility shim — see [Older macOS](#older-macos-big-sur--monterey)
- A signed-in YouTube session in a supported browser

## Diagnostics

Test cookie extraction without launching a browser:

```sh
bin/yt --dry-run
```

Enable full pipeline debug output:

```sh
bin/yt --debug
```

When filing issues, include OS + version, browser + version, profile path, and the output of `--debug`.

## Older macOS (Big Sur & Monterey)

Bun officially supports macOS 13+, but many users on **Big Sur (11)** and **Monterey (12)** can run it using the included **ICU compatibility shim** (`scripts/install-bun-shim.sh`):

```bash
bun run patch-bun-on-legacy-macos
```

With the shim in place, `bun` works — cookie extraction and `--dry-run` work for all supported browser sessions:

```bash
bin/yt --dry-run
```

The remaining open problem is **headless browser launch**: Puppeteer's bundled Chromium may fail to start on older macOS, which blocks the final scraping step. There is no known workaround yet.

See [oven-sh/bun#6035](https://github.com/oven-sh/bun/issues/6035) for upstream tracking.

## Roadmap

### In Progress

- Ensure support for a wide range of browsers
- Headless browser scraping on WSL and older macOS (Big Sur/Monterey)

### Under Consideration

- Search your watch history
- Additional data types: likes, playlists, subscriptions
- Safari support (BinaryCookies parser)

### Ecosystem Direction

`yt-fetch` is intentionally narrow and designed to compose:

- Scheduling → cron, systemd timers, Task Scheduler
- Backups → user scripts consuming JSON/YAML output
- Analytics → separate projects

## Contributing

PRs and issues are welcome. Areas where contributions are especially valuable:

- **Browser coverage** — testing with unlisted browsers or profiles; support for new Chromium forks
- **DOM selector updates** — YouTube updates its frontend regularly; if scraping breaks, the selectors in `src/scrape.js` are the first place to look
- **Platform testing** — WSL setups, unusual Linux configurations, older macOS versions
- **Safari** — parsing Apple's BinaryCookies format (the format is documented in `src/browsers.js`)

When filing an issue, include:

- OS + version
- Browser + version + profile path
- `--debug` output
- Clear reproduction steps

## Responsible Use

- Only use on accounts you own or have explicit permission to access
- Treat extracted cookies and watch history as sensitive personal data
- Follow YouTube's Terms of Service and applicable laws in your jurisdiction

## License

ISC
