import puppeteer from 'puppeteer'

const sleep = ms => {
  console.debug('Waiting:', ms)
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function scrapeHistory(cookies, maxVideos = 100) {
  console.log('Launching a headless browser...')

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  const context = await browser.createBrowserContext()
  const page = await context.newPage()

  try {
    console.log('\n💉 Injecting', cookies.length, 'cookies...')

    let numInjected = 0

    for (const cookie of cookies) {
      // Skip invalid (new Puppeteer strictness)
      if (!cookie.name?.trim() || !cookie.value?.trim()) {
        console.debug("Skipping cookie:")
        console.debug(cookie)
        continue
      }

      try {
        await context.setCookie(cookie)
        numInjected++
      } catch (e) {
        console.log(`❌ ${cookie.name}: ${e.message}`)
      }
    }

    console.log(`✅ ${numInjected}/${cookies.length} cookies injected into the headless browser`)

    // Confirm cookie injection
    const injected = await context.cookies(['https://www.youtube.com'])
    console.log('🔍 Headless browser sees these YouTube cookies:', injected.map(c => c.name).sort())

    console.info('Loading:', 'https://www.youtube.com/feed/history')
    await page.goto('https://www.youtube.com/feed/history', {
      waitUntil: 'networkidle0',
      timeout: 15000
    })

    await sleep(1000)

    // Verify logged in state
    const authState = await page.evaluate(() => ({
      hasAvatar: !!document.querySelector('#avatar-btn, yt-img-shadow#avatar'),
      historyLoaded: !!document.querySelector('ytd-history-entry-renderer, #contents ytd-video-renderer'),
      title: document.title,
      watchCount: document.querySelectorAll('a[href*="/watch?v="]').length
    }))

    console.log('📊 Authentication state:', authState)

    if (!authState.historyLoaded) {
      throw new Error('History not loaded - check auth')
    }

    return await scrollAndExtractVideos(page, maxVideos)
  } catch (error) {
    console.error('💥 ERROR:', error.message)
    await page.screenshot({ path: 'error.png', fullPage: true })
    throw error
  } finally {
    await context.close()
    await browser.close()
  }
}

export async function scrollAndExtractVideos(page, maxVideos = 100) {
  console.log('📜 Extracting all loaded videos...')

  const allVideos = await page.evaluate(() => {
    const videos = new Map()

    // Grab all watch links
    const allLinks = document.querySelectorAll('a[href*="/watch?v="]')

    Array.from(allLinks).forEach(link => {
      const href = link.href
      const url = new URL(href)
      const videoId = url.searchParams.get('v')

      if (!videoId || videos.has(videoId))
        return

      let titleEl = null
      let container = null

      // Walk up from the link to find the title container
      for (let parent = link.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        titleEl = parent.querySelector('#video-title, yt-formatted-string, h3[title]')

        if (titleEl?.textContent?.trim()) {
          container = parent.tagName
          break
        }
      }

      if (titleEl?.textContent?.trim()) {
        videos.set(videoId, {
          videoId,
          title: titleEl.textContent.trim().slice(0, 100),
          url: href,
          timestamp: link.closest('[timestamp], .metadata')?.textContent?.trim() || 'N/A',
          container: container?.toLowerCase() || 'unknown'
        })
      }
    })

    return Array.from(videos.values())
  })

  console.log(`✅ Extracted ${allVideos.length} unique videos`)

  return allVideos.slice(0, maxVideos)
}
