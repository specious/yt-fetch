//
// Zero-dependency ANSI styling primitives
//
// Usage:
//   import { c, dim, bold, strip } from './ansi.js'
//   console.log(c.green('hello') + dim(' world'))
//

const ESC = '\x1b['

// Detect whether the output stream supports color.
// Respects NO_COLOR (https://no-color.org/) and non-TTY pipes.
export const hasColor = (
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.isTTY ?? false)
)

function esc(...codes) {
  if (!hasColor) return ''
  return `${ESC}${codes.join(';')}m`
}

const RESET = esc(0)

function wrap(open, close) {
  return str => hasColor ? `${open}${str}${close}` : String(str)
}

// Text styles
// Closing codes: 22=normal intensity (resets bold+dim without clobbering colour),
// 23=italic off, 24=underline off. reset(0) would clear colour too, breaking
// nested constructs like dim(bold('text')) inside a colour wrapper.
export const bold   = wrap(esc(1),  esc(22))
export const dim    = wrap(esc(2),  esc(22))
export const italic = wrap(esc(3),  esc(23))
export const under  = wrap(esc(4),  esc(24))

// Foreground colors
export const c = {
  black:    wrap(esc(30), RESET),
  red:      wrap(esc(31), RESET),
  green:    wrap(esc(32), RESET),
  yellow:   wrap(esc(33), RESET),
  blue:     wrap(esc(34), RESET),
  magenta:  wrap(esc(35), RESET),
  cyan:     wrap(esc(36), RESET),
  white:    wrap(esc(37), RESET),
  // Bright variants
  bred:     wrap(esc(91), RESET),
  bgreen:   wrap(esc(92), RESET),
  byellow:  wrap(esc(93), RESET),
  bblue:    wrap(esc(94), RESET),
  bmagenta: wrap(esc(95), RESET),
  bcyan:    wrap(esc(96), RESET),
  bwhite:   wrap(esc(97), RESET),
  // 256-color: c.ansi256(n)(str)
  ansi256:  n => wrap(esc(38, 5, n), RESET),
}

// Background colors
export const bg = {
  red:     wrap(esc(41), RESET),
  green:   wrap(esc(42), RESET),
  yellow:  wrap(esc(43), RESET),
  blue:    wrap(esc(44), RESET),
  magenta: wrap(esc(45), RESET),
  cyan:    wrap(esc(46), RESET),
  white:   wrap(esc(47), RESET),
}

// Strip all ANSI codes from a string (for measuring visible length)
export function strip(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/\x1b\[[0-9;]*m/g, '')
}

// Pad a possibly-ANSI-colored string to a visible width
export function pad(str, width, char = ' ') {
  const visible = strip(str).length
  return str + char.repeat(Math.max(0, width - visible))
}
