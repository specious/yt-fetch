import { BROWSERS } from './browsers.js'
import { enrichCandidates } from './select-session.js'
import { c, dim, bold } from './ansi.js'
import { Glob } from 'bun' // (requires Bun >= 1.0.14)
import os from 'os'
import path from 'path'

function expandPath(pattern) {
  return pattern
    .replace(/~/g, os.homedir())
    .replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`)
}

// Tilde-relative display path, trailing slash stripped
function displayPath(absPath) {
  const home = os.homedir()
  let p = absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath
  return p.replace(/\/$/, '')
}

export async function findAllCookies() {
  const results = []
  const browserOrder = ['firefox', 'chrome', 'brave', 'edge', 'opera', 'safari']

  console.log(dim('─'.repeat(60)))
  console.log(`  ${bold('Scanning system for browser sessions')}`)
  console.log(dim('─'.repeat(60)))

  for (const id of browserOrder) {
    const config   = BROWSERS[id]
    if (!config) continue

    const patterns = config.profiles[process.platform] || []
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
            // Don't push to results — Safari can't be used yet
          } else {
            console.log(`${prefix}${dim(display)}  ${dim('(none)')}`)
          }
        } else {
          const glob = new Glob(filePath)
          let found = 0

          for await (const file of glob.scan()) {
            found++
            results.push({
              path:      file,
              browser:   config.name,
              profile:   path.dirname(file),
              config,
              mtimeMs:   0,
              sizeBytes: 0,
              score:     0,
            })
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
