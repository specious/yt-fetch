import * as cheerio from 'cheerio'
import https from 'https'
import crypto from 'crypto'
import { Database } from 'bun:sqlite'
import { Glob } from 'bun'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function findFirefoxCookies() {
  const candidates = [
    path.join(process.env.HOME, 'Library/Application Support/Firefox Developer Edition/Profiles'),
    path.join(process.env.HOME, 'Library/Application Support/Firefox/Profiles'),
    path.join(process.env.HOME, 'Library/Application Support/Opera Developer'),
    path.join(process.env.HOME, 'Library/Application Support/Google/Chrome')
  ]

  console.log('🔍 Searching browser profiles:')
  for (const base of candidates) {
    try {
      console.log(`  Checking: ${base}`)
      await fs.access(base)
      const glob = new Glob('**/*cookies.sqlite')
      const files = []
      for await (const file of glob.scan(base)) {
        files.push(file)
      }
      if (files.length) {
        const fullPath = path.join(base, files[0])
        console.log(`  ✅ Found: ${fullPath}`)
        return fullPath
      }
      // Check for Opera/Chrome single Cookies file
      const operaCookies = path.join(base, 'Cookies')
      try {
        await fs.access(operaCookies)
        console.log(`  ✅ Found: ${operaCookies}`)
        return operaCookies
      } catch {}
    } catch {
      // Directory doesn't exist or inaccessible
    }
  }
  return null
}

async function getYoutubeCookies(profilePath) {
  console.log(`\n📂 Opening: ${profilePath}`)

  try {
    const stat = await fs.stat(profilePath)
    console.log(`  📊 Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)

    const db = new Database(profilePath, { readonly: true })
    console.log('  🔓 SQLite connected')

    const rows = db.query(
      `SELECT name, value FROM moz_cookies 
       WHERE host_key='.youtube.com' 
       AND name IN ('SAPISID', 'SID', '__Secure-3PSID', 'HSID')`
    ).all()

    db.close()
    console.log(`  📋 ${rows.length} YouTube cookies found`)

    return Object.fromEntries(rows.map(r => [r.name, r.value]))
  } catch (error) {
    if (error.message.includes('SQLITE_CANTOPEN')) {
      throw new Error(
        `Cannot open ${path.basename(profilePath)}.\n` +
        `• Close Firefox/Opera/Chrome completely\n` +
        `• Or specify path: bun start "~/Library/Application Support/Firefox Developer Edition/Profiles/xxx/cookies.sqlite"`
      )
    }
    throw error
  }
}

function getSAPISIDHASH(sapisid) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const toSign = `${timestamp} ${sapisid} https://www.youtube.com`
  const hash = crypto.createHash('sha1').update(toSign).digest('hex')
  return `SAPISIDHASH ${timestamp}_${hash}`
}

async function scrapeHistory(cookies) {
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  const auth = getSAPISIDHASH(cookies.SAPISID)

  console.log('🌐 Scraping https://www.youtube.com/feed/history...')

  return new Promise((resolve) => {
    const req = https.request('https://www.youtube.com/feed/history', {
      method: 'GET',
      headers: {
        'Cookie': cookieStr,
        'Authorization': auth,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'X-Origin': 'https://www.youtube.com'
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => {
        const $ = cheerio.load(data)
        const videos = $('#dismissible ytd-video-renderer a#video-title')
          .slice(0, 30)
          .map((i, el) => {
            const href = $(el).attr('href')
            const idMatch = href?.match(/v=([^&]+)/)
            return {
              id: idMatch?.[1],
              title: $(el).attr('title') || $(el).text()?.trim(),
              url: href ? `https://youtube.com${href}` : null
            }
          })
          .get()
          .filter(v => v.id)

        console.log(`✅ Scraped ${videos.length} recent videos`)
        resolve(videos)
      })
    })
    req.on('error', () => resolve([]))
    req.end()
  })
}

async function main() {
  try {
    let profile = process.argv[2]
    if (!profile) {
      profile = await findFirefoxCookies()
      if (!profile) {
        console.log('❌ No cookies found')
        console.log('Run: bun start "~/Library/Application Support/Firefox Developer Edition/Profiles/*/cookies.sqlite"')
        process.exit(1)
      }
    }

    const cookies = await getYoutubeCookies(profile)
    if (!cookies.SAPISID) {
      throw new Error('No SAPISID cookie. Login to YouTube in browser first.')
    }

    console.log('Found cookies:', Object.keys(cookies).join(', '))
    const videos = await scrapeHistory(cookies)
    console.log('\n📺 Recent videos:')
    console.log(JSON.stringify(videos, null, 2))
  } catch (error) {
    console.error('💥', error.message)
    process.exit(1)
  }
}

main()
