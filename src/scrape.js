import { readFileSync, existsSync, readdirSync } from 'fs'

import { dim, bold, c } from './ansi.js'

//
// The history page (youtube.com/feed/history) exposes per-video (confirmed via DOM inspection):
//
//   Field       yt-lockup-view-model (primary, ~95%)      ytd-video-renderer (legacy, ~5%)
//   ─────────   ──────────────────────────────────────    ──────────────────────────────────
//   title       h3.ytLockupMetadataViewModelHeadingReset  a#video-title
//   channel     span.ytContentMetadataViewModelMetadata   ytd-channel-name yt-formatted-
//               Text [0]                                  string#text
//   duration    div.ytBadgeShapeText                      ytd-thumbnail-overlay-time-
//                                                         status-renderer span#text
//   views       span.ytContentMetadataViewModelMetadata   span.inline-metadata-item (Shorts only)
//               Text [1]
//   isShort     /shorts/ in URL path, or badge text = "SHORTS"
//
//   For licensed films, the channel slot contains "Genre • Year" rather than a channel name.
//
// Not available in the DOM — we do not attempt to scrape:
//   - upload date    not rendered on the history feed
//   - last-watched   never in page HTML; only in Google Takeout watch-history.json
//

const HISTORY_URL  = 'https://www.youtube.com/feed/history'
const SETTLE_MS    = 3000  // Wait after networkidle0 for YouTube's second render pass
const SCROLL_MS    = 1500  // Wait after each scroll for YouTube to render new items
const SCROLL_STALL = 3     // Stop after this many scrolls with no new items

function log(msg)   { console.log(`  ${dim('·')}  ${msg}`) }
function logOk(msg) { console.log(`  ${c.bgreen('✔')}  ${msg}`) }

// WSL_DISTRO_NAME and WSL_INTEROP are injected by the Windows host kernel in modern WSL.
// The /proc/version fallback catches older WSL 1 environments where neither variable is set.
function isWSL() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  try { return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8')) } catch { return false }
}

// Map missing shared-library names → apt package names so we can give targeted install hints.
const SO_TO_PKG = {
  'libglib-2.0.so':       'libglib2.0-0',
  'libgtk-3.so':          'libgtk-3-0',
  'libmozgtk.so':         'libgtk-3-0',
  'libnss3.so':           'libnss3',
  'libnspr4.so':          'libnspr4',
  'libatk-1.0.so':        'libatk1.0-0',
  'libatk-bridge-2.0.so': 'libatk-bridge2.0-0',
  'libcups.so':           'libcups2',
  'libdrm.so':            'libdrm2',
  'libxkbcommon.so':      'libxkbcommon0',
  'libgbm.so':            'libgbm1',
  'libpango-1.0.so':      'libpango-1.0-0',
  'libcairo.so':          'libcairo2',
  'libdbus-glib-1.so':    'libdbus-glib-1-2',
  'libdbus-1.so':         'libdbus-1-3',
  'libxt.so':             'libxt6',
  'libasound.so':         'libasound2',
  'libxss.so':            'libxss1',
  'libxrandr.so':         'libxrandr2',
  'libxi.so':             'libxi6',
  'libfontconfig.so':     'libfontconfig1',
  'libexpat.so':          'libexpat1',
}

function missingLibPackages(...errMessages) {
  const pkgs = new Set()
  for (const msg of errMessages) {
    for (const [, lib] of (msg ?? '').matchAll(/(\S+\.so[.\d]*): cannot open shared object file/g)) {
      const base = lib.replace(/\.so[.\d]*$/, '.so')
      const pkg = SO_TO_PKG[lib] || SO_TO_PKG[base]
      if (pkg) pkgs.add(pkg)
    }
  }
  return [...pkgs]
}

// Find a Firefox binary usable by Puppeteer (system install or Puppeteer's own cache).
function findSystemFirefox() {
  // System-installed paths (common on Debian/Ubuntu/Arch/Fedora)
  const systemPaths = [
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
    '/snap/bin/firefox',
    '/usr/local/bin/firefox',
    '/usr/lib/firefox/firefox',
    '/usr/lib/firefox-esr/firefox-esr',
  ]
  for (const p of systemPaths) {
    if (existsSync(p)) return p
  }

  // Puppeteer's own downloaded Firefox cache (~/.cache/puppeteer/firefox/...)
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const puppeteerCache = `${home}/.cache/puppeteer/firefox`
  if (existsSync(puppeteerCache)) {
    // Walk one level: firefox/<platform>-<version>/firefox/firefox
    try {
      for (const d of readdirSync(puppeteerCache)) {
        const candidate = `${puppeteerCache}/${d}/firefox/firefox`
        if (existsSync(candidate)) return candidate
      }
    } catch {}
  }

  return null
}

// Extract the first meaningful line from a Puppeteer launch-failure message.
// Puppeteer wraps errors in a verbose block that includes full stderr and a
// troubleshooting URL; we only want the root cause.
function briefLaunchError(msg = '') {
  // "error while loading shared libraries: libfoo.so: cannot open..."
  const soMatch = msg.match(/error while loading shared libraries: (\S+)/)
  if (soMatch) return `missing ${soMatch[1]}`
  // "XPCOMGlueLoad error for file …/libmozgtk.so:\nlibgtk-3.so.0: cannot open…"
  const xpMatch = msg.match(/\n(\S+): cannot open shared object file/)
  if (xpMatch) return `missing ${xpMatch[1]}`
  // Fall back to the first non-empty line, capped at 100 chars
  const first = msg.split('\n').find(l => l.trim()) ?? msg
  return first.length > 100 ? first.slice(0, 100) + '…' : first
}

// Called when both Chrome and Firefox (if tried) fail to launch in WSL.
// Prints a compact, structured error and exits.
function wslLaunchFailed(chromeErr, ffErr, firefoxPath) {
  const err = s => console.error(`  ${s}`)

  console.error()
  err(`✖  Browser launch failed in WSL`)
  console.error()
  err(`   Chrome:   ${briefLaunchError(chromeErr?.message)}`)
  if (ffErr) {
    err(`   Firefox:  ${briefLaunchError(ffErr?.message)}`)
  }
  console.error()

  const pkgs = missingLibPackages(chromeErr?.message, ffErr?.message)
  if (pkgs.length > 0) {
    err(`   Install the missing system libraries and retry:`)
    err(`     sudo apt install -y ${pkgs.join(' ')}`)
    console.error()
    if (!ffErr) {
      // Firefox was found but not yet tried — it may also need libs
      err(`   Alternatively, Puppeteer can download a self-contained Firefox:`)
      err(`     bun x puppeteer browsers install firefox`)
    }
  } else if (!firefoxPath) {
    err(`   No Firefox binary found. Install one, then retry:`)
    err(`     bun x puppeteer browsers install firefox   # distro-agnostic`)
    err(`     sudo apt install -y firefox-esr            # Debian/Ubuntu`)
  } else {
    err(`   Both browsers failed. Check the errors above for details.`)
  }

  process.exit(1)
}

export async function scrapeHistory(cookies, opts = {}) {
  const { maxVideos = null, debug = false } = opts

  console.log()
  console.log(dim('─'.repeat(60)))
  console.log(`  ${bold('Loading watch history')}`)
  console.log(dim('─'.repeat(60)))
  console.log()

  log(`Launching headless browser`)

  let puppeteer

  try {
    puppeteer = await import('puppeteer')
  } catch {
    console.error('\nInstall dependencies with: bun install')
    process.exit(1)
  }

  const wsl = isWSL()

  // --no-sandbox / --disable-setuid-sandbox: needed when running as root (Docker, CI).
  // WSL-specific: --disable-gpu (no drivers), --disable-dev-shm-usage (/dev/shm is
  // only 64 MB by default in WSL), --no-zygote (avoids sandbox failures in WSL's
  // process namespace).
  const chromeArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    ...(wsl ? ['--disable-gpu', '--disable-dev-shm-usage', '--no-zygote'] : []),
  ]

  let browser
  try {
    browser = await puppeteer.launch({ headless: true, args: chromeArgs })
  } catch (chromeErr) {
    if (wsl) {
      // Chrome often fails in WSL due to missing shared libraries.
      // Try a system/Puppeteer-cached Firefox before giving up.
      const firefoxPath = findSystemFirefox()
      if (firefoxPath) {
        log(`Chrome unavailable in WSL — trying Firefox  ${dim(firefoxPath)}`)
        try {
          browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: firefoxPath })
        } catch (ffErr) {
          wslLaunchFailed(chromeErr, ffErr, firefoxPath)
        }
      } else {
        wslLaunchFailed(chromeErr, null, null)
      }
    } else if (chromeErr.message?.includes('Could not find Chrome')) {
      console.error('\n  Install the headless browser with: bun install')
      console.error('  (or: bun x puppeteer browsers install chrome)')
      process.exit(1)
    } else {
      console.error(`\n  ${chromeErr.message}`)
      process.exit(1)
    }
  }

  // Firefox BiDi may not support isolated contexts — fall back to the default.
  let context
  try {
    context = await browser.createBrowserContext()
  } catch {
    context = browser.defaultBrowserContext()
  }
  const page = await context.newPage()

  try {
    //
    // Inject cookies
    //
    let injected = 0, rejected = 0

    for (const cookie of cookies) {
      if (!cookie.name?.trim() || !cookie.value?.trim()) continue
      try {
        await context.setCookie(cookie)
        injected++
      } catch {
        rejected++
      }
    }

    logOk(`${injected} cookies injected${rejected > 0 ? `  ${dim('(' + rejected + ' rejected)')}` : ''}`)

    if (debug) {
      const seen = await context.cookies([HISTORY_URL])
      console.log(`  ${dim('│')}  ${dim('Cookies visible to browser:')}`)
      console.log(`  ${dim('│')}  ${c.ansi256(252)(seen.map(ck => ck.name).sort().join(dim(', ')))}`)
    }

    //
    // Navigate to history
    //
    log(`Navigating to: ${dim(HISTORY_URL)}`)

    await page.goto(HISTORY_URL, { waitUntil: 'networkidle0', timeout: 20_000 })

    // YouTube renders the initial DOM skeleton on networkidle0, then runs a
    // second JS pass that fills in titles, channels, and metadata. Without
    // this pause those fields are frequently empty strings.
    await new Promise(r => setTimeout(r, SETTLE_MS))

    //
    // Verify "logged in" state
    //
    const auth = await page.evaluate(() => ({
      signedIn: !!document.querySelector('#avatar-btn, yt-img-shadow#avatar'),
      historyLoaded: !!document.querySelector('ytd-history-entry-renderer, #contents ytd-video-renderer, yt-lockup-view-model'),
      title: document.title,
    }))

    if (debug) {
      log(`Page title: ${dim(auth.title)}`)
      log(`Signed in: ${auth.signedIn ? c.bgreen('yes') : c.bred('no')}`)
      log(`History DOM: ${auth.historyLoaded ? c.bgreen('found') : c.bred('not found')}`)
    }

    if (!auth.historyLoaded) {
      throw new Error(
        auth.signedIn
          ? 'History page loaded but no video entries found — try again in a moment.'
          : 'Not signed in — are the cookies from the right browser and profile?'
      )
    }

    //
    // Scroll to load the full history (YouTube uses infinite scroll)
    //
    // The history feed renders ~10-15 items initially, then appends more as
    // the user scrolls. We scroll to the bottom repeatedly, waiting for the
    // DOM to settle between each pass, stopping when two consecutive scrolls
    // produce no new renderer elements or when maxVideos have been loaded.
    //
    const RENDERER_COUNT_SEL = [
      'ytd-video-renderer',
      'ytd-history-entry-renderer',
      'ytd-compact-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-reel-item-renderer',
      'ytd-playlist-video-renderer',
      'yt-lockup-view-model',
    ].join(', ')

    let prevCount = 0, stalls = 0, scrollPass = 0

    while (stalls < SCROLL_STALL) {
      const count = await page.evaluate(
        sel => document.querySelectorAll(sel).length,
        RENDERER_COUNT_SEL
      )

      if (maxVideos != null && count >= maxVideos) break

      if (count > prevCount) {
        log(`Scrolling  ${dim(`${count} items so far…`)}`)
        stalls = 0
        prevCount = count
      } else {
        stalls++
      }

      if (stalls >= SCROLL_STALL) break

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await new Promise(r => setTimeout(r, SCROLL_MS))
      scrollPass++
    }

    const finalCount = await page.evaluate(
      sel => document.querySelectorAll(sel).length,
      RENDERER_COUNT_SEL
    )

    log(`Scroll complete  ${dim(`${finalCount} renderer elements in DOM`)}`)

    if (debug) {
      // Dump text nodes from the first renderer to help diagnose missing metadata
      const sample = await page.evaluate(() => {
        const r = document.querySelector('yt-lockup-view-model, ytd-video-renderer, ytd-history-entry-renderer')
        if (!r) return null
        const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT)
        const nodes = []
        let node
        while ((node = walker.nextNode())) {
          const t = node.textContent.trim()
          if (t) nodes.push({ text: t, tag: node.parentElement?.tagName, id: node.parentElement?.id, cls: [...(node.parentElement?.classList ?? [])].slice(0, 3).join('.') })
        }
        return { tag: r.tagName, nodes: nodes.slice(0, 25) }
      })
      if (sample) {
        log(`First renderer: ${dim(sample.tag)}`)
        for (const n of sample.nodes) {
          log(`  ${dim(n.tag + (n.id ? '#' + n.id : '') + (n.cls ? '.' + n.cls : ''))}  ${dim(JSON.stringify(n.text))}`)
        }
      }
    }

    //
    // Extract videos
    //
    const videos = await page.evaluate(() => {
      const seen  = new Map()

      // YouTube video ID: exactly 11 base64url characters
      const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/

      // Helper: extract a clean videoId from a URL, or null
      function extractId(href) {
        try {
          const u = new URL(href)
          const v = u.searchParams.get('v')
            || u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/)?.[1]
          return v && YT_ID_RE.test(v) ? v : null
        } catch { return null }
      }

      //
      // How YouTube history page DOM extraction works
      // ─────────────────────────────────────────────
      //
      // YouTube renders the history feed using Web Components — custom HTML elements
      // whose tag names start with "ytd-" (legacy) or "yt-" (new component system).
      // Each video in the history is wrapped in one of these renderer elements, which
      // act as self-contained components with their own scoped styles and structure.
      //
      // As of 2024/2025, two renderer families coexist on the history page:
      //
      //   yt-lockup-view-model          ~95% of entries (new system)
      //   ytd-video-renderer            ~5% of entries (legacy, used for films/shorts)
      //
      // We iterate over renderer elements rather than scanning all links on the page.
      // This is critical: the page also contains sidebar links, related-video panels,
      // and navigation links — all with /watch?v= URLs — that would pollute results
      // and win the de-duplication race if we scanned links directly.
      //
      // De-duplication: the `seen` Map keyed on videoId prevents the same video from
      // being added twice. The first occurrence (topmost in DOM = most recently watched)
      // wins. YouTube IDs are always exactly 11 base64url characters ([A-Za-z0-9_-]{11});
      // we validate this to reject shelf/section header links that aren't real videos.
      //
      // yt-lockup-view-model structure:
      //
      //   <yt-lockup-view-model>
      //     <a class="ytLockupViewModelContentImage">          ← thumbnail link
      //       <div class="ytBadgeShapeText">16:00</div>        ← duration badge
      //     </a>
      //     <yt-lockup-metadata-view-model>
      //       <h3 class="ytLockupMetadataViewModelHeadingReset">
      //         <a class="ytLockupMetadataViewModelTitle" href="/watch?v=...">
      //           <span class="ytAttributedStringHost...">Title text</span>
      //         </a>
      //       </h3>
      //       <yt-content-metadata-view-model>
      //         <span class="ytContentMetadataViewModelMetadataText">Channel</span>
      //         <span class="ytContentMetadataViewModelMetadataText">213K views</span>
      //       </yt-content-metadata-view-model>
      //     </yt-lockup-metadata-view-model>
      //   </yt-lockup-view-model>
      //
      // Legacy ytd-video-renderer structure (films, some Shorts):
      //
      //   <ytd-video-renderer>
      //     <ytd-thumbnail>
      //       <ytd-thumbnail-overlay-time-status-renderer>
      //         <span id="text">1:46:52</span>                 ← duration
      //       </ytd-thumbnail-overlay-time-status-renderer>
      //     </ytd-thumbnail>
      //     <a id="video-title" href="/watch?v=...">Title</a>
      //     <ytd-channel-name>
      //       <yt-formatted-string id="text">Channel</yt-formatted-string>
      //     </ytd-channel-name>
      //     <div id="metadata-line">
      //       <span class="inline-metadata-item">27K views</span>
      //     </div>
      //   </ytd-video-renderer>
      //
      const RENDERER_SEL = [
        'ytd-video-renderer',
        'ytd-history-entry-renderer',
        'ytd-compact-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-reel-item-renderer',
        'ytd-playlist-video-renderer',
        'yt-lockup-view-model', // new component system (2024+), most history entries
      ].join(', ')

      for (const renderer of document.querySelectorAll(RENDERER_SEL)) {
        const isLockup = renderer.tagName.toLowerCase() === 'yt-lockup-view-model'

        let link, title, channel, duration = '', views = ''

        if (isLockup) {
          //
          // yt-lockup-view-model — YouTube's new component system (2024+)
          //
          // Class names: camelCase (current) with kebab-case BEM fallbacks for older renders.
          //
          //   title:    h3.ytLockupMetadataViewModelHeadingReset
          //   watchURL: a.ytLockupMetadataViewModelTitle[href]
          //   duration: div.ytBadgeShapeText  ("16:00", "SHORTS")
          //   channel:  span.ytContentMetadataViewModelMetadataText  [0]
          //   views:    span.ytContentMetadataViewModelMetadataText  [1]
          //
          link  = renderer.querySelector('a.ytLockupMetadataViewModelTitle[href]')
          title = renderer.querySelector('h3.ytLockupMetadataViewModelHeadingReset')
            ?.textContent?.trim() ?? ''

          const rawDur = renderer.querySelector('div.ytBadgeShapeText')
            ?.textContent?.trim() ?? ''
          if (rawDur && rawDur !== 'SHORTS') duration = rawDur

          const spans = renderer.querySelectorAll('span.ytContentMetadataViewModelMetadataText')
          channel = spans[0]?.textContent?.trim() ?? ''
          views   = spans[1]?.textContent?.trim() ?? ''

        } else {
          //
          // Legacy ytd-* renderers — films and some Shorts still use these
          // Confirmed selectors from DOM diagnostic
          //
          link    = renderer.querySelector('a#video-title[href]')
          title   = link?.textContent?.trim() ?? ''
          channel = renderer.querySelector('ytd-channel-name yt-formatted-string#text')
            ?.textContent?.trim() ?? ''

          const raw = renderer
            .querySelector('ytd-thumbnail-overlay-time-status-renderer span#text')
            ?.textContent?.trim() ?? ''
          if (raw && raw !== 'SHORTS') duration = raw

          views = renderer.querySelector('span.inline-metadata-item')
            ?.textContent?.trim() ?? ''
        }

        if (!link || !title) continue

        const videoId = extractId(link.href)
        if (!videoId || seen.has(videoId)) continue

        const isShort = new URL(link.href).pathname.startsWith('/shorts/')
          || (!duration && renderer.querySelector('div.ytBadgeShapeText')
              ?.textContent?.trim() === 'SHORTS')

        seen.set(videoId, {
          videoId, title, channel, duration, views, isShort,
          url: isShort ? `https://www.youtube.com/shorts/${videoId}` : link.href,
        })
      }

      return [...seen.values()]
    })

    const result = maxVideos != null ? videos.slice(0, maxVideos) : videos

    logOk(
      `${result.length} video${result.length !== 1 ? 's' : ''} extracted` +
      (maxVideos != null && videos.length > maxVideos
        ? `  ${dim(`(${videos.length} found, capped at ${maxVideos})`)}`
        : '')
    )

    return result

  } catch (err) {
    console.error(`  ${c.bred('✖')}  ${err.message}`)
    const errFile = `yt-history-error-${Date.now()}.png`
    await page.screenshot({ path: errFile, fullPage: true }).catch(() => {})
    console.log(`  ${dim('·')}  Screenshot saved to ${dim(errFile)}`)
    throw err
  } finally {
    await context.close()
    await browser.close()
  }
}
