# yt-fetch

Fetch your personal YouTube recent watch history **without API keys, OAuth, or manual cookie exports**.

`yt-fetch` scans known browser profile directories for saved, signed‑in sessions, extracts and decrypts cookies locally, and uses a headless browser to fetch personalized YouTube pages just like a regular browser. It currently focuses on recent watch history and related metadata, and is evolving to support additional personal data types.

> ⚠️ **Early Stage Experimental**
> This project is actively developed. It works reliably on many platforms and browser configurations, but **not all**. Expect rapid iteration and breaking changes while coverage and robustness improve.

## Features

- **Auto detect** installed browsers and profiles
- **Decrypt cookies** locally (Firefox plaintext; Chromium AES‑GCM v10 via Keychain, Secret Service, or DPAPI)
- **Automatic profile selection** to pick the best signed‑in session available on the machine
- **Headless fetch** of YouTube pages using Puppeteer with injected cookies
- **Multiple outputs**: pretty, JSON, YAML
- **Debug tooling** with `--dry-run` and `--debug` to inspect the cookie pipeline
- **Local first**: all decryption and scraping happen on the user’s machine; no personal data is sent to external servers

## Quick Start

```sh
git clone https://github.com/specious/yt-fetch
cd yt-fetch
bun install
bin/yt
```

**Bun is the only runtime dependency.**

Fork, experiment, and extend — the project is intended to be forkable and composable.

## Why Bun

- **`bun:sqlite`** for fast, zero‑dependency SQLite access
- **`Bun.Glob`** for efficient profile scanning
- Fast startup and a single runtime for a snappy CLI experience
- The tool relies on Bun‑specific APIs and cannot run under Node.js

## Requirements

- **Bun ≥ 1.0.14**
- macOS 13 or later, Linux with kernel 5.1 or later, or Windows 10 1809 or later
- A signed‑in YouTube session in one of: Firefox, Chrome, Opera, Brave, Edge

**Note:** Firefox cookies are plaintext and therefore the most portable. Chromium cookies require the platform decryption mechanism and may prompt for keyring access.

## How It Works

1. Scan known browser profile directories for saved, signed‑in sessions
2. Read cookie databases and decrypt cookies locally using platform keyrings where required
3. Launch a headless browser instance and inject cookies into the session
4. Load the target YouTube page and extract structured data (titles, video IDs, channel, duration, views, URLs)
5. Output results in the requested format

Everything stays local. No Google APIs or cloud tokens are used.

## Usage

Run the CLI directly:

```sh
bin/yt [options]
```

Common examples:

```sh
bin/yt -i                     # choose browser session interactively
bin/yt -b opera               # force Opera profile
bin/yt -b firefox --debug     # verbose cookie pipeline
bin/yt -q --output json       # machine-readable JSON
bin/yt --dry-run              # decrypt cookies but do not launch browser
bin/yt --video-url canonical  # full youtube.com/watch?v= URLs
```

**Output formats:** pretty (default), `json`, `yaml`.

## Browser Support

> **Important:** This project is early stage. Not every browser × OS combination has been exhaustively tested, and some combinations are known to be flaky or require extra steps. If your setup isn't listed as **Known working**, it may still work or may require troubleshooting.

| Browser | macOS | Linux | Windows |
|---|---:|---:|---:|
| **Firefox** | ✅ **Known working (plaintext cookies)** | ✅ **Known working (plaintext cookies)** | ✅ **Known working (plaintext cookies)** |
| **Chrome Brave Edge** | ✅ **Works (Keychain)** | ⚠️ **Partial (Secret Service or fallback)** | ⚠️ **Partial (v10 only)** |
| **Opera Opera Developer** | ✅ **Works (Keychain)** | ⚠️ **Partial (Secret Service or fallback)** | ⚠️ **Partial (v10 only)** |
| **Safari** | 🚧 **Planned** | — | — |
| **Chrome 127+ Windows v20** | — | — | ❌ **Not supported (app‑bound cookies)** |

**Legend:**
- **✅ Known working** — tested and reliable in common configurations.
- **⚠️ Partial** — cookie decryption may succeed but authenticated requests or playback can fail in some setups.
- **❌ Not supported** — platform/browser mode prevents usable cookie extraction.
- **🚧 Planned** — work is planned but not yet implemented.

### Observed issues and investigation areas

- Decrypted cookies but YouTube appears signed out in the headless session on some Chromium profiles.
- Keychain or secret service prompts when accessing platform keyrings.
- Headless browser launch failures on older macOS releases due to Puppeteer/Chromium requirements.

These are **under investigation**. Diagnostic output from `--dry-run` and `--debug` helps prioritize and fix real-world cases.

### Diagnostic steps

1. Verify cookie extraction without launching Puppeteer:
   ```sh
   bin/yt --dry-run
   ```
2. Capture detailed pipeline output:
   ```sh
   bin/yt --debug
   ```
3. When filing an issue, include **OS and version**, **browser and exact version**, **profile path**, `--dry-run` result, and `--debug` output if available.

### Troubleshooting tips

- Use `--dry-run` to confirm cookie extraction before attempting a headless fetch.
- On macOS, allow Keychain access when prompted. On Linux, ensure a secret service (gnome‑keyring or kwallet) is running if possible.
- Advanced: to reduce environmental differences for testing, launch Puppeteer with the same user agent and, when safe, a cloned `--user-data-dir` containing the browser profile files. This is an advanced step and should be done carefully.

## Older macOS

The repo includes an optional ICU shim to run Bun on Big Sur and Monterey. Use the included patcher if you need Bun on older macOS versions. Puppeteer’s Chromium builds may still limit headless execution on older macOS releases.

## Roadmap

> **Note:** This project is early and evolving. Items below are grouped by intent — **actively worked on**, **under consideration**, and **complementary approaches**. Items marked under consideration are not release commitments.

### Actively worked on

- Improve Linux reliability: handle Wayland/keyring edge cases and common distro quirks.
- Harden session validation and diagnostics before launching Puppeteer.
- Improve debug tooling and error messages to make failures actionable.

### Under consideration

- Expand fetched data types beyond history (likes, playlists, subscriptions, notifications, watch later). Prioritization will consider feasibility, privacy, and user demand.
- Windows cookie handling improvements for newer Chromium modes (investigate DPAPI v20 scenarios).

### Complementary approaches

- **Scheduled sync and local export** are best implemented by external schedulers and backup tools that call `yt` (cron, systemd timers, platform task schedulers). Documentation will include safe wiring patterns.
- **Local analytics and richer exports** are natural companion projects that consume `yt` output and provide dashboards or HTML reports. This keeps `yt` focused and composable.
- **Safe personal backups** should be implemented by external backup tools or user scripts that call `yt` and store results locally; docs will include recommended patterns and security considerations.

## Responsible Use and Legal Notice

**Use responsibly**

- **Only use `yt-fetch` on accounts you own or have explicit permission to access.**
- The tool accesses and processes sensitive personal data stored in your browser. Treat that data with care.

**Compliance**

- Abide by YouTube Terms of Service and any applicable laws in your jurisdiction.
- This tool is provided for personal data access and research. It is not intended for abuse, unauthorized access, or mass scraping of other users’ data.

**Privacy**

- All decryption and scraping occur locally on your machine. The project does not transmit your cookies or personal data to external servers.

## Contributing

Contributions, bug reports, and pull requests are welcome. When opening an issue, include:

- **OS and version**
- **Browser and exact version and profile path used**
- **`--debug` output** if available
- **`--dry-run` result**
- A short description of the failure

Fork the repo, experiment, and submit PRs. Community interest helps prioritize features and platform coverage.

## License

**ISC License**
