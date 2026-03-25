import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { Database } from 'bun:sqlite'

import { c, dim, bold, pad } from './ansi.js'
import { getQuery } from './browsers.js'
import { findAllCookies } from './find-cookies.js'
import { autoSelect, interactivePick, filterCandidates, listCandidates } from './select-session.js'
import { decryptCookies, isEncryptedBlob, KeychainCancelledError } from './decrypt-cookies.js'
import { normalizeCookies } from './normalize-cookies.js'
import { scrapeHistory } from './scrape.js'
import { printVideos } from './format-output.js'

const APP_NAME = 'yt-fetch'
const CLI_NAME = 'yt'

//
// Argument parsing
//

const VALID_OUTPUTS    = ['pretty', 'json', 'yaml']
const VALID_URL_STYLES = ['short', 'canonical']
const VALID_SORTS      = ['asc', 'desc']

function parseArgs(argv) {
  const args = argv.slice(2)
  const opts = {
    interactive:  false,
    list:         false,
    browser:      null,
    profile:      null,
    maxVideos:    null,
    output:       'pretty',   // pretty | json | yaml
    urlStyle:     'short',    // short | canonical
    sort:         'asc',      // asc | desc
    verbose:      false,
    debug:        false,
    quiet:        false,
    dryRun:       false,
    help:         false,
    version:      false,
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case '-i': case '--interactive':  opts.interactive  = true; break
      case '-l': case '--list':         opts.list         = true; break
      case '-v': case '--verbose':      opts.verbose      = true; break
      case '-q': case '--quiet':        opts.quiet        = true; break
      case '-h': case '--help':         opts.help         = true; break
      case '--debug':                   opts.debug        = true; opts.verbose = true; break
      case '--version':                 opts.version      = true; break
      case '--dry-run':                 opts.dryRun       = true; break

      case '-b': case '--browser': opts.browser   = args[++i]; break
      case '-p': case '--profile': opts.profile   = args[++i]; break
      case '-n': case '--max':     opts.maxVideos = parseInt(args[++i]) || null; break

      case '-o': case '--output': {
        const v = args[++i]
        if (!VALID_OUTPUTS.includes(v)) die(`Unknown output format: ${bold(v)}  (valid: ${VALID_OUTPUTS.join(', ')})`)
        opts.output = v
        break
      }
      case '--video-url': {
        const v = args[++i]
        if (!VALID_URL_STYLES.includes(v)) die(`Unknown URL style: ${bold(v)}  (valid: ${VALID_URL_STYLES.join(', ')})`)
        opts.urlStyle = v
        break
      }
      case '--sort': {
        const v = args[++i]
        if (!VALID_SORTS.includes(v)) die(`Unknown sort order: ${bold(v)}  (valid: ${VALID_SORTS.join(', ')})`)
        opts.sort = v
        break
      }

      default:
        console.warn(c.yellow(`  ⚠  Unknown argument: ${a}`) + dim('  (--help for usage)'))
    }
  }

  return opts
}

function die(msg) {
  console.error(`\n  ${c.bred('✖')}  ${msg}\n`)
  process.exit(1)
}

//
// Version and help
//

async function printVersion() {
  try {
    const pkgRaw = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw)
    const ver = pkg.version ?? '0.0.0'
    console.log(`${CLI_NAME} ${ver}`)
  } catch (err) {
    console.log(`${CLI_NAME} (unknown version)`)
  }
}

function printHelp() {
  const h = s => bold(c.bcyan(s))
  const f = (flag, desc) => `  ${c.bwhite(pad(flag, 26))}  ${dim(desc)}`

  console.log(`
${bold(CLI_NAME)} ${dim('—')} fetch your YouTube watch history via browser cookies

${h('Usage:')}
  ${CLI_NAME} [options]

${h('Selection:')}
${f('-i, --interactive',       'Choose which browser session to use interactively')}
${f('-l, --list',              'List all found sessions ranked by score, then exit')}
${f('-b, --browser <name>',    'Filter to a specific browser  (e.g. firefox, opera)')}
${f('-p, --profile <substr>',  'Filter by profile path substring  (e.g. Default)')}

${h('Output:')}
${f('-n, --max <n>',           'Limit number of videos returned  (default: all)')}
${f('-o, --output <fmt>',      'Output format: pretty (default), json, yaml')}
${f('    --video-url <style>', 'URL form: short (default, youtu.be) or canonical')}
${f('    --sort <order>',      'Sort: asc = newest-first (default), desc = oldest-first')}
${f('-q, --quiet',             'Suppress all progress output  (useful with json/yaml)')}
${f('-v, --verbose',           'Extra progress detail')}
${f('    --debug',             'Full cookie dumps at each stage  (implies --verbose)')}
${f('    --dry-run',           'Scan cookies but stop before launching the browser')}
${f('-h, --help',              'Show this help')}

${h('Examples:')}
  ${CLI_NAME}                        ${dim('# auto-select the best browser session')}
  ${CLI_NAME} -i                     ${dim('# choose interactively')}
  ${CLI_NAME} -b firefox             ${dim('# use Firefox, auto-pick profile')}
  ${CLI_NAME} -b chrome -i           ${dim('# pick from Chrome sessions interactively')}
  ${CLI_NAME} -l                     ${dim('# list all found sessions and exit')}
  ${CLI_NAME} -n 50                  ${dim('# return at most 50 videos')}
  ${CLI_NAME} -q --output json       ${dim('# clean JSON for piping')}
  ${CLI_NAME} -b opera --debug       ${dim('# diagnose Opera cookie extraction')}
  ${CLI_NAME} --dry-run              ${dim('# verify cookies without launching browser')}
`)
}

//
// Selected session card
//

function printSelected(selected, uniqueCount, skippedCount) {
  const { browser, profile, config, sizeBytes, mtimeMs } = selected

  const home   = process.env.HOME ?? os.homedir()
  const relDir = path.relative(home, path.dirname(profile))
  const leaf   = path.basename(profile)

  const sizeStr = sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
    : `${(sizeBytes / 1024).toFixed(0)} KB`

  const ageMs  = Date.now() - (mtimeMs ?? 0)
  const ageStr = ageMs < 60_000     ? `${Math.round(ageMs / 1000)}s ago`
               : ageMs < 3_600_000  ? `${Math.round(ageMs / 60_000)}m ago`
               : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h ago`
               :                      `${Math.round(ageMs / 86_400_000)}d ago`

  const encStatus  = config.cols?.encrypted ? c.yellow('encrypted') : c.bgreen('plaintext')
  const cookieStr = c.white(uniqueCount) + (skippedCount !== 0 ? dim(' (' + skippedCount + ' ignored)') : '')

  console.log()
  console.log(`  ${dim('┌─')} ${dim('Using cookies from:')} ${bold(browser)}`)
  console.log(`  ${dim('│')}  ${dim('profile')}   ~/${relDir}/${c.white(leaf)}`)
  console.log(`  ${dim('│')}  ${dim('cookies')}   ${cookieStr}`)
  console.log(`  ${dim('│')}  ${dim('format')}    ${encStatus}`)
  console.log(`  ${dim('│')}  ${dim('size')}      ${c.white(sizeStr)}`)
  console.log(`  ${dim('│')}  ${dim('modified')}  ${c.white(ageStr)}`)
  console.log(`  ${dim('└─')}`)
  console.log()
}

//
// Debug helpers
//

// Word-wrap a list of cookie names into the debug box width.
// Continuation lines are indented to align with the first name.
function wrapNames(names, colWidth, contPad) {
  const sepW = 2  // visible width of ', '
  let line   = ''
  let lineW  = 0
  const out  = []

  for (let i = 0; i < names.length; i++) {
    const name   = names[i]
    const isLast = i === names.length - 1
    const chunkW = name.length + (isLast ? 0 : sepW)

    if (lineW + chunkW > colWidth && lineW > 0) {
      out.push(line.trimEnd())
      line  = contPad
      lineW = 0
    }
    line  += isLast ? name : name + dim(', ')
    lineW += chunkW
  }
  if (line) out.push(line)
  return out.join('\n')
}

function debugSessionStore({ source, method, tmpfile, size, sqlite, entries }) {
  const row = (k, v) => `  ${dim('│')}  ${dim(k.padEnd(9))}  ${dim(v)}`

  console.log(`  ${dim('┌─')} ${c.ansi256(75)(bold('Session store info'))}`)
  console.log(row('source',  source))
  if (method && method !== 'live') console.log(row('method',  method))
  if (tmpfile)                     console.log(row('tmpfile', tmpfile))
  console.log(row('size',    size))
  console.log(row('sqlite',  'v' + sqlite))
  console.log(row('entries', String(entries)))
  console.log(`  ${dim('└─')}`)
}

function debugStage(label, cookies) {
  console.log(`\n  ${dim('┌─')} ${c.ansi256(75)(bold(label))}`)

  // Use terminal width if known, default to 160. Subtract visible prefix '  │  names  ' = 12 chars.
  const termW   = process.stdout.columns ?? 160
  const colW    = Math.max(40, termW - 12)
  // Continuation indent: 2 + │ + 9 spaces = 12 visible chars, aligns with first name
  const contPad = `  ${dim('│')}         `
  const nameStr = wrapNames(cookies.map(ck => ck.name), colW, contPad)
  console.log(`  ${dim('│')}  ${dim('names')}  ${c.ansi256(252)(nameStr)}`)

  if (cookies.length > 0) {
    console.log(`  ${dim('│')}`)
    console.log(`  ${dim('│')}  ${dim('first cookie:')}`)
    console.log(`  ${dim('│')}`)
    console.log(renderCookie(cookies[0]))
  }

  console.log(`  ${dim('└─')}`)
}

function renderCookie(cookie) {
  const indent = `  ${dim('│')}  `
  return Object.entries(cookie).map(([k, v]) => {
    const key = dim(pad(k, 16))

    if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
      const buf    = Buffer.isBuffer(v) ? v : Buffer.from(v)
      const prefix = buf.subarray(0, 3).toString('ascii').replace(/[^\x20-\x7e]/g, '?')
      const hex    = [...buf.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ')
      const more   = buf.length > 8 ? dim(` …+${buf.length - 8}B`) : ''
      return `${indent}${key}  ${c.ansi256(208)(prefix)} ${dim(hex)}${more}`
    }

    if (typeof v === 'string') {
      if (!v.length) return `${indent}${key}  ${dim('(empty)')}`
      const isBinary = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(v)
      const display  = v.slice(0, 72) + (v.length > 72 ? '…' : '')
      return isBinary
        ? `${indent}${key}  ${c.bred(display)} ${dim('← still encrypted / binary')}`
        : `${indent}${key}  ${c.bwhite(display)}`
    }

    if (typeof v === 'number') {
      let display = String(v)

      // Expiry formatting
      if (k === 'expiry' || k === 'expires' || k === 'expires_utc') {
        display += ' ' + formatExpiryDate(v)
      }

      return `${indent}${key}  ${c.byellow(display)}`
    }

    if (typeof v === 'boolean')
      return `${indent}${key}  ${v ? c.bgreen('true') : dim('false')}`

    if (v == null)
      return `${indent}${key}  ${dim('—')}`

    return `${indent}${key}  ${dim(String(v))}`
  }).join('\n')
}

function formatExpiryDate(rawExpiry) {
  const v = Number(rawExpiry ?? -1)

  if (v <= 0) return dim('(ephemeral session cookie)')

  // Unified: Chrome micros OR Unix seconds → YYYY-MM-DD
  const unix = v > 1e15
    ? Math.floor(v / 1_000_000) - 11644473600  // Chrome → Unix
    : v  // Already Unix seconds

  const date = new Date(unix * 1000)
  return dim(`(${date.toISOString().slice(0, 10)})`)
}

//
// Pre-flight check
//

// Returns a human-readable diagnosis of why cookies are unusable, or null if OK.
// Called before launching Puppeteer so we don't waste ~5s on a doomed session.
function diagnoseCookies(cookies) {
  if (cookies.length === 0) {
    return 'No cookies survived normalization.'
  }

  const stillEncrypted = cookies.filter(
    ck => isEncryptedBlob(ck.value) || /[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(ck.value ?? '')
  )
  if (stillEncrypted.length > cookies.length / 2) {
    return (
      `${stillEncrypted.length}/${cookies.length} cookie values look like raw binary — decryption failed.\n` +
      `  → Re-run with ${c.white('--debug')} to inspect each pipeline stage.`
    )
  }

  if (!cookies.find(ck => ck.name === 'SAPISID')) {
    return (
      'No SAPISID cookie — YouTube session not found in this profile.\n' +
      '  → Sign in to YouTube in this browser, then re-run.\n' +
      '  → Or use -i to pick a different session.'
    )
  }

  return null
}

//
// Database helpers
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
// Cookie extraction
//

async function extractCookies(selected, opts) {
  const { path: dbPath, config } = selected

  let workingPath = dbPath
  let isTempCopy  = false
  let method      = 'live'

  if (config.alwaysCopy) {
    workingPath = await copyFirefoxDatabase(dbPath)
    method      = 'WAL-safe snapshot'
    isTempCopy  = true
  } else if (!await canQueryLive(dbPath, config)) {
    console.log(`  ${dim('·')}  Locked — browser is running, copying database...`)
    workingPath = path.join(os.tmpdir(), `${APP_NAME}-${Date.now()}-${path.basename(dbPath)}`)
    await fs.copyFile(dbPath, workingPath)
    method     = 'copy (locked)'
    isTempCopy = true
  }

  try {
    console.log(`  ${dim('·')}  Extracting cookies from: ${dbPath}`)
    return await readCookies(workingPath, dbPath, method, config, opts)
  } finally {
    if (isTempCopy) await removeTempDatabase(workingPath)
  }
}

async function readCookies(dbPath, originalPath, method, config, opts) {
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

  if (opts.debug) {
    console.log()
    debugSessionStore({
      source:  originalPath,
      method,
      tmpfile: method !== 'live' ? dbPath : null,
      size:    `${sizeMB}MB (${sizeKB}KB)`,
      sqlite:  sqliteVer,
      entries: rows.length,
    })
    debugStage(`SQLite ${sqliteVer} — ${rows.length} cookie entries`, rows)
    console.log()
  }

  if (rows.length === 0) {
    throw new Error(
      `No cookies found in this session store.\n\n` +
      `  → Make sure you have visited YouTube in this ${config.name} profile and are signed in, then re-run.\n` +
      `  → Or use -i to pick a different session.`
    )
  }

  // De‑duplicate: keep the entry with the furthest expiry for each cookie name
  const seen = new Map()
  for (const entry of rows) {
    const prev = seen.get(entry.name)
    if (!prev || (entry.expiry || 0) > (prev.expiry || 0)) seen.set(entry.name, entry)
  }
  const unique = [...seen.values()]

  // Chromium-family: decrypt only when value is empty and encryptedValue looks like a blob
  const toDecrypt = unique.filter(
    ck => (ck.value === '' || ck.value == null) && isEncryptedBlob(ck.encryptedValue)
  )

  if (toDecrypt.length === 0) {
    if (opts.verbose) {
      console.log(`  ${dim('·')}  None of the cookies require decryption`)
    }
  } else {
    decryptCookies(toDecrypt, config.name)

    if (opts.debug) {
      debugStage(`after decryption — ${unique.length} cookies`, unique)
      console.log()
    }

    if (opts.verbose) {
      const successCount = toDecrypt.filter(c => c.value && c.value.length > 0).length
      const successRate = ((successCount / toDecrypt.length) * 100).toFixed(0)
      console.log(`  ${dim('·')}  ${successCount}/${toDecrypt.length} cookies decrypted (${successRate}%)`)
    }
  }

  return { cookies: unique, uniqueCount: unique.length }
}

//
// Main
//

async function main() {
  const opts = parseArgs(process.argv)

  if (opts.help) {
    printHelp();
    process.exit(0)
  }

  if (opts.version) {
    await printVersion()
    process.exit(0)
  }

  // In quiet mode, suppress all progress output until the video list is ready.
  // We also intercept process.stdout.write because select-session.js uses it
  // directly for the interactive prompt (echoing keystrokes, cursor control).
  const origLog   = console.log.bind(console)
  const origWarn  = console.warn.bind(console)
  const origWrite = process.stdout.write.bind(process.stdout)

  function muteOutput() {
    console.log          = () => {}
    console.warn         = () => {}
    process.stdout.write = () => true
  }

  function restoreOutput() {
    console.log          = origLog
    console.warn         = origWarn
    process.stdout.write = origWrite
  }

  if (opts.quiet) muteOutput()

  try {
    const allCandidates = await findAllCookies()

    if (opts.list) { listCandidates(allCandidates); process.exit(0) }

    const candidates = (opts.browser || opts.profile)
      ? filterCandidates(allCandidates, opts)
      : allCandidates

    // If auto-selecting a Chromium browser but Firefox sessions are also available,
    // show a subtle hint — Firefox never requires a Keychain prompt.
    const willNeedKeychain = !opts.interactive &&
      candidates[0]?.config?.cols?.encrypted &&
      allCandidates.some(c => c.browser.toLowerCase().includes('firefox'))
    if (willNeedKeychain) {
      console.log(`  ${dim('·')}  ${dim('Tip: Firefox never requires Keychain access')}  ${dim('(-b firefox)')}`)
    }

    const selected = opts.interactive
      ? await interactivePick(candidates)
      : autoSelect(candidates)

    const extracted = await extractCookies(selected, opts)

    if (opts.verbose) {
      console.log(`  ${dim('·')}  Normalizing cookies`)
    }

    const { cookies, skippedCount } = normalizeCookies(extracted.cookies)

    if (opts.verbose) {
      if (skippedCount > 0) {
        console.log(`  ${dim('·')}  Ignoring ${c.white(String(skippedCount))} ST-* session sub-token cookies`)
      }
      console.log(`  ${dim('·')}  Normalized ${cookies.length} cookies`)
    }

    // Print the session card now that we have all counts from extraction + normalization
    printSelected(selected, extracted.uniqueCount, skippedCount)

    console.log(`  ${c.bgreen('✔')}  ${cookies.length} cookies prepared for injection`)

    if (opts.debug) debugStage(`after normalization — ${cookies.length} cookies`, cookies)

    // Pre-flight: diagnose before launching Puppeteer to avoid a wasted ~5s startup
    const problem = diagnoseCookies(cookies)
    if (problem) throw new Error(problem)

    if (opts.dryRun) {
      console.log()
      console.log(`  ${dim('·')}  Dry run — stopping before browser launch`)
      process.exit(0)
    }

    const videos = await scrapeHistory(cookies, { maxVideos: opts.maxVideos, debug: opts.debug })

    restoreOutput()
    printVideos(videos, { output: opts.output, urlStyle: opts.urlStyle, sort: opts.sort, quiet: opts.quiet })

  } catch (err) {
    restoreOutput()
    if (err instanceof KeychainCancelledError) {
      console.log(`\n  ${dim('·')}  Keychain access cancelled — nothing to do.`)
      process.exit(0)
    }
    console.error(`\n  ${c.bred('✖')}  ${err.message}`)
    if (opts.debug && err.stack) {
      console.error()
      console.error(dim(err.stack))
    }
    process.exit(1)
  }
}

main()
