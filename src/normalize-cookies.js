import { chromeTimestampToUnix } from './browsers.js'

// Chrome stores expiry as microseconds since the Windows epoch (Jan 1 1601).
// Values above this threshold cannot be Unix timestamps — convert them.
const CHROME_TIMESTAMP_THRESHOLD = 10_000_000_000_000

// YouTube's cookie header has a ~4KB limit per request. Firefox sessions
// accumulate many ST-* sub-tokens (one per logged-in account context) that
// collectively blow past this limit and cause HTTP 413 errors. These tokens
// aren't needed for authenticated history access — strip them.
//
// ST-* cookies are YouTube-internal session shards, distinct from the core
// auth cookies (SID, SAPISID, HSID etc.) that actually gate login state.
const SKIP_PATTERN = /^ST-[a-z0-9]+$/i

function normalizeExpiry(raw) {
  const n = Number(raw ?? -1)

  if (n <= 0)
    return undefined

  if (n > CHROME_TIMESTAMP_THRESHOLD)
    return chromeTimestampToUnix(n)

  // Already Unix seconds
  return n
}

// sameSite integer mappings differ between Firefox and Chromium.
//
// Chromium:  -1/unset → omit,  0 → omit (permissive, not "None"),  1 → Strict,  2 → Lax,  3 → None
// Firefox:         0  → omit,  1 → Lax,  2 → Strict,  256 (0x100) → None
//
// Ambiguity: Chromium 2 = Lax, Firefox 2 = Strict. Since getQuery() normalises
// both to the same `sameSite` field without a browser-family tag, we use the
// Chromium mapping for 1 and 2. In practice YouTube cookies rarely carry sameSite=2
// from Firefox, so this edge case doesn't cause real problems.
//
// Puppeteer rejects 'None' on non-Secure cookies (CDP error), so we always
// check `isSecure` before emitting 'None'.
function normalizeSameSite(raw, isSecure) {
  const n = Number(raw ?? -1)
  if (n === 256) return isSecure ? 'None' : undefined
  if (n === 3)   return isSecure ? 'None' : undefined
  if (n === 2)   return 'Lax'
  if (n === 1)   return 'Strict'
  return undefined
}

//
// Returns { cookies, skippedCount } rather than a plain array so the caller
// can surface the ST-* skip count in its own output context.
//
export function normalizeCookies(rawCookies, targetDomains = ['.youtube.com', '.accounts.youtube.com']) {
  const skipped    = rawCookies.filter(c => SKIP_PATTERN.test(c.name ?? ''))
  const candidates = rawCookies.filter(c => !SKIP_PATTERN.test(c.name ?? ''))

  const normalized = candidates
    .filter(c => c.name && String(c.value ?? '').trim())
    .map(c => {
      const secure   = Boolean(c.secure ?? c.isSecure ?? c.is_secure)
      const sameSite = normalizeSameSite(c.sameSite ?? c.samesite, secure)
      const expires  = normalizeExpiry(c.expiry ?? c.expires ?? c.expires_utc)

      const cookie = {
        name:     String(c.name).trim(),
        value:    String(c.value).trim(),
        domain:   String(c.domain ?? c.host ?? c.host_key ?? c.baseDomain ?? '.youtube.com').trim(),
        path:     String(c.path ?? '/').trim(),
        secure,
        httpOnly: Boolean(c.httpOnly ?? c.isHttpOnly ?? c.is_httponly),
      }

      if (sameSite !== undefined) cookie.sameSite = sameSite
      if (expires  !== undefined) cookie.expires  = expires

      return cookie
    })
    .filter(c => c.name && c.value && c.domain)

  const filtered = normalized.filter(c =>
    targetDomains.some(target =>
      c.domain === target ||
      c.domain.endsWith(target) ||
      target.endsWith(c.domain)
    )
  )

  return { cookies: filtered, skippedCount: skipped.length }
}
