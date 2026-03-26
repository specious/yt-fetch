# yt-fetch

Fetch your personal YouTube watch history **without API keys, OAuth, or manual cookie exports**.

`yt-fetch` discovers signed-in browser sessions on your machine, decrypts cookies locally, and uses a headless browser to load YouTube just like a real user session. It currently focuses on recent watch history and related metadata, with plans to expand to other personal data.

> ⚠️ **Early-stage project**
> This tool is actively evolving. It works across many setups, but not all. Expect rough edges, platform quirks, and breaking changes as coverage improves.

## Features

- Automatically detects installed browsers and profiles
- Decrypts cookies locally
  - Firefox: plaintext
  - Chromium: AES‑GCM (Keychain, Secret Service, DPAPI)
- Selects the best available signed-in session automatically (without `-i`)
- Lets you choose which browser session to use (with `-i`)
- Fetches data using headless browsing using injected cookies
- Multiple output formats: pretty, JSON, YAML
- Debug tooling: `--dry-run`, `--debug`
- Fully local: no API calls, no external data transmission

## Quick Start

```sh
git clone https://github.com/specious/yt-fetch
cd yt-fetch
bun install
bin/yt
```

- **Runtime:** Bun
- **Only dependency:** Puppeteer (headless browser)

Fork it, break it, extend it.

## Why Bun

- Built-in SQLite via `bun:sqlite` (no extra deps)
- Fast filesystem scanning with `Bun.Glob`
- Fast startup for snappy performance
- Uses Bun-specific APIs (not compatible with Node.js)

## Requirements

- Bun ≥ 1.0.14
- macOS 13+, Linux (kernel 5.1+), or Windows 10 (1809+)
- A signed-in YouTube session in: Firefox, Chrome, Brave, Edge, or Opera

**Notes**

- Firefox is the most portable (plaintext cookies)
- Chromium-based browsers require OS keyring access
- You may see keychain/keyring prompts during execution

## How It Works

1. Locate browser profile directories
2. Extract and decrypt cookies locally
3. Launch headless Chromium via Puppeteer
4. Inject cookies into a session
5. Load YouTube and extract structured data
6. Output results

No Google APIs. No tokens. No network services beyond YouTube itself.

## Usage

```sh
bin/yt [options]
```

Examples:

```sh
bin/yt -i                     # interactive session selection
bin/yt -b opera               # force specific browser
bin/yt -b firefox --debug     # verbose pipeline output
bin/yt -q --output json       # machine-readable output
bin/yt --dry-run              # test cookie extraction only
bin/yt --video-url canonical  # full youtube.com/watch?v= URLs
```

Output formats: `pretty` (default), `json`, `yaml`

## Browser Support

> Coverage varies. “Known working” means tested; others may still work with caveats.

| Browser | macOS | Linux | Windows |
|---|---:|---:|---:|
| Firefox | ✅ Known working | ✅ Known working | ✅ Known working |
| Chrome / Brave / Edge | ✅ Works (Keychain) | ⚠️ Partial | ⚠️ Partial |
| Opera | ✅ Works (Keychain) | ⚠️ Partial | ⚠️ Partial |
| Safari | 🚧 Planned | — | — |
| Chrome 127+ (Win v20) | — | — | ❌ Not supported |

### Known Issues

- Some Chromium sessions appear signed out after cookie injection
- Keyring prompts can interrupt automation
- Puppeteer/Chromium may fail on older macOS versions

These are under active investigation.

## Diagnostics

1. Test cookie extraction:
```sh
bin/yt --dry-run
```

2. Enable debug output:
```sh
bin/yt --debug
```

When filing issues, include:

- OS + version
- Browser + version
- Profile path
- `--dry-run` output
- `--debug` output

## Troubleshooting

- Use `--dry-run` before headless mode
- Ensure keyring services are available (Linux/macOS)
- Allow keychain prompts when requested
- Advanced: test with a cloned `--user-data-dir` for consistency

## Older macOS (Big Sur & Monterey)

Bun officially supports macOS 13+, but many users on **Big Sur (11)** and **Monterey (12)** can still run it using the included **ICU compatibility shim**. This shim bundles the missing ICU functions that Bun expects (which are not present on older systems), allowing the CLI to run without requiring a full OS upgrade.

### When you need the shim

- If you run `bun` on Big Sur or Monterey and see errors about **ICU**, **Unicode**, or **missing locale data**, the shim fixes those.
- The script is located in `scripts/install-bun-shim.sh` and safely patches the installed Bun executable to use `libicucore` through a small compatibility layer.

### What the shim *does*

- Installs a small ICU data bundle that Bun loads at runtime.
- Restores normal behavior for Bun’s JavaScript runtime, SQLite bindings, and filesystem APIs.
- Has no effect on newer macOS versions.

### What the shim *does not* fix

Even with the shim installed, **Puppeteer’s bundled Chromium may still fail to launch** on older macOS versions. This is a Chromium upstream limitation, not a Bun issue. In practice:

- **Firefox sessions** work best on older macOS.
- **Chromium/Chrome/Opera/Brave** may fail to launch or crash early.
- `--dry-run` continues to work reliably, even if Chromium cannot start.

For ongoing discussion and upstream tracking, see:

**https://github.com/oven-sh/bun/issues/6035**

### Recommended workflow on older macOS

1. Install Bun normally.
2. If Bun errors, run the shim:

   ```bash
   bun run patch-bun-on-legacy-macos
   ```

3. Test cookie extraction without launching a browser:

   ```bash
   bin/yt --dry-run
   ```

At the moment, this is as far as the tool can go on older macOS systems until a reliable headless-browser path is found.

## Roadmap

### In Progress

- Improve Linux reliability (keyrings, different encryption behavior, distro nuances)
- Better session validation before launching Puppeteer
- Clearer debug output and error messages

### Under Consideration

- Additional data types: likes, playlists, subscriptions, etc.
- Improved Windows support for newer Chromium cookie formats

### Ecosystem Direction

`yt-fetch` is intentionally narrow. It’s designed to compose with other tools:

- Scheduling → cron, systemd timers, task schedulers
- Backups → user scripts or external tools
- Analytics → separate projects consuming JSON/YAML output

## Responsible Use

- Only use on accounts you own or have permission to access
- Treat extracted data as sensitive

## Compliance

- Follow YouTube Terms of Service
- Follow applicable laws

This tool is for personal access and research — not bulk scraping or unauthorized access.

## Privacy

All processing happens locally.
No cookies or personal data are transmitted externally.

## Contributing

PRs and issues are welcome.

Include:

- OS + version
- Browser + version + profile path
- `--dry-run` output
- `--debug` output
- Clear reproduction steps

## License

ISC
