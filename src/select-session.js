import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { c, dim, bold, italic, pad, strip } from './ansi.js'

//
// Browser session scoring, listing, filtering, and interactive selection.
//
// A "candidate" is an object produced by find-cookies.js:
//   { path, browser, profile, config, mtimeMs, sizeBytes, score }
//

//
// Scoring
//

const RECENCY_HALF_LIFE_DAYS = 7

// Higher = preferred by auto-select.
// Firefox scores highest because its cookies are plaintext (no Keychain prompt).
const BROWSER_PREFERENCE = {
  firefox:  100,
  chrome:    60,
  brave:     55,
  edge:      50,
  opera:     45,
  chromium:  40,
  safari:     0, // not yet supported
}

function browserScore(candidate) {
  const key = candidate.browser.toLowerCase().replace(/\s+/g, '')
  for (const [name, score] of Object.entries(BROWSER_PREFERENCE)) {
    if (key.includes(name)) return score
  }
  return 20
}

// Exponential decay: today scores 40, halves every RECENCY_HALF_LIFE_DAYS days.
// A session untouched for 3 half-lives (~21 days) contributes only 5 pts.
function recencyScore(candidate) {
  if (!candidate.mtimeMs) return 0
  const ageDays = (Date.now() - candidate.mtimeMs) / 86_400_000
  return Math.round(40 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS))
}

// 4 pts/MB, capped at 20 (≥5 MB). A larger cookie database is a proxy for
// an actively used profile with a richer session store.
function sizeScore(candidate) {
  const mb = (candidate.sizeBytes ?? 0) / (1024 * 1024)
  return Math.min(20, Math.round(mb * 4))
}

export function scoreCandidate(candidate) {
  return browserScore(candidate) + recencyScore(candidate) + sizeScore(candidate)
}

//
// Formatting helpers
//

function formatAgo(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function formatSize(bytes) {
  if (!bytes) return '?'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024).toFixed(0)}KB`
}

// A compact [████░░░░] score bar (max ~160 pts)
function scoreBar(score, maxScore = 160, width = 8) {
  const filled  = Math.round((score / maxScore) * width)
  const bar     = '█'.repeat(filled) + '░'.repeat(width - filled)
  const colored = score >= 100 ? c.bgreen(bar)
                : score >= 60  ? c.byellow(bar)
                :                c.ansi256(240)(bar)
  return dim('[') + colored + dim(']')
}

// Tilde-relative profile path with the leaf directory highlighted.
// Uses forward slashes throughout — profile paths are stored with forward
// slashes from the glob, and os.homedir() on Windows uses backslashes which
// would break the startsWith comparison and the subsequent split.
function formatProfilePath(candidate) {
  const home    = os.homedir().replace(/\\/g, '/')
  const profile = candidate.profile.replace(/\\/g, '/')
  const rel     = profile.startsWith(home) ? '~' + profile.slice(home.length) : profile

  const slash = rel.lastIndexOf('/')
  const dir   = rel.slice(0, slash + 1)  // includes trailing slash
  const leaf  = rel.slice(slash + 1)

  return `${dim(dir)}${c.white(leaf)}`
}

// One-line summary for a candidate — used in both list and picker views
function candidateLine(candidate, { showScore = false, index = null, isDefault = false, browserWidth = 20 } = {}) {
  const num     = index != null ? dim(`${String(index + 1).padStart(2)}.`) + ' ' : '   '
  const browser = pad(bold(candidate.browser), browserWidth)
  const profile = formatProfilePath(candidate)
  const meta    = dim(`${formatSize(candidate.sizeBytes)}, ${formatAgo(Date.now() - (candidate.mtimeMs || 0))}`)
  const bar     = showScore ? '  ' + scoreBar(candidate.score) : ''
  const dflt    = isDefault ? '  ' + c.bcyan('◀ default') : ''

  return `${num}${browser}  ${profile}  ${dim('(')}${meta}${dim(')')}${bar}${dflt}`
}

// Reason tags shown alongside the auto-selected browser
function autoReasons(candidate) {
  const tags = []
  if (browserScore(candidate) >= 100) tags.push('preferred browser')
  if (recencyScore(candidate) >= 35)  tags.push('recently used')
  if (sizeScore(candidate) >= 10)     tags.push('large profile')
  return tags.join(', ')
}

//
// Public API
//

export async function enrichCandidates(candidates) {
  await Promise.all(candidates.map(async candidate => {
    try {
      const stat          = await fs.stat(candidate.path)
      candidate.mtimeMs   = stat.mtimeMs
      candidate.sizeBytes = stat.size
    } catch {
      candidate.mtimeMs   = 0
      candidate.sizeBytes = 0
    }
    candidate.score = scoreCandidate(candidate)
  }))
  candidates.sort((a, b) => b.score - a.score)

  return candidates
}

export function autoSelect(candidates) {
  const valid = candidates.filter(c => c.config.table)
  if (valid.length === 0) {
    throw new Error('No supported browser sessions found. (Safari requires a custom parser.)')
  }
  const winner  = valid[0]
  const reasons = autoReasons(winner)
  const why     = reasons ? `  ${dim('(' + reasons + ')')}` : ''
  console.log()
  console.log(`  ${c.bgreen('✔')} ${bold('Selected:')} ${bold(winner.browser)}${why}`)

  return winner
}

export function listCandidates(candidates) {
  if (candidates.length === 0) {
    console.log(`  ${c.yellow('!')} No browser sessions found.`)
    return
  }

  console.log(`\n  ${bold('All found sessions')} ${dim('(ranked by score)')}\n`)

  const browserWidth = Math.max(...candidates.map(c => c.browser.length))
  for (let i = 0; i < candidates.length; i++) {
    const candidate   = candidates[i]
    const unsupported = !candidate.config.table ? `  ${dim(italic('not yet supported'))}` : ''
    console.log(`  ${candidateLine(candidate, { showScore: true, index: i, browserWidth })}${unsupported}`)
  }
  console.log()
}

export function filterCandidates(candidates, { browser, profile } = {}) {
  let results = candidates

  if (browser) {
    const b = browser.toLowerCase()
    results = results.filter(c => c.browser.toLowerCase().includes(b))
    if (results.length === 0) {
      throw new Error(`No sessions found for browser: ${bold(browser)}`)
    }
  }

  if (profile) {
    const p = profile.toLowerCase()
    results = results.filter(c =>
      c.profile.toLowerCase().includes(p) ||
      path.basename(c.profile).toLowerCase().includes(p)
    )
    if (results.length === 0) {
      throw new Error(`No sessions matching profile: ${bold(profile)}`)
    }
  }

  return results
}

//
// Interactive picker
//

export async function interactivePick(candidates) {
  const valid = candidates.filter(c => c.config.table)

  if (valid.length === 0) {
    throw new Error('No supported browser sessions found. (Safari requires a custom parser.)')
  }

  //
  // Render list
  //
  console.log()
  console.log(`  ${bold('Choose a browser session')} ${dim('(ranked by score)')}`)
  console.log()
  const browserWidth = Math.max(...valid.map(c => c.browser.length))
  for (let i = 0; i < valid.length; i++) {
    console.log(`  ${candidateLine(valid[i], { showScore: true, index: i, isDefault: i === 0, browserWidth })}`)
  }

  if (!process.stdin.isTTY) {
    console.log(`\n  ${c.yellow('⚠')}  stdin is not a TTY — using auto-selected default\n`)

    return valid[0]
  }

  //
  // Prompt
  //
  const singleKey = valid.length <= 9
  const hint = singleKey
    ? `${dim('[')}${c.bwhite('1')}${dim('–' + valid.length + ']')} or ${dim('Enter')} for default`
    : `enter ${dim('[')}${c.bwhite('1')}${dim('–' + valid.length + ']')} + ${dim('Enter')}, or just ${dim('Enter')} for default`

  process.stdout.write(`\n  ${c.bcyan('›')} ${hint}  `)

  return new Promise((resolve, reject) => {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    let buffer = ''

    function done(candidate) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n\n')
      console.log(`  ${c.bgreen('✔')} ${bold('Selected:')} ${bold(candidate.browser)}  ${dim('(manually selected)')}`)

      resolve(candidate)
    }

    function abort(reason) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')

      reject(new Error(reason))
    }

    process.stdin.on('data', key => {
      if (key === '\u0003' || key === '\u0004') { abort('Cancelled'); return } // Ctrl+C, Ctrl+D

      if (singleKey) {
        if (key === '\r' || key === '\n') { done(valid[0]); return }
        const n = parseInt(key)
        if (!isNaN(n) && n >= 1 && n <= valid.length) {
          process.stdout.write(c.bwhite(key))
          done(valid[n - 1])
        }
        return
      }

      // Multi-digit buffered input
      if (key === '\r' || key === '\n') {
        const n = buffer.trim() === '' ? 1 : parseInt(buffer.trim())
        done(isNaN(n) || n < 1 || n > valid.length ? valid[0] : valid[n - 1])
        return
      }
      // \u007f = DEL — what most terminal emulators send for the Backspace key
      if (key === '\u007f') {
        if (buffer.length > 0) { buffer = buffer.slice(0, -1); process.stdout.write('\b \b') }
        return
      }
      if (/^\d$/.test(key)) {
        buffer += key
        process.stdout.write(c.bwhite(key))
      }
    })
  })
}
