import { execFileSync } from 'child_process'
import { createDecipheriv, pbkdf2Sync } from 'crypto'

import { dim } from './ansi.js'

//
// Chromium cookie decryption — cross-platform
//
// Blob format (macOS / Linux):
//   [ "v10"/"v11" (3B) | AES-128-CBC ciphertext ]
//   Key: PBKDF2-SHA1(keychain_password, 'saltysalt', iterations=1003, keylen=16)
//
// Two ciphertext layouts exist in the wild:
//
//   Standard (Chrome, Brave, Edge, older Chromium):
//     IV = 16 × 0x20 (hardcoded space chars)
//     ciphertext starts at byte 3
//
//   Nonce-prefix (Opera, Chrome Beta, newer Chromium builds):
//     A 32-byte per-session nonce is prepended to every value before encryption.
//     blob: [v10 3B][CT_nonce1 16B][CT_nonce2 16B][CT_value ...]
//     To skip the nonce, use CT_nonce2 (blob[19:35]) as the CBC IV
//     and blob[35:] as the ciphertext — pure CBC chaining math.
//
// We try the standard path first. If it produces non-printable output we
// retry with the nonce-skip path. This auto-detects the layout without
// needing to know which browser variant wrote the blob.
//
// Windows:
//   v10: DPAPI — CryptUnprotectData on the payload after the 3B prefix
//   v20: app-bound AES (Chrome 127+) — not supported, clear error given
//
// Linux key storage:
//   Chromium-family browsers store the PBKDF2 password in whichever secret store
//   is available at first launch. The lookup attributes vary by browser version,
//   distro, and backend (gnome-libsecret vs kwallet). If no secret store was
//   available at launch, the browser falls back to basic mode — cookies are either
//   stored with a hardcoded key or unencrypted. See getPasswordLinux() below.
//

const ITERATIONS       = 1003  // used with secret-service key
const ITERATIONS_BASIC = 1     // used with the peanuts fallback key
const KEY_LEN          = 16
const SALT             = Buffer.from('saltysalt')
const STANDARD_IV      = Buffer.alloc(16, ' ')  // 16 × 0x20

// Chromium's "basic" fallback password — used when no secret service is
// available at browser launch. Iterations=1 (not 1003) distinguishes it
// from the secret-service-derived key.
const PEANUTS_PASSWORD = 'peanuts'

const PREFIX_V10 = Buffer.from('v10')
const PREFIX_V11 = Buffer.from('v11')
const PREFIX_V20 = Buffer.from('v20')
const PREFIX_LEN = 3

//
// Blob utilities
//

// Bun's SQLite driver may return BLOB columns as Uint8Array, Buffer, or a
// latin1-mangled string. latin1 is a lossless 1:1 byte mapping.
function toBuffer(val) {
  if (!val) return null
  if (Buffer.isBuffer(val))      return val
  if (val instanceof Uint8Array) return Buffer.from(val)
  if (typeof val === 'string')   return Buffer.from(val, 'latin1')
  return null
}

function chromiumPrefix(buf) {
  if (!buf || buf.length <= PREFIX_LEN) return null
  for (const p of [PREFIX_V10, PREFIX_V11, PREFIX_V20]) {
    if (buf.subarray(0, PREFIX_LEN).equals(p)) return p
  }
  return null
}

export function isEncryptedBlob(val) {
  return chromiumPrefix(toBuffer(val)) !== null
}

function isPrintable(str) {
  return str.length > 0 && /^[\x20-\x7e]+$/.test(str)
}

//
// Platform password retrieval
//

// Thrown when the user explicitly cancels or denies the Keychain prompt.
// Caught in cli.js to produce a clean exit(0) rather than an error exit(1).
export class KeychainCancelledError extends Error {
  constructor(browserName) {
    super(`Keychain access cancelled for ${browserName}`)
    this.name = 'KeychainCancelledError'
  }
}

const SERVICE_NAMES = {
  chrome:   'Chrome Safe Storage',
  chromium: 'Chromium Safe Storage',
  opera:    'Opera Safe Storage',
  edge:     'Microsoft Edge Safe Storage',
  brave:    'Brave Safe Storage',
  vivaldi:  'Vivaldi Safe Storage',
  arc:      'Arc Safe Storage',
}

function serviceNameFor(browserName) {
  const key = browserName.toLowerCase().replace(/\s+/g, '')
  for (const [k, v] of Object.entries(SERVICE_NAMES)) {
    if (key.includes(k)) return v
  }
  return null
}

function getPasswordMacOS(serviceName, browserName) {
  try {
    const out = execFileSync(
      'security', ['find-generic-password', '-s', serviceName, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }
    )
    return out.trim()
  } catch (err) {
    // exit 36  = user clicked "Don't Allow" or cancelled the prompt
    // exit 128 = timed out waiting for the prompt (treated as cancel)
    if (err.status === 36 || err.status === 128 || err.killed) {
      throw new KeychainCancelledError(browserName ?? serviceName)
    }
    // exit 44 = entry not found (browser never opened, or entry was deleted)
    const hint = err.status === 44
      ? `Entry not found — has ${browserName ?? serviceName} been opened at least once?`
      : `Unexpected error (exit ${err.status}) — try running "security find-generic-password -s '${serviceName}' -w" manually.`
    throw new Error(`Keychain read failed for "${serviceName}".\n  → ${hint}`)
  }
}

// Try a single secret-tool lookup. Returns the password string or null.
function secretToolLookup(args, timeout = 5_000) {
  try {
    const out = execFileSync('secret-tool', ['lookup', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout })
    const v = out.trim()
    return v || null
  } catch {
    return null
  }
}

// Try a single kwallet-query lookup. Returns the password string or null.
function kwalletLookup(serviceName, timeout = 5_000) {
  try {
    const browserKey = serviceName.replace(' Safe Storage', '')
    const out = execFileSync(
      'kwallet-query',
      ['--read-password', serviceName, '--folder', `${browserKey} Keys`, 'kdewallet'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout })
    const v = out.trim()
    return v || null
  } catch {
    return null
  }
}

//
// Linux secret retrieval
//
// Chromium-family browsers store their PBKDF2 password under different attribute
// sets depending on the browser version, distro, and whether gnome-libsecret or
// kwallet was used. We try all known patterns in order:
//
//   gnome-libsecret (via secret-tool):
//     1. service="<Name> Safe Storage" account="<name>"
//        — classic schema, used by Chrome/Chromium/Opera up to ~2023
//     2. Title="<Name> Safe Storage"
//        — stored by some distro packages and older Chromium builds
//     3. xdg:schema="chrome_libsecret_os_crypt_password_v2" application="<name>"
//        — newer Chrome/Chromium builds (libsecret v2 schema, Chrome 116+)
//     4. xdg:schema="chrome_libsecret_os_crypt_password_v2" (no application filter)
//        — fallback if the application attribute differs from expected
//
//   kwallet (via kwallet-query):
//     5. folder "<Name> Keys", key "<Name> Safe Storage"
//        — standard KDE wallet layout
//
// If none succeed, the key was never stored — Opera/Chrome likely launched without
// a secret service available and fell back to "basic" (plaintext or no) encryption.
// In that case the v10 prefix means the cookies are encrypted with a fixed key
// derived from an empty password. We try that as a last resort.
//
function getPasswordLinux(serviceName, browserName) {
  // Derive the short browser name from the service name for lookup attributes
  const shortName = serviceName.replace(' Safe Storage', '').toLowerCase()

  //
  // 1. Classic gnome-libsecret: service + account
  //
  const try1 = secretToolLookup(['service', serviceName, 'account', shortName])
  if (try1) return try1

  //
  // 2. Title attribute
  //
  const try2 = secretToolLookup(['Title', serviceName])
  if (try2) return try2

  //
  // 3. Newer libsecret v2 schema with application attribute
  //
  const try3 = secretToolLookup(['xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', shortName])
  if (try3) return try3

  //
  // 4. Newer libsecret v2 schema without application filter
  //    (catches cases where the application attribute has a different capitalisation)
  //
  const try4 = secretToolLookup(['xdg:schema', 'chrome_libsecret_os_crypt_password_v2'])
  if (try4) return try4

  //
  // 5. KWallet
  //
  const try5 = kwalletLookup(serviceName)
  if (try5) return try5

  //
  // Nothing found in any secret store. The browser likely launched without a
  // secret service available and fell back to Chromium's "basic" mode, which
  // uses PBKDF2-SHA1("peanuts", 'saltysalt', iterations=1, keylen=16).
  // Signal this to the caller with a null return so it can use the right
  // key derivation parameters.
  //
  console.warn(`  ⚠  No secret service entry found for ${serviceName} — trying basic fallback key.`)
  return null
}

function decryptDPAPI(payloadBuf) {
  const b64 = payloadBuf.toString('base64')
  const ps  = [
    `$b=[Convert]::FromBase64String('${b64}')`,
    `$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,` +
      `[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `[Convert]::ToBase64String($p)`,
  ].join(';')
  const out = execFileSync(
    'powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }
  )
  return Buffer.from(out.trim(), 'base64').toString('utf8')
}

//
// Key derivation
//

const keyCache = new Map()

function getDerivedKey(browserName) {
  // Cache by service name so Chrome and "Chrome Beta" share one lookup
  // (they use the same "Chrome Safe Storage" entry).
  const svc = serviceNameFor(browserName)

  if (process.platform === 'darwin') {
    if (!svc) throw new Error(`No Keychain service name known for: ${browserName}`)
    if (keyCache.has(svc)) return keyCache.get(svc)

    const password = getPasswordMacOS(svc, browserName)
    const derived  = pbkdf2Sync(Buffer.from(password, 'utf8'), SALT, ITERATIONS, KEY_LEN, 'sha1')
    keyCache.set(svc, derived)
    return derived
  }

  // Linux and BSDs both use libsecret / kwallet via the same code path.
  // secret-tool works wherever libsecret is available, including FreeBSD.
  if (process.platform === 'linux'   ||
      process.platform === 'freebsd' ||
      process.platform === 'openbsd' ||
      process.platform === 'netbsd') {
    const k = svc ?? browserName

    // Return a { key, isBasic } object so the decryption path knows whether
    // to expect the 32-byte host-binding prefix in the plaintext.
    if (keyCache.has(k)) return keyCache.get(k)

    const password = getPasswordLinux(k, browserName)

    if (password === null) {
      // No secret service entry — use the Chromium basic fallback.
      // Basic mode: PBKDF2-SHA1("peanuts", 'saltysalt', iterations=1, keylen=16)
      const derived = pbkdf2Sync(Buffer.from(PEANUTS_PASSWORD, 'utf8'), SALT, ITERATIONS_BASIC, KEY_LEN, 'sha1')
      const result  = { key: derived, isBasic: true }
      keyCache.set(k, result)
      return result
    }

    const derived = pbkdf2Sync(Buffer.from(password, 'utf8'), SALT, ITERATIONS, KEY_LEN, 'sha1')
    const result  = { key: derived, isBasic: false }
    keyCache.set(k, result)
    return result
  }

  throw new Error(`getDerivedKey: unsupported platform ${process.platform}`)
}

//
// Decryption
//

function tryCBC(key, iv, ct) {
  if (ct.length === 0 || ct.length % 16 !== 0) return null
  try {
    const d = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

function decryptBlob(encryptedValue, browserName) {
  const buf    = toBuffer(encryptedValue)
  const prefix = chromiumPrefix(buf)
  if (!prefix) return null

  if (prefix.equals(PREFIX_V20)) {
    throw new Error(
      'v20 app-bound encryption (Chrome 127+) is not supported on Windows.\n' +
      '  → Use Firefox, or export cookies via a browser extension instead.'
    )
  }

  if (process.platform === 'win32' && prefix.equals(PREFIX_V10)) {
    try { return decryptDPAPI(buf.subarray(PREFIX_LEN)) } catch { return null }
  }

  // macOS / Linux / BSD: AES-128-CBC, PBKDF2-derived key
  const derived = getDerivedKey(browserName)

  // On Linux/BSD getDerivedKey returns { key, isBasic }; on macOS it returns
  // the raw Buffer directly (no isBasic concept — Keychain always has the key).
  const key     = derived?.key ?? derived
  const isBasic = derived?.isBasic ?? false

  const ct = buf.subarray(PREFIX_LEN)  // everything after "v10"/"v11"

  // Helper: strip the 32-byte SHA256(host_key) domain-binding prefix that
  // newer Chromium versions prepend to the plaintext before encrypting.
  // In basic mode the prefix is always present. In secret-service mode it
  // may or may not be, depending on the browser version.
  function stripPrefix(s) {
    if (!s) return s
    // If the first 32 chars are non-printable and the rest are printable,
    // the 32-byte prefix is present — strip it.
    if (s.length > 32 && !/^[ -~]{32}/.test(s) && isPrintable(s.slice(32))) {
      return s.slice(32)
    }
    return s
  }

  //
  // Path 1: standard (fixed 16-space IV, full ciphertext)
  //
  const standard = tryCBC(key, STANDARD_IV, ct)
  if (standard !== null) {
    const v = isBasic ? stripPrefix(standard) : standard
    if (v !== null && isPrintable(v)) return v
  }

  //
  // Path 2: nonce-prefix (Opera, Chrome Beta, newer Chromium)
  //
  // blob: [prefix 3B][CT_nonce1 16B][CT_nonce2 16B][CT_value ...]
  // Skip nonce by using CT_nonce2 as the CBC IV for the value blocks.
  // Requires at least 3 blocks past the prefix (nonce1 + nonce2 + value).
  if (ct.length >= 48) {
    const nonceIV = ct.subarray(16, 32)  // CT_nonce2 = blob[19:35]
    const valueCT = ct.subarray(32)      // CT_value  = blob[35:]
    const nonce   = tryCBC(key, nonceIV, valueCT)
    if (nonce !== null) {
      const v = isBasic ? stripPrefix(nonce) : nonce
      if (v !== null && isPrintable(v)) return v
    }
  }

  // Return stripped standard result even if not printable — caller handles bad values
  return isBasic ? stripPrefix(standard) : standard
}

//
// Public API
//

// Pass only the encrypted cookies to this function
export function decryptCookies(cookies, browserName) {
  const source = { darwin: 'macOS Keychain', linux: 'secret service', win32: 'DPAPI' }

  // macOS shows the Keychain prompt up to twice: once per keychain entry that Chrome
  // has created (login keychain + local items keychain). Both prompts are for the same
  // key. Click Allow or Always Allow on each — Always Allow skips future prompts.
  console.log(`  🔐 Querying ${source[process.platform] ?? process.platform} for ${browserName} decryption key${process.platform === 'darwin' ? dim(' — if you get 2 password prompts it is normal') : ''}`)

  let decrypted = 0, failed = 0, fatalError = null

  for (const cookie of cookies) {
    try {
      const plaintext = decryptBlob(cookie.encryptedValue, browserName)
      if (plaintext !== null && plaintext.length > 0) {
        cookie.value = plaintext
        decrypted++
      } else {
        cookie.value = ''
        failed++
      }
    } catch (err) {
      // Let cancellation propagate immediately
      if (err instanceof KeychainCancelledError) throw err

      if (!fatalError) {
        fatalError = err
        console.warn(`\n  ⚠  Fatal error when decoding cookie value: ${cookie.name}`)
      }

      cookie.value = ''
      failed++
    }
  }

  if (fatalError) {
    throw fatalError
  } else {
    const failNote = failed > 0 ? `  (${failed} failed)` : ''
    console.log(`  ✔  ${decrypted} decrypted${failNote}`)
  }
}
