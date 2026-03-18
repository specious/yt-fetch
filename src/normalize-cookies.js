export function normalizeCookies(rawCookies, targetDomains = ['.youtube.com', '.accounts.youtube.com']) {
  console.log(`🔄 Normalizing ${rawCookies.length} raw cookies...`)

  function getSameSite(value) {
    const num = Number(value)
    if (num === 256 || num === 0) return 'None' // Firefox/Chrome
    if (num === 1) return 'Strict'
    if (num === 2) return 'Lax'
    return 'Lax' // Default
  }

  const normalized = rawCookies
    // Filter valid cookies
    .filter(c => c.name && String(c.value || '').trim())

    // Normalize cookie fields from different browsers
    .map(c => ({
      name: String(c.name).trim(),
      value: String(c.value).trim(),
      // Domain: Firefox=host, Chrome=host_key, generic=domain/baseDomain
      domain: String(c.host || c.host_key || c.domain || c.baseDomain || '.youtube.com').trim(),
      path: String(c.path || '/').trim(),
      secure: Boolean(c.isSecure || c.secure || c.is_secure),
      httpOnly: Boolean(c.isHttpOnly || c.httpOnly || c.is_httponly),
      sameSite: getSameSite(c.sameSite || c.samesite),
      expires: Number(c.expiry || c.expires || -1)
    }))

    // Final validation
    .filter(c => c.name && c.value && c.domain)

  // Filter by target domains (YouTube ecosystem)
  const filtered = normalized.filter(c =>
    targetDomains.some(domain =>
      c.domain.includes(domain.replace('.', '')) ||
      c.domain === domain
    )
  )

  console.log(`✅ ${filtered.length}/${rawCookies.length} cookies normalized`)

  return filtered
}
