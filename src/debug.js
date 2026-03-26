import { c, dim, bold, pad } from './ansi.js'

//
// Debug rendering helpers — only used when --debug is passed.
//
// Kept in a separate module so the application code stays focused on the main pipeline,
// and so these utilities can be imported by diagnostic tools.
//

// Word-wrap a list of cookie names into the debug box width.
// Continuation lines are indented to align with the first name.
function wrapNames(names, colWidth, contPad) {
  const sepW = 2
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

export function debugSessionStore({ source, method, tmpPath, sizeKB, sizeMB, sqliteVer, entryCount }) {
  const row = (k, v) => `  ${dim('│')}  ${dim(k.padEnd(9))}  ${dim(v)}`

  console.log(`  ${dim('┌─')} ${c.ansi256(75)(bold('Session store info'))}`)
  console.log(row('source',  source))
  if (method && method !== 'live') console.log(row('method',  method))
  if (tmpPath)                     console.log(row('tmpfile', tmpPath))
  console.log(row('size',    `${sizeMB}MB (${sizeKB}KB)`))
  console.log(row('sqlite',  'v' + sqliteVer))
  console.log(row('entries', String(entryCount)))
  console.log(`  ${dim('└─')}`)
}

export function debugStage(label, cookies) {
  console.log(`\n  ${dim('┌─')} ${c.ansi256(75)(bold(label))}`)

  const termW   = process.stdout.columns ?? 160
  const colW    = Math.max(40, termW - 12)
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

export function renderCookie(cookie) {
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
      const display = String(v) + ' ' + formatExpiryHint(k, v)
      return `${indent}${key}  ${c.byellow(display)}`
    }

    if (typeof v === 'boolean') return `${indent}${key}  ${v ? c.bgreen('true') : dim('false')}`
    if (v == null)              return `${indent}${key}  ${dim('—')}`
    return `${indent}${key}  ${dim(String(v))}`
  }).join('\n')
}

// Returns a dim date hint for expiry fields, or '' for other fields.
function formatExpiryHint(fieldName, rawValue) {
  if (!/expir/i.test(fieldName)) return ''

  const v = Number(rawValue ?? -1)
  if (v <= 0) return dim('(ephemeral session cookie)')

  // Chrome uses microseconds since Windows epoch (Jan 1, 1601).
  // Values > 1e13 can't be Unix seconds — convert from Chrome epoch.
  const unix = v > 1e13
    ? Math.floor(v / 1_000_000) - 11644473600
    : v

  const date = new Date(unix * 1000)
  if (isNaN(date.getTime())) return ''
  return dim(`(${date.toISOString().slice(0, 10)})`)
}
