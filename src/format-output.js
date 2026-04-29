import { c, dim, bold } from './ansi.js'

//
// Output formatters for the video list.
//
// Formats:    pretty (default) | json | yaml
// URL styles: short (youtu.be, default) | canonical (youtube.com/watch?v= or /shorts/)
// Sort:       asc (default, preserves YouTube's order) | desc (reverses it)
//
// Fields available per video (confirmed via DOM diagnostic):
//   title    — always present
//   channel  — always present; for licensed films this is "Genre • Year" not a channel
//   duration — present for regular videos and films; absent for Shorts
//   views    — present for Shorts; absent for regular videos on the history page
//   isShort  — true when URL is /shorts/ID
//   url      — youtu.be/ID or youtube.com/shorts/ID or canonical form
//
// Not available:
//   uploadedAgo — YouTube does not appear to render upload date on the history feed
//   watchedAt   — only available via Google Takeout, never in the page HTML
//

export function formatVideo(video, urlStyle = 'short') {
  const out = {
    videoId: video.videoId,
    title:   video.title,
  }
  if (video.channel)  out.channel  = video.channel
  if (video.duration) out.duration = video.duration
  if (video.views)    out.views    = video.views
  if (video.isShort)  out.isShort  = true

  if (urlStyle === 'canonical') {
    out.url = video.isShort
      ? `https://www.youtube.com/shorts/${video.videoId}`
      : `https://www.youtube.com/watch?v=${video.videoId}`
  } else {
    out.url = video.isShort
      ? `https://www.youtube.com/shorts/${video.videoId}`
      : `https://youtu.be/${video.videoId}`
  }
  return out
}

//
// Sort helpers
//

function sortVideos(videos, sort) {
  // YouTube serves history in reverse-chronological watch order (newest first).
  // --sort=asc (default): preserve that order — most recently watched at top
  // --sort=desc:          reverse it — oldest watch at top, most recent at bottom
  if (sort === 'desc') return [...videos].reverse()
  return [...videos]
}

//
// Pretty terminal output
//

function prettyEntry(video, urlStyle) {
  const formatted = formatVideo(video, urlStyle)

  // Detect licensed content: channel slot contains "Genre • Year" (e.g. "Documentary • 2025")
  const isLicensed = video.channel && /\S.*•.*\d{4}/.test(video.channel)

  // Line 1: title
  // For regular videos, duration in parens on this line.
  // For films, duration goes on line 2 after the genre/year — see below.
  const durOnTitle = !isLicensed && video.duration
    ? ` ${dim('(')}${c.ansi256(243)(video.duration)}${dim(')')}`
    : ''
  const line1 = `  ${bold(video.title)}${durOnTitle}`

  // Line 2: channel/label  [· duration for films]  [· views for Shorts]
  const metaParts = []
  if (video.channel) {
    metaParts.push(c.ansi256(75)(video.channel))
  }
  if (isLicensed && video.duration) {
    // Duration appended to the genre/year line for films
    metaParts.push(dim(video.duration))
  }
  if (video.views) {
    metaParts.push(dim(video.views))
  }
  const meta = metaParts.join(dim(' · '))

  // Line 3: URL
  const link = c.ansi256(87)(formatted.url)

  const lines = [line1]
  if (meta) lines.push(`  ${meta}`)
  lines.push(`  ${link}`)

  return lines.join('\n')
}

export function printPretty(videos, { urlStyle = 'short', sort = 'asc' } = {}) {
  const sorted = sortVideos(videos, sort)
  const n      = sorted.length
  const noun   = n === 1 ? 'video' : 'videos'

  console.log()
  console.log(dim('─'.repeat(60)))
  console.log(`  ${c.byellow('▶')} ${bold(String(n))} ${noun} in watch history`)
  console.log(dim('─'.repeat(60)))
  console.log()

  for (let i = 0; i < sorted.length; i++) {
    console.log(prettyEntry(sorted[i], urlStyle))
    if (i < sorted.length - 1) console.log()
  }
}

//
// JSON output
//

export function printJSON(videos, { urlStyle = 'short', sort = 'asc', quiet = false } = {}) {
  const sorted = sortVideos(videos, sort)
  if (!quiet) {
    console.log()
    console.log('Results:')
    console.log()
  }
  console.log(JSON.stringify(sorted.map(v => formatVideo(v, urlStyle)), null, 2))
}

//
// YAML output — hand-rolled, no deps
//

// Quote a YAML scalar value with single quotes when necessary.
// Triggers: YAML flow-indicator/special chars, leading/trailing whitespace,
// or strings that a YAML parser would misread as a boolean, null, or number.
// Single-quote style is safe for all content — internal quotes are doubled ('').
function yamlStr(s) {
  if (!s) return "''"
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(s) || /^\s|\s$/.test(s) ||
      /^(true|false|null|yes|no|on|off|\d.*)$/i.test(s)) {
    return `'${s.replace(/'/g, "''")}'`
  }
  return s
}

export function printYAML(videos, { urlStyle = 'short', sort = 'asc', quiet = false } = {}) {
  const sorted = sortVideos(videos, sort)
  if (!quiet) {
    console.log()
    console.log('Results:')
    console.log()
  }
  for (const video of sorted) {
    const v = formatVideo(video, urlStyle)
    console.log(`- videoId:  ${yamlStr(v.videoId)}`)
    console.log(`  title:    ${yamlStr(v.title)}`)
    if (v.channel)  console.log(`  channel:  ${yamlStr(v.channel)}`)
    if (v.duration) console.log(`  duration: ${yamlStr(v.duration)}`)
    if (v.views)    console.log(`  views:    ${yamlStr(v.views)}`)
    if (v.isShort)  console.log(`  isShort:  true`)
    console.log(`  url:      ${yamlStr(v.url)}`)
  }
}

//
// Render
//

export function printVideos(videos, { output = 'pretty', urlStyle = 'short', sort = 'asc', quiet = false } = {}) {
  switch (output) {
    case 'json':  return printJSON(videos,   { urlStyle, sort, quiet })
    case 'yaml':  return printYAML(videos,   { urlStyle, sort, quiet })
    default:      return printPretty(videos, { urlStyle, sort })
  }
}
