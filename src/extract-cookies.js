import os   from 'os'
import path from 'path'
import fs   from 'fs/promises'
import { Database } from 'bun:sqlite'

import { APP_NAME } from './app.js'
import { getQuery } from './browsers.js'
import { decryptCookies, isEncryptedBlob } from './decrypt-cookies.js'

//
// Cookie extraction pipeline: database → decrypt → de-duplicate.
//
// Returns { cookies: RawCookie[], uniqueCount: number }
//
// Consumers (e.g. cli.js) call extractCookies(selected, opts) and receive
// the raw de-duplicated array before normalization.
//

//
// Firefox WAL-safe snapshot
//
// Firefox keeps cookies.sqlite open with WAL mode — a direct read would see
// an inconsistent mid-write state. We copy the three WAL files together as
// an atomic snapshot before querying.
//
async function copyFirefoxDatabase(dbPath) {
  const tmpDir = os.tmpdir()
  const tag    = `${APP_NAME}-${Date.now()}`
  const dir    = path.dirname(dbPath)
  const base   = path.basename(dbPath, '.sqlite')

  await Promise.all(
    ['.sqlite', '.sqlite-wal', '.sqlite-shm'].map(async ext => {
      try {
        await fs.copyFile(
          path.join(dir,    `${base}${ext}`),
          path.join(tmpDir, `${tag}-${base}${ext}`)
        )
      } catch {}
    })
  )

  return path.join(tmpDir, `${tag}-${base}.sqlite`)
}

async function removeTempDatabase(dbPath) {
  const base = path.basename(dbPath, '.sqlite')
  await Promise.all(
    ['.sqlite', '.sqlite-wal', '.sqlite-shm'].map(ext =>
      fs.unlink(path.join(path.dirname(dbPath), `${base}${ext}`)).catch(() => {})
    )
  )
}

//
// Check whether we can query a Chromium database without copying it.
// Returns false if the browser is running and has an exclusive lock.
//
async function canQueryLive(dbPath, config) {
  try {
    const db = new Database(dbPath, { readonly: true })
    db.query(getQuery(config)).all()
    db.close()
    return true
  } catch {
    return false
  }
}

//
// Read, decrypt, and de-duplicate cookies from a session database.
// Returns { cookies, uniqueCount, method, sqliteVer, entryCount }.
//
async function readAndDecrypt(dbPath, originalPath, method, config, opts) {
  const stat   = await fs.stat(dbPath)
  const sizeKB = (stat.size / 1024).toFixed(0)
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1)

  const minBytes = config.sizeMin * 1024
  if (stat.size < minBytes) {
    throw new Error(
      `Cookie database is too small (${sizeKB} KB) — ` +
      `expected at least ${config.sizeMin} KB for a signed-in ${config.name} session.\n` +
      `  → Make sure you are signed in to YouTube in ${config.name} and re-run.`
    )
  }

  const db        = new Database(dbPath, { readonly: true })
  const sqliteVer = db.query('select sqlite_version() as v').get()?.v ?? '?'
  const rows      = db.query(getQuery(config)).all()
  db.close()

  if (rows.length === 0) {
    throw new Error(
      `No cookies found in this session store.\n\n` +
      `  → Make sure you have visited YouTube in this ${config.name} profile and are signed in, then re-run.\n` +
      `  → Or use -i to pick a different session.`
    )
  }

  // De-duplicate: keep the entry with the furthest expiry for each cookie name
  const seen = new Map()
  for (const row of rows) {
    const prev = seen.get(row.name)
    if (!prev || (row.expiry || 0) > (prev.expiry || 0)) seen.set(row.name, row)
  }
  const unique = [...seen.values()]

  // Decrypt Chromium-family encrypted cookies
  const toDecrypt = unique.filter(
    ck => (ck.value === '' || ck.value == null) && isEncryptedBlob(ck.encryptedValue)
  )

  if (toDecrypt.length > 0) {
    decryptCookies(toDecrypt, config.name)
  }

  return {
    cookies:    unique,
    uniqueCount: unique.length,
    method,
    sqliteVer,
    entryCount: rows.length,
    sizeKB,
    sizeMB,
    originalPath,
    tmpPath:    method !== 'live' ? dbPath : null,
  }
}

//
// Public entry point
//
// Handles the copy strategy decision, then delegates to readAndDecrypt.
// Cleans up temp files in the finally block regardless of outcome.
//
export async function extractCookies(selected, opts) {
  const { path: dbPath, config } = selected

  let workingPath = dbPath
  let isTempCopy  = false
  let method      = 'live'

  if (config.alwaysCopy) {
    workingPath = await copyFirefoxDatabase(dbPath)
    method      = 'WAL-safe snapshot'
    isTempCopy  = true
  } else if (!await canQueryLive(dbPath, config)) {
    workingPath = path.join(os.tmpdir(), `${APP_NAME}-${Date.now()}-${path.basename(dbPath)}`)
    await fs.copyFile(dbPath, workingPath)
    method     = 'copy (locked)'
    isTempCopy = true
  }

  try {
    return await readAndDecrypt(workingPath, dbPath, method, config, opts)
  } finally {
    if (isTempCopy) await removeTempDatabase(workingPath)
  }
}
