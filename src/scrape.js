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

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.createBrowserContext()
  const page    = await context.newPage()

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
      console.log(`  ${dim('│')}  ${dim('cookies visible to browser:')}`)
      console.log(`  ${dim('│')}  ${c.ansi256(252)(seen.map(ck => ck.name).sort().join(dim(', ')))}`)
    }

    //
    // Navigate to history
    //
    log(`Navigating  ${dim(HISTORY_URL)}`)

    await page.goto(HISTORY_URL, { waitUntil: 'networkidle0', timeout: 20_000 })

    // YouTube renders the initial DOM skeleton on networkidle0, then runs a
    // second JS pass that fills in titles, channels, and metadata. Without
    // this pause those fields are frequently empty strings.
    await new Promise(r => setTimeout(r, SETTLE_MS))

    //
    // Verify "logged in" state
    //
    const auth = await page.evaluate(() => ({
      signedIn:      !!document.querySelector('#avatar-btn, yt-img-shadow#avatar'),
      historyLoaded: !!document.querySelector('ytd-history-entry-renderer, #contents ytd-video-renderer, yt-lockup-view-model'),
      title:         document.title,
    }))

    if (debug) {
      log(`page title:  ${dim(auth.title)}`)
      log(`signed in:   ${auth.signedIn ? c.bgreen('yes') : c.bred('no')}`)
      log(`history DOM: ${auth.historyLoaded ? c.bgreen('found') : c.bred('not found')}`)
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
        log(`first renderer: ${dim(sample.tag)}`)
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
