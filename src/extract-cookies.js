import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'

import { Database } from 'bun:sqlite'

import { APP_NAME } from './app.js'
import { getQuery } from './browsers.js'
import { decryptCookies, isEncryptedBlob } from './decrypt-cookies.js'

//
// Cookie extraction pipeline: database → snapshot → decrypt → de-duplicate.
//
// The public entry point is extractCookies(selected, opts). It decides whether a
// WAL-safe snapshot copy is needed, delegates to readAndDecrypt for the heavy
// lifting, and guarantees temp-file cleanup in a finally block regardless of outcome.
//

//
// Firefox WAL-safe snapshot
//
// Firefox keeps cookies.sqlite open in WAL (Write-Ahead Log) mode. In WAL mode,
// writes land in a separate -wal sidecar file and are only checkpointed back to
// the main database periodically — so copying the main file alone silently misses
// recent commits. We snapshot all three files (.sqlite, -wal, -shm) together to
// get a consistent point-in-time view before querying.
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

// Windows-only: copy a file that another process has open for writing (e.g. Edge's
// Cookies DB). fs.copyFile calls the Win32 CopyFileEx API, which opens the source
// with FILE_SHARE_READ only — not enough when Edge holds an open write handle, causing
// a sharing violation (EBUSY/EPERM/EACCES). Opening via .NET FileStream with
// FileShare.ReadWrite grants write-sharing to our reader, which is exactly what SQLite
// WAL mode requires of every opener of the database file.
function copyFileWin32Sync(src, dst) {
  const esc = s => s.replace(/'/g, "''")
  const ps = [
    `$sr=New-Object IO.FileStream('${esc(src)}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)`,
    `$dw=New-Object IO.FileStream('${esc(dst)}',[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)`,
    `try{$sr.CopyTo($dw)}finally{$dw.Dispose();$sr.Dispose()}`,
  ].join(';')
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
}

// WAL-safe snapshot for Chromium cookie databases.
// Same WAL reasoning as Firefox: commits land in the -wal sidecar first and are
// checkpointed to the main file lazily. The -shm file is the shared-memory WAL index
// SQLite uses to navigate the sidecar. Copying all three files together is the only
// way to get a consistent snapshot while the browser is running.
async function copyChromiumDatabase(dbPath) {
  const tmpDir  = os.tmpdir()
  const tag     = `${APP_NAME}-${Date.now()}`
  const dir     = path.dirname(dbPath)
  const base    = path.basename(dbPath)   // e.g. 'Cookies'
  const tmpBase = `${tag}-${base}`
  const src     = path.join(dir, base)
  const dst     = path.join(tmpDir, tmpBase)

  // Main file must succeed — let errors propagate so the caller can report them.
  // On Windows, if the regular copy fails because Edge holds an exclusive lock,
  // fall back to a .NET FileStream copy with ReadWrite sharing.
  try {
    await fs.copyFile(src, dst)
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      copyFileWin32Sync(src.replace(/\//g, '\\'), dst.replace(/\//g, '\\'))
    } else {
      throw err
    }
  }

  // WAL and SHM files are optional (may not exist when the browser is idle).
  await Promise.all(
    ['-wal', '-shm'].map(suffix =>
      fs.copyFile(path.join(dir, `${base}${suffix}`), path.join(tmpDir, `${tmpBase}${suffix}`)).catch(() => {})
    )
  )

  return dst
}

async function removeChromiumTempDatabase(dbPath) {
  const base = path.basename(dbPath)
  await Promise.all(
    ['', '-wal', '-shm'].map(suffix =>
      fs.unlink(path.join(path.dirname(dbPath), `${base}${suffix}`)).catch(() => {})
    )
  )
}

//
// Probe whether the Chromium database can be queried directly (no copy needed).
// Returns false when the browser holds a WAL write lock — the signal that we need
// to fall back to a snapshot copy instead.
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
async function readAndDecrypt(dbPath, originalPath, method, config, profileDir, opts) {
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
    decryptCookies(toDecrypt, config.name, profileDir)
  }

  return {
    source: config.name,
    cookies: unique,
    uniqueCount: unique.length,
    method,
    sqliteVer,
    entryCount: rows.length,
    sizeKB,
    sizeMB,
    originalPath,
    tmpPath: method !== 'live' ? dbPath : null,
  }
}

//
// Public entry point
//
// Handles the copy strategy decision, then delegates to readAndDecrypt.
// Cleans up temp files in the finally block regardless of outcome.
//
export async function extractCookies(selected, opts) {
  const { path: dbPath, config, profile: profileDir } = selected

  let workingPath = dbPath
  let isTempCopy  = false
  let method      = 'live'

  if (config.alwaysCopy) {
    workingPath = await copyFirefoxDatabase(dbPath)
    method      = 'WAL-safe snapshot'
    isTempCopy  = true
  } else if (!await canQueryLive(dbPath, config)) {
    try {
      workingPath = await copyChromiumDatabase(dbPath)
      method      = 'WAL-safe snapshot'
      isTempCopy  = true
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        throw new Error(
          `Cookie database is locked by ${config.name} — close the browser and try again.\n` +
          `  → On Windows, check for background browser processes (WebView2, updaters).`
        )
      }
      throw err
    }
  }

  try {
    return await readAndDecrypt(workingPath, dbPath, method, config, profileDir, opts)
  } finally {
    if (isTempCopy) {
      if (config.alwaysCopy) {
        await removeTempDatabase(workingPath)
      } else {
        await removeChromiumTempDatabase(workingPath)
      }
    }
  }
}
