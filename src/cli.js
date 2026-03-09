import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import https from 'https'
import crypto from 'crypto'
import * as cheerio from 'cheerio'
import { Database } from 'bun:sqlite'

import { findAllCookies, selectDatabase } from './find-cookies.js'
import { getQuery } from './browsers.js'

async function getYoutubeCookies(profilePath, config) {
  console.log(`\n📂 Source: ${profilePath}`)

  // Firefox: copy main DB + WAL/SHM files
  if (config.name.toLowerCase().includes('firefox')) {
    console.log('  🔒 Firefox WAL - copying DB + WAL files...')
    const copyPath = await copyFirefoxDatabase(profilePath)
    console.log(`  📋 WAL copy: ${copyPath}`)
    return readAndCleanup(copyPath, config)
  }

  // Chrome/etc: try live query → copy fallback
  if (await testLiveQuery(profilePath, config)) {
    console.log('  ✅ Live database query works')
    return readCookies(profilePath, config)
  }

  console.log('  🔒 Live query failed - copying database file...')
  const copyPath = path.join(os.tmpdir(), `yt-history-${Date.now()}-${path.basename(profilePath)}`)
  await fs.copyFile(profilePath, copyPath)

  return readAndCleanup(copyPath, config)
}

async function readAndCleanup(dbPath, config) {
  let cookies
  try {
    cookies = await readCookies(dbPath, config)
  } finally {
    // Cleanup AFTER readCookies() completes
    const baseName = path.basename(dbPath, '.sqlite')
    const tmpDir = path.dirname(dbPath)
    ;['.sqlite', '.sqlite-wal', '.sqlite-shm'].forEach(ext => {
      fs.unlink(path.join(tmpDir, `${baseName}${ext}`)).catch(() => {})
    })
  }
  return cookies
}

// async function readAndCleanup(dbPath, config) {
//   try {
//     return await readCookies(dbPath, config)
//   } finally {
//     // Cleanup temp files (main + WAL/SHM)
//     const baseName = path.basename(dbPath, '.sqlite')
//     const tmpDir = path.dirname(dbPath)
//     const files = [`${baseName}.sqlite`, `${baseName}.sqlite-wal`, `${baseName}.sqlite-shm`]
//     await Promise.all(files.map(f => fs.unlink(path.join(tmpDir, f)).catch(() => {})))
//   }
// }

async function testLiveQuery(profilePath, config) {
  try {
    const db = new Database(profilePath, { readonly: true })
    db.query(getQuery(config)).all()  // Real YouTube query!
    db.close()
    return true
  } catch {
    return false
  }
}

async function copyFirefoxDatabase(profilePath) {
  const tmpDir = os.tmpdir()
  const timestamp = Date.now() // Timestamped backup
  const dirName = path.dirname(profilePath)
  const baseName = path.basename(profilePath, '.sqlite')

  const files = [
    `${baseName}.sqlite`,
    `${baseName}.sqlite-wal`, 
    `${baseName}.sqlite-shm`
  ]

  await Promise.all(
    files.map(async (f) => {
      const src = path.join(dirName, f)
      const dst = path.join(tmpDir, `yt-history-${timestamp}-${f}`)
      try {
        await fs.copyFile(src, dst)
      } catch {}
    })
  )

  // Return main database path (with matching timestamp)
  return path.join(tmpDir, `yt-history-${timestamp}-${baseName}.sqlite`)
}

async function copyAndRead(profilePath, config, reason) {
  const copyPath = path.join(os.tmpdir(), `yt-history-${Date.now()}-${path.basename(profilePath)}`)

  console.log(`  🔒 ${reason}`)
  await fs.copyFile(profilePath, copyPath)
  console.log(`  📋 Temp copy: ${copyPath}`)

  try {
    const cookies = await readCookies(copyPath, config)
    await fs.unlink(copyPath).catch(() => {})
    return cookies
  } catch (error) {
    await fs.unlink(copyPath).catch(() => {})
    throw new Error(`Copy failed (${config.name}): ${error.message}`)
  }
}

async function readCookies(dbPath, config) {
  const stat = await fs.stat(dbPath)
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
  const sizeKB = (stat.size / 1024).toFixed(0)
  console.log(`  📊 ${config.fileType}: ${sizeMB}MB (${sizeKB}KB)`)

  const minSize = parseInt(config.sizeMin)
  if (stat.size < minSize * 1024) {
    throw new Error(
      `${config.fileType} too small (${sizeKB}KB < ${config.sizeMin}). Try ${config.name} or close browser.`
    )
  }

  try {
    const db = new Database(dbPath, { readonly: true })
    const rows = db.query(getQuery(config)).all()
    db.close()
    console.log(`  📋 ${rows.length} YouTube cookies`)
    return Object.fromEntries(rows.map(r => [r.name, r.value]))
  } catch (dbError) {
    throw new Error(`Database read failed: ${dbError.message}`)
  }
}

function getSAPISIDHASH(sapisid) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const toSign = `${timestamp} ${sapisid} https://www.youtube.com`
  const hash = crypto.createHash('sha1').update(toSign).digest('hex')
  return `SAPISIDHASH ${timestamp}_${hash}`
}

async function scrapeHistory(cookies) {
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  const auth = getSAPISIDHASH(cookies.SAPISID)

  console.log('🌐 Scraping https://www.youtube.com/feed/history...')

  return new Promise(resolve => {
    const req = https.request(
      'https://www.youtube.com/feed/history',
      {
        method: 'GET',
        headers: {
          Cookie: cookieStr,
          Authorization: auth,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
          'X-Origin': 'https://www.youtube.com',
        },
      },
      res => {
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
                url: href ? `https://youtube.com${href}` : null,
              }
            })
            .get()
            .filter(v => v.id)

          console.log(`✅ Scraped ${videos.length} recent videos`)
          resolve(videos)
        })
      }
    )
    req.on('error', () => resolve([]))
    req.end()
  })
}

async function main() {
  try {
    const candidates = await findAllCookies()
    const selected = await selectDatabase(candidates)

    const cookies = await getYoutubeCookies(selected.path, selected.config)

    if (!cookies.SAPISID) {
      throw new Error('No cookie named "SAPISID" found. Login to YouTube in your browser and re-run.')
    }

    console.log('Found cookies:', Object.keys(cookies).join(', '))

    const videos = await scrapeHistory(cookies)

    console.log('\n📺 Recent YouTube videos:')
    console.log(JSON.stringify(videos, null, 2))
  } catch (error) {
    console.error('💥', error.message)
    console.log("\n💡 Tip: Ensure you're logged into YouTube in a browser")
    process.exit(1)
  }
}

main()
