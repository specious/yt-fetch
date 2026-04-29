import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

// ESM modules lack __dirname — derive it from the module's own URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pkg = JSON.parse(
  await fs.readFile(path.join(__dirname, '../package.json'), 'utf8')
)

//
// Shared application constants — imported wherever the app name or version
// is needed without re-reading package.json at the call site.
//

export const APP_NAME    = pkg.name    ?? 'yt-fetch'
export const APP_VERSION = pkg.version ?? '(unknown version)'
export const CLI_NAME    = Object.keys(pkg.bin ?? {})[0] ?? 'yt'
