import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { Glob } from 'bun' // (requires Bun >= 1.0.14)

import { BROWSERS } from './browsers.js'
import { enrichCandidates } from './select-session.js'
import { c, dim, bold } from './ansi.js'

// Normalize to forward slashes for Bun's Glob (which uses POSIX paths on all platforms).
// On Windows, env vars like %LOCALAPPDATA% expand to backslash paths; mixing them with
// our forward-slash suffix patterns breaks glob matching.
function expandPath(pattern) {
  return pattern
    .replace(/~/g, os.homedir())
    .replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`)
    .replace(/\\/g, '/')
}

// Tilde-relative display path, trailing slash stripped, forward slashes throughout.
function displayPath(absPath) {
  const home = os.homedir().replace(/\\/g, '/')
  const p    = absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath
  return p.replace(/\/$/, '')
}

//
// WSL: detect whether we are running inside WSL and, if so, return the list of
// Windows user home directories accessible under /mnt/c/Users/.
// Returns an empty array on non-WSL systems or if /mnt/c is not mounted.
//
const WINDOWS_SYSTEM_USERS = new Set(['Public', 'Default', 'Default User', 'All Users'])

// Return Windows user directories accessible under /mnt/c/Users/ — works in WSL and any
// other Linux environment where the Windows filesystem is mounted there.
// Uses fs.readdir rather than Glob: Bun's Glob does not reliably traverse the FUSE/plan9
// virtual filesystem that WSL mounts under /mnt/c.
async function getWindowsMntUsers() {
  if (process.platform !== 'linux') return []

  try {
    const entries = await fs.readdir('/mnt/c/Users', { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !WINDOWS_SYSTEM_USERS.has(e.name))
      .map(e => `/mnt/c/Users/${e.name}`)
  } catch {
    return []
  }
}

// Expand a win32 browser profile pattern to an absolute path under a WSL Windows user dir.
// Replaces %APPDATA% / %LOCALAPPDATA% with the appropriate subdirectory.
function expandWin32PatternForWSL(pattern, windowsUserDir) {
  return pattern
    .replace(/%APPDATA%/gi,      `${windowsUserDir}/AppData/Roaming`)
    .replace(/%LOCALAPPDATA%/gi, `${windowsUserDir}/AppData/Local`)
    .replace(/\\/g, '/')
}

export async function findAllCookies() {
  const results = []
  const browserOrder = ['firefox', 'chrome', 'brave', 'edge', 'opera', 'safari']

  const wslUsers = await getWindowsMntUsers()

  console.log(dim('─'.repeat(60)))
  console.log(`  ${bold('Scanning system for browser sessions')}`)
  if (wslUsers.length > 0) console.log(`  ${dim('(also scanning Windows profiles under /mnt/c)')}`)
  console.log(dim('─'.repeat(60)))

  for (const id of browserOrder) {
    const config = BROWSERS[id]
    if (!config) continue

    const nativePatterns = config.profiles[process.platform] || []

    // Also scan Windows browser profiles through /mnt/c/Users/ when available
    const wslPatterns = wslUsers.flatMap(u =>
      (config.profiles.win32 || []).map(p => expandWin32PatternForWSL(p, u))
    )

    const patterns = [...nativePatterns, ...wslPatterns]
    if (patterns.length === 0) continue

    console.log(`\n  ${c.bcyan('◆')} ${bold(config.name)}`)

    for (const pattern of patterns) {
      const base    = expandPath(pattern)
      const display = displayPath(base)
      const prefix  = `     ${dim('│')} `

      try {
        const filePath = `${base}${config.dbName}`

        if (id === 'safari') {
          // Safari files may be in sandboxed containers that glob can't reach.
          // Use a direct existence check instead.
          let exists = false
          try { await fs.access(filePath); exists = true } catch {}

          if (exists) {
            console.log(`${prefix}${c.white(display)}  ${c.yellow('✓ found')}  ${dim('(not yet supported)')}`)
          } else {
            console.log(`${prefix}${dim(display)}  ${dim('(none)')}`)
          }
        } else {
          // Try dbName first (e.g. Network/Cookies), then dbFallback (Cookies).
          const dbCandidates = [
            { db: config.dbName, depth: config.dbName.split('/').length },
            ...(config.dbFallback
              ? [{ db: config.dbFallback, depth: config.dbFallback.split('/').length }]
              : []),
          ]

          let found = 0

          for (const { db, depth } of dbCandidates) {
            const glob = new Glob(`${base}${db}`)
            for await (const file of glob.scan()) {
              // depth = path components in the db name (e.g. 'Network/Cookies' → 2,
              // 'Cookies' → 1). Calling dirname that many times walks from the cookie
              // file back up to the profile directory.
              let profile = file
              for (let i = 0; i < depth; i++) profile = path.dirname(profile)
              found++
              results.push({ path: file, browser: config.name, profile, config, mtimeMs: 0, sizeBytes: 0, score: 0 })
            }
            if (found > 0) break // Don't try fallback if primary matched
          }

          if (found === 0) {
            console.log(`${prefix}${dim(display)}  ${dim('(none)')}`)
          } else {
            console.log(`${prefix}${c.white(display)}  ${c.bgreen(`✓ ${found} found`)}`)
          }
        }
      } catch {
        console.log(`${prefix}${dim(display)}  ${dim('(none)')}`)
      }
    }
  }

  //
  // Enrich and summarise
  //
  await enrichCandidates(results)

  const n    = results.length
  const noun = n === 1 ? 'session' : 'sessions'

  console.log()
  console.log(dim('─'.repeat(60)))
  console.log(`  ${c.byellow('◈')} ${bold(String(n))} browser ${noun} found`)
  console.log(dim('─'.repeat(60)))

  return results
}
