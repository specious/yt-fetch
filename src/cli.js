import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { Database } from 'bun:sqlite'

import { getQuery } from './browsers.js'
import { findAllCookies, selectDatabase } from './find-cookies.js'
import { normalizeCookies } from './normalize-cookies.js'
import { scrapeHistory } from './scrape.js'

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
  try {
    return await readCookies(dbPath, config)
  } finally {
    // Cleanup temp files (main + WAL/SHM)
    const baseName = path.basename(dbPath, '.sqlite')
    const tmpDir = path.dirname(dbPath)
    const files = [`${baseName}.sqlite`, `${baseName}.sqlite-wal`, `${baseName}.sqlite-shm`]

    await Promise.all(files.map(f => fs.unlink(path.join(tmpDir, f)).catch(() => {})))
  }
}

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

    // De-dupe by newest expiry
    const uniqueCookies = rows
      .reduce((acc, cookie) => {
        const existing = acc.find(c => c.name === cookie.name)
        if (!existing || (cookie.expiry || 0) > (existing.expiry || 0)) {
          return acc.filter(c => c.name !== cookie.name).concat(cookie)
        }
        return acc
      }, [])

    console.log(`  📋 ${uniqueCookies.length} unique cookies`)

    return uniqueCookies  // Array of full cookie objects
  } catch (dbError) {
    throw new Error(`Database read failed: ${dbError.message}`)
  }
}

async function main() {
  try {
    const candidates = await findAllCookies()
    const selected = await selectDatabase(candidates)

    const cookies = await getYoutubeCookies(selected.path, selected.config)
    console.log()

    if (!cookies.find(c => c.name === 'SAPISID')) {
      throw new Error('No cookie named "SAPISID" found. Login to YouTube in your browser and re-run.')
    }

    console.log(`📋 ${cookies.length} raw cookies → normalizing...`)

    console.debug()
    console.debug('Cookies:', cookies.map(c=> c.name || 'name missing').join(', '))
    console.debug()
    console.debug('First extracted cookie:');
    console.debug(cookies[0])
    console.debug()

    const normalizedCookies = normalizeCookies(cookies)

    console.debug()
    console.debug('First normalized cookie:');
    console.debug(normalizedCookies[0])
    console.debug()

    const videos = await scrapeHistory(normalizedCookies)

    console.log('\n📺 Recent YouTube videos:')
    console.log(JSON.stringify(videos, null, 2))
  } catch (error) {
    console.error('💥', error.message)
    console.log("\n💡 Tip: Ensure you're logged into YouTube in a browser")
    process.exit(1)
  }
}

main()
