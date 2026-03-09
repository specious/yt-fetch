import { BROWSERS } from './browsers.js'
import { Glob } from 'bun'
import os from 'os'
import path from 'path'

/**
 * Expand shell patterns: ~ → home, %VAR% → environment variables
 */
function expandPath(pattern) {
  return pattern
    .replace(/~/g, os.homedir())
    .replace(/%([^%]+)%/g, (match, varName) => process.env[varName] || match)
}

/**
 * Smart cookie database discovery across all configured browsers
 * @returns {Promise<Array<{path, browser, profile, config}>>} Found databases
 */
export async function findAllCookies() {
  const results = []

  // Prioritize Firefox first (most reliable)
  const browserOrder = ['firefox', 'chrome', 'edge', 'opera', 'safari']

  for (const id of browserOrder) {
    const config = BROWSERS[id]
    if (!config) continue

    const patterns = config.profiles[process.platform] || []
    if (patterns.length === 0) continue

    console.log(`🔍 ${config.name} profiles:`)

    for (const pattern of patterns) {
      const base = expandPath(pattern)
      console.log(`  ${base}`)

      try {
        const glob = new Glob(`${base}${config.dbName}`)
        let foundCount = 0

        for await (const file of glob.scan()) {
          foundCount++
          results.push({
            path: file,
            browser: config.name,
            profile: path.dirname(file),
            config,
          })
        }

        if (foundCount === 0) {
          console.log(`  (none)`)
        } else {
          console.log(`  ✅ ${foundCount} found`)
        }
      } catch (error) {
        console.log(`  (not found)`)
      }
    }
  }

  // Sort by recency (modification time) then reverse path
  results.sort((a, b) => {
    // Most recently modified first
    return 0 // Placeholder - add fs.stat if needed
  })

  console.log(`\n📊 Total: ${results.length} cookie databases found`)
  return results
}

/**
 * Select best database (Firefox preferred, then largest file, interactive picker)
 * @param {Array} candidates - From findAllCookies()
 * @returns {Promise<{path, browser, profile, config}>} Selected database
 */
export async function selectDatabase(candidates) {
  if (candidates.length === 0) {
    throw new Error('No browser cookie databases found')
  }

  // Prefer Firefox
  const firefox = candidates.find(c => c.browser.toLowerCase().includes('firefox'))
  if (firefox && firefox.config.table) {
    console.log(`\n✅ Firefox auto-selected: ${path.basename(firefox.profile)}`)
    return firefox
  }

  // Show top 5 candidates
  console.log(`\n📂 Found cookie databases:`)
  candidates.slice(0, 5).forEach((candidate, i) => {
    const shortPath = path.relative(process.env.HOME || '~', candidate.profile)
    console.log(`  ${i + 1}. ${candidate.browser} (${shortPath})`)
  })

  // Non-interactive: use first valid SQLite database
  const valid = candidates.find(c => c.config.table)
  if (valid) {
    console.log(`\n✅ Using: ${valid.browser} (${path.basename(valid.profile)})`)
    return valid
  }

  throw new Error('No SQLite-compatible browsers found (Safari needs custom parser)')
}
