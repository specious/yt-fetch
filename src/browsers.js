//
// Extendable table of how to find, identify and process different browsers' session databases
//
// Column name reference:
//   Firefox (moz_cookies):  host, isSecure, isHttpOnly, expiry, sameSite
//   Chrome/Chromium:        host_key, is_secure, is_httponly, expires_utc, samesite
//   (Edge, Opera, Brave all use the Chromium schema)
//
// `sizeMin` is the mininimum size in KB that is considered a possibly viable session store
//

export const BROWSERS = {
  firefox: {
    name: 'Firefox',
    dbName: 'cookies.sqlite',
    fileType: 'cookie-database',
    alwaysCopy: true,
    table: 'moz_cookies',
    cols: {
      host:     'host',
      secure:   'isSecure',
      httpOnly: 'isHttpOnly',
      expiry:   'expiry',
      sameSite: 'sameSite',
    },
    hostMatch: '.youtube.com',
    sizeMin: 512,
    profiles: {
      darwin: [
        '~/Library/Application Support/Firefox/Profiles/*/'
      ],
      win32: ['%APPDATA%/Mozilla/Firefox/Profiles/*/', '%LOCALAPPDATA%/Firefox*/Profiles/*/'],
      linux: ['~/.mozilla/firefox/*/', '~/.var/app/org.mozilla.firefox/*'],
    },
  },
  chrome: {
    name: 'Chrome',
    dbName: 'Cookies',
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: {
      host:     'host_key',
      secure:   'is_secure',
      httpOnly: 'is_httponly',
      expiry:   'expires_utc',
      sameSite: 'samesite',
      encrypted: 'encrypted_value',
    },
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      darwin: ['~/Library/Application Support/Google/{Chrome,Chrome Beta,Chrome Dev,Chromium}/*/'],
      win32: ['%LOCALAPPDATA%/Google/{Chrome,Chrome Beta,Chrome Dev,Chromium}/User Data/*'],
      linux: ['~/.config/google-chrome*/*', '~/.config/chromium/*'],
    },
  },
  opera: {
    name: 'Opera',
    dbName: 'Cookies',
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: {
      host:     'host_key',
      secure:   'is_secure',
      httpOnly: 'is_httponly',
      expiry:   'expires_utc',
      sameSite: 'samesite',
      encrypted: 'encrypted_value',
    },
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
      linux: ['~/.config/opera/*/', '~/.config/opera-developer/*/'],
    },
  },
  edge: {
    name: 'Edge',
    dbName: 'Cookies',
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: {
      host:     'host_key',
      secure:   'is_secure',
      httpOnly: 'is_httponly',
      expiry:   'expires_utc',
      sameSite: 'samesite',
      encrypted: 'encrypted_value',
    },
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      darwin: ['~/Library/Application Support/Microsoft Edge/*/'],
      win32: ['%LOCALAPPDATA%/Microsoft/Edge/User Data/*'],
      linux: ['~/.config/microsoft-edge/*'],
    },
  },
  brave: {
    name: 'Brave',
    dbName: 'Cookies',
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    cols: {
      host:     'host_key',
      secure:   'is_secure',
      httpOnly: 'is_httponly',
      expiry:   'expires_utc',
      sameSite: 'samesite',
      encrypted: 'encrypted_value',
    },
    hostMatch: '%youtube.com',
    sizeMin: 32,
    profiles: {
      darwin: ['~/Library/Application Support/BraveSoftware/Brave-Browser/*/'],
      win32: ['%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data/*'],
      linux: ['~/.config/BraveSoftware/Brave-Browser/*'],
    },
  },
  //
  // Safari stores cookies in Apple's proprietary BinaryCookies format, not SQLite.
  //
  // File locations (macOS):
  //   System-wide / older Safari:
  //     ~/Library/Cookies/Cookies.binarycookies
  //   Sandboxed Safari (App Store):
  //     ~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies
  //
  // The format is well-documented and straightforward to parse in pure JS:
  //   - File header: magic "cook", page count (BE uint32), page size table
  //   - Each page: page header, cookie records
  //   - Each cookie record: fixed-size header + variable-length strings
  //     (url, name, path, value) packed end-to-end
  //   - Timestamps: Mac Absolute Time (seconds since Jan 1 2001)
  //   - Values are plaintext — no encryption on macOS
  //
  // WebKit Nightly stores its cookies in the same BinaryCookies format at:
  //   ~/Library/Cookies/com.apple.WebKit.Networking.binarycookies
  //   (or within a per-app container for sandboxed WebKit embeddings)
  // WebKit Nightly is essentially Safari technology, same format, same parser.
  //
  // Reference: https://github.com/MKS2508/binary-cookies-parser (TypeScript, zero deps)
  //            https://github.com/cixtor/binarycookies (Go, full spec)
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
        '~/Library/Cookies/',                                          // system-wide / older
      ],
      win32: [],
      linux: [],
    },
  },

  //
  // TODO: Vivaldi, Pale Moon, Waterfox, WebKit Nightly
  //
}

// Chrome/Chromium timestamps are microseconds since Jan 1, 1601 (Windows FILETIME epoch).
// Convert to Unix seconds so Puppeteer and cookie consumers get sensible expiry values.
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

  // Collect browser specifics
  const { host, secure, httpOnly, expiry, sameSite, encrypted } = config.cols
  const operator = config.hostMatch.includes('%') ? 'LIKE' : '='

  // Also read the encrypted column for browsers that use it
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
