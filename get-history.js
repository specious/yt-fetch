import sqlite3 from 'sqlite3'
import { Database } from 'sqlite3'
import https from 'https'
import crypto from 'crypto'
import cheerio from 'cheerio'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function getYoutubeCookies(profilePath) {
  return new Promise((resolve, reject) => {
    const db = new Database(profilePath)
    db.all(
      `SELECT name, value FROM moz_cookies 
       WHERE host_key='.youtube.com' 
       AND name IN ('SAPISID', 'SID', '__Secure-3PSID', 'HSID')`,
      (err, rows) => {
        db.close()
        if (err) return reject(err)
        resolve(Object.fromEntries(rows.map(r => [r.name, r.value])))
      }
    )
  })
}

function getSAPISIDHASH(sapisid, origin = 'https://www.youtube.com') {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const toSign = `${timestamp} ${sapisid} ${origin}`
  const hash = crypto.createHash('sha1').update(toSign).digest('hex')
  return `SAPISIDHASH ${timestamp}_${hash}`
}

async function scrapeHistory(cookies) {
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  const auth = getSAPISIDHASH(cookies.SAPISID)

  return new Promise((resolve) => {
    const req = https.request('https://www.youtube.com/feed/history', {
      method: 'GET',
      headers: {
        'Cookie': cookieStr,
        'Authorization': auth,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'X-Origin': 'https://www.youtube.com'
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => {
        const $ = cheerio.load(data)
        const videos = $('#dismissible .ytd-video-renderer a#video-title')
          .slice(0, 30)
          .map((i, el) => ({
            id: $(el).attr('href').match(/v=([^&]+)/)?.[1],
            title: $(el).attr('title'),
            url: `https://youtube.com${$(el).attr('href')}`
          }))
          .get()
        resolve(videos)
      })
    })
    req.on('error', () => resolve([]))
    req.end()
  })
}

async function main() {
  try {
    const profile = process.argv[2] || 
      path.join(
        process.env.HOME,
        'Library/Application Support/Firefox Developer Edition/Profiles',
        '*.default-release/cookies.sqlite'
      )

    const cookies = await getYoutubeCookies(profile)
    if (!cookies.SAPISID) {
      throw new Error('No YouTube cookies found. Close Firefox Dev and try again.')
    }

    const videos = await scrapeHistory(cookies)
    console.log(JSON.stringify(videos, null, 2))
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

main()
