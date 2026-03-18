//
// Extendable table of how to find, identify and process different browsers' session databases
//
export const BROWSERS = {
  firefox: {
    name: 'Firefox',
    dbName: 'cookies.sqlite',
    fileType: 'cookie-database',
    alwaysCopy: true,
    table: 'moz_cookies',
    hostField: 'host',
    hostMatch: '.youtube.com',
    sizeMin: '512KB',
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
    hostField: 'host_key',
    hostMatch: '%youtube.com',
    sizeMin: '1MB',
    profiles: {
      darwin: ['~/Library/Application Support/Google/{Chrome*,Chromium*}/*/'],
      win32: ['%LOCALAPPDATA%/Google/{Chrome*,Chromium*}/User Data/*'],
      linux: ['~/.config/google-{chrome*,chromium}/*'],
    },
  },
  opera: {
    name: 'Opera',
    dbName: 'Cookies',
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    hostField: 'host_key',
    hostMatch: '%youtube.com',
    sizeMin: '1MB',
    profiles: {
      darwin: ['~/Library/Application Support/{Opera*,Opera*}/*'],
      win32: ['%APPDATA%/Opera*/'],
      linux: ['~/.config/opera*/'],
    },
  },
  edge: {
    name: 'Edge',
    dbName: 'Cookies',
    fileType: 'cookie-database',
    alwaysCopy: false,
    table: 'cookies',
    hostField: 'host_key',
    hostMatch: '%youtube.com',
    sizeMin: 1024,
    profiles: {
      darwin: ['~/Library/Application Support/Microsoft Edge/*'],
      win32: ['%LOCALAPPDATA%/Microsoft/Edge/User Data/*'],
      linux: ['~/.config/microsoft-edge/*'],
    },
  },
  // Safari/WebKit - BinaryCookies (not SQLite)
  safari: {
    name: 'Safari',
    dbName: 'Cookies.binarycookies',
    fileType: 'binary-cookies',
    alwaysCopy: false,
    table: null, // Requires binary parsing
    hostField: null,
    hostMatch: null,
    sizeMin: 256,
    profiles: {
      darwin: ['~/Library/Cookies/'],
      win32: [], // N/A
      linux: [], // N/A
    },
    note: 'needs custom binary cookie parser (not yet implemented)',
  },
  // Add more: Brave, Vivaldi, Pale Moon, Waterfox...
}

export function getQuery(config) {
  if (!config.table) {
    throw new Error(`${config.name}: Not yet supported`)
  }

  const operator = config.hostMatch.includes('%') ? 'LIKE' : '='

  return `SELECT
            name,
            value,
            host AS domain,
            path,
            isSecure AS secure,
            isHttpOnly AS httpOnly,
            expiry,
            sameSite
          FROM ${config.table}
          WHERE ${config.hostField} ${operator} '${config.hostMatch}'`
}
