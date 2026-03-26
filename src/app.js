//
// Shared application constants
//
// Imported by cli.js, find-cookies.js, and any future modules that need
// to display the app name or version without re-reading package.json.
//

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Read in package.json
const pkg = JSON.parse(
  await fs.readFile(path.join(__dirname, '../package.json'), 'utf8')
)

export const APP_NAME    = pkg.name    ?? 'yt-fetch'
export const APP_VERSION = pkg.version ?? '(unknown version)'
export const CLI_NAME    = Object.keys(pkg.bin ?? {})[0] ?? 'yt'
