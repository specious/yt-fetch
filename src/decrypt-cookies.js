import { execFileSync } from 'child_process'
import { createDecipheriv, pbkdf2Sync } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'

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
//   v10: AES-256-GCM. The AES key is stored in the browser's "Local State" file as
//        os_crypt.encrypted_key (base64). Strip the 5-byte "DPAPI" magic prefix, then
//        CryptUnprotectData to recover the raw 32-byte key. Each cookie blob is then:
//        [v10 3B][IV 12B][ciphertext + GCM tag 16B].
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
const ITERATIONS_BASIC = 1     // 1 iteration (not 1003): the password is a public constant, so PBKDF2 hardening adds nothing
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

// Returns the raw decrypted bytes as a Buffer.
// Tries CurrentUser scope first, falls back to LocalMachine — some Chromium-based
// browsers (including some Opera builds) protect the key with LocalMachine scope.
//
// Add-Type is required: System.Security.Cryptography.ProtectedData lives in
// System.Security.dll which PowerShell 5 does not load by default.
function decryptDPAPIRaw(payloadBuf) {
  const b64 = payloadBuf.toString('base64')
  const ps  = [
    `Add-Type -AssemblyName System.Security`,
    `$b=[Convert]::FromBase64String('${b64}')`,
    `try {`,
    `  $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,` +
         `[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `} catch {`,
    `  $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,` +
         `[System.Security.Cryptography.DataProtectionScope]::LocalMachine)`,
    `}`,
    `[Convert]::ToBase64String($p)`,
  ].join(';')
  try {
    const out = execFileSync(
      'powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }
    )
    return Buffer.from(out.trim(), 'base64')
  } catch (err) {
    const detail = err.stderr?.trim() || err.message
    throw new Error(detail)
  }
}

//
// Windows: load and cache the AES-256-GCM key stored in the browser's Local State file.
//
// The key is base64-encoded under os_crypt.encrypted_key. Stripping the 5-byte "DPAPI"
// magic prefix leaves a raw DPAPI blob; decrypting that yields the 32-byte AES key.
//
// Local State lives one directory above the profile root:
//   profile = .../User Data/Default  →  Local State = .../User Data/Local State
//
const winKeyCache  = new Map()
// Track which browsers had GCM auth failures so decryptCookies can warn once.
const gcmFailedFor = new Set()
// Count v20 cookies per browser so we can show a single actionable message.
const v20CountFor  = new Map()

export function getV20Count(browserName) { return v20CountFor.get(browserName) ?? 0 }

function getChromiumWindowsKey(profileDir) {
  const cacheKey = profileDir
  if (winKeyCache.has(cacheKey)) return winKeyCache.get(cacheKey)

  // Locate Local State one directory above the profile root.
  // Avoid path.join/path.dirname: they normalise to backslashes on Windows which can
  // produce mixed-separator paths that confuse readFileSync on some Bun versions.
  const sep        = profileDir.includes('/') ? '/' : '\\'
  const parentDir  = profileDir.slice(0, profileDir.lastIndexOf(sep))
  const lsPath     = parentDir + sep + 'Local State'

  let ls
  try {
    ls = JSON.parse(readFileSync(lsPath, 'utf8'))
  } catch (err) {
    console.warn(`  ⚠  Local State not readable (${lsPath}): ${err.code ?? err.message}`)
    winKeyCache.set(cacheKey, null); return null
  }

  const encKeyB64 = ls?.os_crypt?.encrypted_key
  if (!encKeyB64) {
    console.warn(`  ⚠  No os_crypt.encrypted_key in Local State — will try fallback decryption`)
    winKeyCache.set(cacheKey, null); return null
  }

  // Base64-decode and strip the 5-byte "DPAPI" magic prefix before decrypting
  const encKeyBuf = Buffer.from(encKeyB64, 'base64').subarray(5)
  try {
    const key = decryptDPAPIRaw(encKeyBuf)
    winKeyCache.set(cacheKey, key)
    return key
  } catch (err) {
    console.warn(`  ⚠  DPAPI decryption of Local State key failed: ${err.message}`)
    winKeyCache.set(cacheKey, null); return null
  }
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
    const key    = pbkdf2Sync(Buffer.from(password, 'utf8'), SALT, ITERATIONS, KEY_LEN, 'sha1')
    const result = { key, isBasic: false }
    keyCache.set(svc, result)
    return result
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

// Strip the 32-byte SHA256(host_key) domain-binding prefix that newer
// Chromium versions prepend to the plaintext before encrypting.
// In basic mode the prefix is always present; in secret-service mode it
// depends on the browser version.
//
// Must operate on a raw Buffer, not a UTF-8 string: the 32-byte SHA256 hash
// can contain byte pairs that form valid multi-byte UTF-8 sequences, making
// the resulting JS string shorter than 32 characters. Slicing at char index 32
// then cuts one or more bytes into the actual cookie value.
function stripPrefixBuffer(buf) {
  if (!buf || buf.length <= 32) return buf
  // Detection heuristic: a SHA256 hash has entropy across the full byte range and will
  // contain non-ASCII bytes; a real cookie value is printable ASCII. If the first 32
  // bytes look like binary AND the bytes after them are printable, we have the prefix.
  // latin1 gives a 1:1 byte→char mapping so the regex sees all 32 bytes without
  // multi-byte folding — see the function-level comment above for why this matters.
  if (!/^[ -~]{32}/.test(buf.subarray(0, 32).toString('latin1'))
      && isPrintable(buf.subarray(32).toString('utf8'))) {
    return buf.subarray(32)
  }
  return buf
}

// AES-128-CBC decrypt; returns null on any error (bad padding, wrong key, etc.).
// The 16-byte alignment guard also naturally rejects GCM-format blobs
// ([v10 3B][IV 12B][ct][tag 16B]) — their ciphertext+tag length is never block-aligned.
function tryCBC(key, iv, ct) {
  if (ct.length === 0 || ct.length % 16 !== 0) return null
  try {
    const d = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([d.update(ct), d.final()])
  } catch {
    return null
  }
}

function decryptBlob(encryptedValue, browserName, profileDir = null) {
  const buf    = toBuffer(encryptedValue)
  const prefix = chromiumPrefix(buf)
  if (!prefix) return null

  if (prefix.equals(PREFIX_V20)) {
    // Chrome/Edge 127+ app-bound encryption — the AES key is held by the
    // elevation service (IElevator COM) which rejects calls from non-browser
    // processes on Chrome/Edge 130+. Skip and report after all cookies run.
    v20CountFor.set(browserName, (v20CountFor.get(browserName) ?? 0) + 1)
    return null
  }

  if (process.platform === 'win32' && prefix.equals(PREFIX_V10)) {
    //
    // Path 1: AES-256-GCM with key from Local State (Chrome 80+ / Opera normal mode)
    // blob: [v10 3B][IV 12B][ciphertext][GCM tag 16B]
    //
    // Newer Chromium builds also prepend a 32-byte SHA256(host_key) domain-binding
    // prefix to the plaintext before encrypting — strip it the same way Linux does.
    //
    if (profileDir) {
      const aesKey = getChromiumWindowsKey(profileDir)
      if (aesKey) {
        const ct  = buf.subarray(PREFIX_LEN)
        const iv  = ct.subarray(0, 12)
        const tag = ct.subarray(ct.length - 16)
        const enc = ct.subarray(12, ct.length - 16)
        try {
          const d = createDecipheriv('aes-256-gcm', aesKey, iv)
          d.setAuthTag(tag)
          const plain = Buffer.concat([d.update(enc), d.final()])
          return stripPrefixBuffer(plain).toString('utf8')
        } catch {
          gcmFailedFor.add(browserName)
        }
      }
    }

    //
    // Path 2: AES-128-CBC peanuts (Chromium basic-mode fallback — same scheme as Linux
    // when no secret service is available). Opera Developer uses this on Windows when
    // DPAPI key storage fails (os_crypt.portal.prev_init_success = false in Local State).
    //
    // The GCM blob layout ([v10][IV 12B][ct][tag 16B]) is not 16-byte aligned so tryCBC
    // rejects it immediately; peanuts only fires for actual CBC-format blobs.
    //
    const peanutsKey = pbkdf2Sync(Buffer.from(PEANUTS_PASSWORD), SALT, ITERATIONS_BASIC, KEY_LEN, 'sha1')
    const ct = buf.subarray(PREFIX_LEN)
    const peanutsBuf = tryCBC(peanutsKey, STANDARD_IV, ct)
    if (peanutsBuf) {
      const stripped = stripPrefixBuffer(peanutsBuf)
      const v = stripped.toString('utf8')
      if (isPrintable(v)) return v
    }

    //
    // Path 3: direct DPAPI (very old Chrome pre-80 blobs)
    //
    try { return decryptDPAPIRaw(buf.subarray(PREFIX_LEN)).toString('utf8') } catch { return null }
  }

  // macOS / Linux / BSD: AES-128-CBC, PBKDF2-derived key
  const { key, isBasic } = getDerivedKey(browserName)

  const ct = buf.subarray(PREFIX_LEN)  // everything after "v10"/"v11"

  //
  // Path 1: standard (fixed 16-space IV, full ciphertext)
  //
  const standardBuf = tryCBC(key, STANDARD_IV, ct)
  if (standardBuf !== null) {
    const stripped = isBasic ? stripPrefixBuffer(standardBuf) : standardBuf
    const v = stripped.toString('utf8')
    if (isPrintable(v)) return v
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
    const nonceBuf = tryCBC(key, nonceIV, valueCT)
    if (nonceBuf !== null) {
      const stripped = isBasic ? stripPrefixBuffer(nonceBuf) : nonceBuf
      const v = stripped.toString('utf8')
      if (isPrintable(v)) return v
    }
  }

  // Return stripped standard result even if not printable — caller handles bad values
  if (standardBuf !== null) {
    const stripped = isBasic ? stripPrefixBuffer(standardBuf) : standardBuf
    return stripped.toString('utf8')
  }

  return null
}

//
// Public API
//

// Pass only the encrypted cookies to this function.
// profileDir is required on Windows to locate the Local State file for key extraction.
export function decryptCookies(cookies, browserName, profileDir = null) {
  const source = { darwin: 'macOS Keychain', linux: 'secret service', win32: 'DPAPI' }

  // macOS shows the Keychain prompt up to twice: once per keychain entry that Chrome
  // has created (login keychain + local items keychain). Both prompts are for the same
  // key. Click Allow or Always Allow on each — Always Allow skips future prompts.
  console.log(`  🔐 Querying ${source[process.platform] ?? process.platform} for ${browserName} decryption key${process.platform === 'darwin' ? dim(' — if you get 2 password prompts it is normal') : ''}`)

  let decrypted = 0, failed = 0, fatalError = null

  for (const cookie of cookies) {
    try {
      const plaintext = decryptBlob(cookie.encryptedValue, browserName, profileDir)
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
    const v20 = v20CountFor.get(browserName) ?? 0
    const failOther = failed - v20
    const parts = []
    if (decrypted > 0)  parts.push(`${decrypted} decrypted`)
    if (v20 > 0)        parts.push(`${v20} v20`)
    if (failOther > 0)  parts.push(`${failOther} failed`)
    console.log(`  ✔  ${parts.join(', ')}`)

    if (v20 > 0 && decrypted === 0) {
      console.warn(`  ⚠  All cookies use v20 app-bound encryption (Chrome/Edge 130+ blocks offline decryption)`)
      console.warn(`     → Use Firefox instead:  bun ./bin/yt -b firefox`)
    } else if (v20 > 0) {
      console.warn(`  ⚠  ${v20} v20 cookies could not be decrypted — some session data may be missing`)
    } else if (failed > 0 && decrypted === 0 && process.platform === 'win32') {
      if (gcmFailedFor.has(browserName)) {
        console.warn(`  ⚠  AES-GCM auth failed — the Local State key may be wrong or cookie blobs use a different layout`)
        console.warn(`     Run with --debug for more detail`)
      } else {
        console.warn(`  ⚠  All cookies failed to decrypt`)
        console.warn(`     Check that ${browserName}'s "Local State" is readable and the profile path is correct`)
      }
    }
  }
}
