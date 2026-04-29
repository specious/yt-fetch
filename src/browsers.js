//
// Extendable table of how to find, identify and query different browsers'
// session cookie databases.
//
// Key per-browser fields:
//   sizeMin    minimum expected DB size in KB for a signed-in session; rejects
//              empty or stub profiles before attempting decryption
//   hostMatch  SQL pattern used to filter YouTube cookies:
//                leading '.'  → exact '=' match  (Firefox stores host as '.youtube.com')
//                leading '%'  → LIKE wildcard     (Chromium may store 'youtube.com' or '.youtube.com')
//   alwaysCopy true for Firefox: it holds an exclusive WAL write lock while running,
//              so we always snapshot the database before querying
//
// Column name reference:
//   Firefox (moz_cookies):  host, isSecure, isHttpOnly, expiry, sameSite
//   Chrome/Chromium:        host_key, is_secure, is_httponly, expires_utc, samesite
//   (Edge, Opera, Brave all use the Chromium schema)
//

//
// Shared column mapping for all Chromium-family browsers.
// Extracted here so adding a new Chromium-based browser is a 5-line entry below.
//
const CHROMIUM_COLS = {
  host:      'host_key',
  secure:    'is_secure',
  httpOnly:  'is_httponly',
  expiry:    'expires_utc',
  sameSite:  'samesite',
  encrypted: 'encrypted_value',  // absent on Firefox — its cookies are stored as plaintext
}

// Chromium 96+ (Nov 2021) moved the cookie file into a Network/ subdirectory.
// dbName is tried first; dbFallback is used for older installs where the file
// still lives directly in the profile root.
const CHROMIUM_DB = 'Network/Cookies'
const CHROMIUM_DB_LEGACY = 'Cookies'

//
// Shared profile path patterns for Linux and BSDs.
// Listed separately so BSD platform keys can be added without
// duplicating every path string.
//
function unixPaths(paths) {
  return { linux: paths, freebsd: paths, openbsd: paths, netbsd: paths }
}

export const BROWSERS = {
  firefox: {
    name: 'Firefox',
    dbName: 'cookies.sqlite',
    fileType: 'cookie-database',
    alwaysCopy: true,
    table: 'moz_cookies',
    cols: {
      host: 'host',
      secure: 'isSecure',
      httpOnly: 'isHttpOnly',
      expiry: 'expiry',
      sameSite: 'sameSite',
    },
    hostMatch: '.youtube.com',
    sizeMin: 512,
    profiles: {
      darwin: ['~/Library/Application Support/Firefox/Profiles/*/'],
      win32:  ['%APPDATA%/Mozilla/Firefox/Profiles/*/', '%LOCALAPPDATA%/Firefox*/Profiles/*/'],
      ...unixPaths(['~/.mozilla/firefox/*/', '~/.var/app/org.mozilla.firefox/*']),
    },
  },

  chrome: {
    name: 'Chrome',
    dbName: CHROMIUM_DB, dbFallback: CHROMIUM_DB_LEGACY,
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: CHROMIUM_COLS,
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      darwin: ['~/Library/Application Support/Google/{Chrome,Chrome Beta,Chrome Dev,Chromium}/*/'],
      win32:  ['%LOCALAPPDATA%/Google/{Chrome,Chrome Beta,Chrome Dev,Chromium}/User Data/*/'],
      ...unixPaths(['~/.config/google-chrome*/*', '~/.config/chromium/*']),
    },
  },

  opera: {
    name: 'Opera',
    dbName: CHROMIUM_DB, dbFallback: CHROMIUM_DB_LEGACY,
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: CHROMIUM_COLS,
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      // macOS: Opera uses reverse-domain bundle IDs as the folder name
      darwin: [
        '~/Library/Application Support/com.operasoftware.Opera/*/',
        '~/Library/Application Support/com.operasoftware.OperaDeveloper/*/',
        '~/Library/Application Support/com.operasoftware.OperaNext/*/',
        '~/Library/Application Support/com.operasoftware.OperaGX*/*/',
      ],
      win32: ['%APPDATA%/Opera Software/Opera Stable/*/', '%APPDATA%/Opera Software/Opera Developer/*/'],
      ...unixPaths(['~/.config/opera/*/', '~/.config/opera-developer/*/']),
    },
  },

  edge: {
    name: 'Edge',
    dbName: CHROMIUM_DB, dbFallback: CHROMIUM_DB_LEGACY,
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: CHROMIUM_COLS,
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      darwin: ['~/Library/Application Support/Microsoft Edge/*/'],
      win32:  ['%LOCALAPPDATA%/Microsoft/Edge/User Data/*/'],
      ...unixPaths(['~/.config/microsoft-edge/*']),
    },
  },

  brave: {
    name: 'Brave',
    dbName: CHROMIUM_DB, dbFallback: CHROMIUM_DB_LEGACY,
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: CHROMIUM_COLS,
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      darwin: ['~/Library/Application Support/BraveSoftware/Brave-Browser/*/'],
      win32:  ['%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data/*/'],
      ...unixPaths(['~/.config/BraveSoftware/Brave-Browser/*']),
    },
  },

  //
  // Safari stores cookies in Apple's proprietary BinaryCookies format, not SQLite.
  //
  // File locations (macOS):
  //   Sandboxed Safari (App Store):
  //     ~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies
  //   System-wide / older Safari:
  //     ~/Library/Cookies/Cookies.binarycookies
  //
  // The format is well-documented and parseable in pure JS:
  //   - File header: magic "cook", page count (BE uint32), page size table
  //   - Each page: page header, cookie records
  //   - Each cookie: fixed-size header + variable-length strings (url, name, path, value)
  //   - Timestamps: Mac Absolute Time (seconds since Jan 1 2001)
  //   - Values are plaintext — no encryption on macOS
  //
  // WebKit Nightly uses the same format:
  //   ~/Library/Cookies/com.apple.WebKit.Networking.binarycookies
  //
  // References:
  //   https://github.com/MKS2508/binary-cookies-parser  (TypeScript, zero deps)
  //   https://github.com/cixtor/binarycookies           (Go, full spec)
  //
  safari: {
    name: 'Safari',
    dbName: 'Cookies.binarycookies',
    fileType: 'binary-cookies',
    alwaysCopy: false,
    table: null, // BinaryCookies format — not SQLite, needs dedicated parser
    cols: null,
    hostMatch: null,
    sizeMin: 256,
    profiles: {
      darwin: [
        '~/Library/Containers/com.apple.Safari/Data/Library/Cookies/', // sandboxed (default)
        '~/Library/Cookies/', // system-wide / older
      ],
      win32: [],
      linux: [],
    },
  },

  //
  // TODO: Vivaldi, Pale Moon, Waterfox, WebKit Nightly
  //
}

//
// Chrome/Chromium timestamps are microseconds since Jan 1, 1601 (Windows FILETIME epoch).
// Convert to Unix seconds for Puppeteer and other consumers.
//
const CHROME_EPOCH_OFFSET_S = 11644473600

// Chrome epoch → Unix seconds
export function chromeTimestampToUnix(microseconds) {
  if (!microseconds || microseconds <= 0)
    return -1

  return Math.floor(microseconds / 1_000_000) - CHROME_EPOCH_OFFSET_S
}

export function getQuery(config) {
  if (!config.table || !config.cols) {
    throw new Error(`${config.name}: Not yet supported`)
  }

  const { host, secure, httpOnly, expiry, sameSite, encrypted } = config.cols
  // A '%' in hostMatch signals a LIKE wildcard (Chromium); absence of '%' uses exact '='  (Firefox)
  const operator = config.hostMatch.includes('%') ? 'LIKE' : '='

  // Firefox has no encrypted_value column — its cookies are plaintext; omit for non-Chromium browsers
  const andEncryptedValue = encrypted ? `, ${encrypted} AS encryptedValue` : ''

  return [
    'SELECT',
    `  name,`,
    `  value${andEncryptedValue},`,
    `  ${host}     AS domain,`,
    `  path,`,
    `  ${secure}   AS secure,`,
    `  ${httpOnly} AS httpOnly,`,
    `  ${expiry}   AS expiry,`,
    `  ${sameSite} AS sameSite`,
    `FROM ${config.table}`,
    `WHERE ${host} ${operator} '${config.hostMatch}'`,
  ].join('\n')
}
