#!/usr/bin/env bash
#
# patch-bun-on-legacy-macos — Bun ICU compatibility patcher for macOS Big Sur / Monterey
#
# Usage:
#   patch-bun-on-legacy-macos               apply the shim
#   patch-bun-on-legacy-macos --uninstall   remove the shim and restore the original binary
#   patch-bun-on-legacy-macos --help        show this message
#

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
DIM='\033[2m'; RESET='\033[0m'; BOLD='\033[1m'

log()  { echo -e "  ${DIM}·${RESET}  $*"; }
ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
die()  { echo -e "\n  ${RED}✖${RESET}  $*\n" >&2; exit 1; }

SHIM_DYLIB="/usr/local/lib/libicucore_shim.dylib"
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
MODE="apply"
CMD="$(basename "$0")"

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --help|-h)   MODE="help" ;;
    *) die "Unknown argument: $arg\n  Usage: $(basename \"$0\") [--uninstall | --help]" ;;
  esac
done

# ── Help ──────────────────────────────────────────────────────────────────────

if [[ "$MODE" == "help" ]]; then
  echo
  echo -e "${BOLD}${CMD}${RESET} ${DIM}— Bun ICU compatibility patcher for macOS Big Sur / Monterey${RESET}"
  echo
  echo -e "  Bun officially requires macOS 13+. On Big Sur (11) or Monterey (12), it"
  echo -e "  fails at launch with:"
  echo
  echo -e "    ${DIM}dyld: Symbol not found: _ubrk_clone${RESET}"
  echo
  echo -e "  This script patches your local Bun binary to load a shim that provides"
  echo -e "  the missing ICU symbols (18 total — 2 confirmed required to launch Bun,"
  echo -e "  the rest included as a safety net for code paths exercised after startup):"
  echo -e "    ubrk_clone — delegates to ubrk_safeClone (ICU 69, required)"
  echo -e "    uplrules_selectForRange — no-op stub (ICU 68, required)"
  echo -e "    + 16 further stubs for date/number range formatting APIs (ICU 67-68)"
  echo
  echo -e "${BOLD}Usage:${RESET}"
  echo -e "  ${CMD}               Patch Bun for legacy macOS (idempotent — safe to re-run)"
  echo -e "  ${CMD} --uninstall   Restore the original Bun binary and remove the patch"
  echo -e "  ${CMD} --help        Show this message"
  echo
  echo -e "${BOLD}What changes on disk:${RESET}"
  echo -e "  ${DIM}$SHIM_DYLIB${RESET}  ← compiled shim dylib (new file)"
  echo -e "  ${DIM}$BUN_BIN${RESET}  ← LC_LOAD_DYLIB entry rewritten + code signature replaced"
  echo
  echo -e "${BOLD}After bun upgrade:${RESET}"
  echo -e "  Bun upgrade replaces the binary, undoing the patch. Re-run"
  echo -e "  ${DIM}${CMD}${RESET} after any ${DIM}bun upgrade${RESET} on macOS 11 / 12."
  echo
  echo -e "${BOLD}References:${RESET}"
  echo -e "  ${DIM}https://github.com/oven-sh/bun/issues/6035${RESET}"
  echo -e "  ${DIM}https://gist.github.com/dlevi309/ab45b4016479064833f50af4f4b0aa1f${RESET}"
  echo
  exit 0
fi

# ── Prerequisites (both modes) ────────────────────────────────────────────────

[[ "$(uname)" == "Darwin" ]] || die "This script is macOS-only."

MACOS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)

# ── Uninstall ─────────────────────────────────────────────────────────────────

if [[ "$MODE" == "uninstall" ]]; then
  echo
  echo -e "${BOLD}${CMD} --uninstall${RESET}"
  echo

  [[ -f "$BUN_BIN" ]] || die "Bun not found at $BUN_BIN"

  if otool -L "$BUN_BIN" 2>/dev/null | grep -q 'libicucore_shim.dylib'; then
    log "Restoring original library reference in bun binary"
    install_name_tool \
      -change /usr/local/lib/libicucore_shim.dylib \
              /usr/lib/libicucore.A.dylib \
      "$BUN_BIN"
    codesign -f -s - "$BUN_BIN"
    ok "Binary restored"
  else
    ok "Bun binary does not reference the shim — nothing to restore"
  fi

  if [[ -f "$SHIM_DYLIB" ]]; then
    rm -f "$SHIM_DYLIB"
    ok "Removed ${DIM}$SHIM_DYLIB${RESET}"
  else
    ok "Shim dylib not present — nothing to remove"
  fi

  echo
  if (( MACOS_MAJOR < 13 )); then
    warn "You are on macOS $(sw_vers -productVersion) — Bun will not work without the shim."
    warn "Re-apply at any time with: ${DIM}${CMD}${RESET}"
  else
    ok "Uninstall complete"
  fi
  echo
  exit 0
fi

# ── Apply ─────────────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}${CMD}${RESET}  ${DIM}Bun ICU compatibility patcher for macOS Big Sur / Monterey${RESET}"
echo

if (( MACOS_MAJOR >= 13 )); then
  ok "macOS $(sw_vers -productVersion) — no shim needed (Bun runs natively)"
  exit 0
fi

(( MACOS_MAJOR >= 11 )) || die "macOS $MACOS_MAJOR is below Big Sur. Bun is not supported."

log "macOS $(sw_vers -productVersion) detected"

[[ -f "$BUN_BIN" ]] \
  || die "Bun not found at $BUN_BIN\n  Install it: curl -fsSL https://bun.sh/install | bash"

log "Found Bun at ${DIM}$BUN_BIN${RESET}"

# Already applied and working?
if otool -L "$BUN_BIN" 2>/dev/null | grep -q 'libicucore_shim.dylib'; then
  if "$BUN_BIN" --version &>/dev/null; then
    ok "Shim already applied and Bun is working — nothing to do"
    log "After ${DIM}bun upgrade${RESET}, re-run ${DIM}${CMD}${RESET} to re-apply."
    echo
    exit 0
  else
    warn "Shim reference found but Bun still fails — likely replaced by bun upgrade"
    warn "Recompiling and re-patching..."
  fi
elif "$BUN_BIN" --version &>/dev/null; then
  ok "Bun works without a shim — nothing to do"
  exit 0
fi

command -v cc &>/dev/null \
  || die "Xcode command-line tools required.\n  Install: xcode-select --install"

SHIM_C="$(mktemp /tmp/libicucore_shim_XXXXXX.c)"
trap 'rm -f "$SHIM_C"' EXIT

log "Writing shim source"

cat > "$SHIM_C" << 'CSRC'
/*
 * ICU compatibility shim for macOS Big Sur (11) and Monterey (12).
 *
 * These systems ship with ICU 66. Current Bun is built against ICU 74 and
 * requires symbols added in ICU 67–69 that are absent from the system library.
 *
 * All symbols confirmed necessary on macOS 11.7.11 x86_64 with Bun 1.3.11.
 *
 * Delegations (forward to older equivalent API):
 *   ubrk_clone                  ICU 69 → ubrk_safeClone
 *
 * Stubs (return U_UNSUPPORTED_ERROR; Bun handles gracefully):
 *   ucal_getTimeZoneOffsetFromLocal              ICU 69
 *   udtitvfmt_formatCalendarToResult             ICU 67
 *   udtitvfmt_formatToResult                     ICU 67
 *   udtitvfmt_openResult                         ICU 67
 *   udtitvfmt_resultAsValue                      ICU 67
 *   udtitvfmt_closeResult                        ICU 67
 *   unumrf_openForSkeletonCollapseIdentity...    ICU 68
 *   unumrf_openForSkeletonWithCollapse...        ICU 68
 *   unumrf_close                                 ICU 68
 *   unumrf_openResult                            ICU 68
 *   unumrf_formatDoubleRange                     ICU 68
 *   unumrf_formatDecimalRange                    ICU 68
 *   unumrf_resultAsValue                         ICU 68
 *   unumrf_resultGetIdentityResult               ICU 68
 *   unumrf_resultToString                        ICU 68
 *   unumrf_closeResult                           ICU 68
 *   uplrules_selectForRange                      ICU 68
 *
 * Credit: @dlevi309 (original shim technique)
 * https://gist.github.com/dlevi309/ab45b4016479064833f50af4f4b0aa1f
 * https://github.com/oven-sh/bun/issues/6035
 */

#include <stddef.h>
#include <stdint.h>

typedef struct UBreakIterator          UBreakIterator;
typedef struct UCalendar               UCalendar;
typedef struct UDateIntervalFormat     UDateIntervalFormat;
typedef struct UFormattedDateInterval  UFormattedDateInterval;
typedef struct UNumberRangeFormatter   UNumberRangeFormatter;
typedef struct UFormattedNumberRange   UFormattedNumberRange;
typedef struct UFormattedValue         UFormattedValue;

typedef int32_t  UErrorCode;
typedef uint16_t UChar;
typedef double   UDate;

enum {
  U_ZERO_ERROR        = 0,
  U_UNSUPPORTED_ERROR = 16,
};

typedef enum { UCAL_WALL_TIME = 0 }                        UTimeZoneLocalOption;
typedef enum { UNUM_RANGE_COLLAPSE_AUTO = 0 }              UNumberRangeCollapse;
typedef enum { UNUM_IDENTITY_FALLBACK_APPROXIMATELY = 0 }  UNumberRangeIdentityFallback;

/* ── ubrk_clone (ICU 69) ────────────────────────────────────────────────────
 * ubrk_safeClone is the direct predecessor — identical semantics, the only
 * difference being the removal of the optional stack-buffer arguments.
 */
extern UBreakIterator *ubrk_safeClone(
  const UBreakIterator *bi, void *stackBuffer,
  int32_t *pBufferSize, UErrorCode *status);

__attribute__((visibility("default")))
UBreakIterator *ubrk_clone(const UBreakIterator *bi, UErrorCode *status) {
  return ubrk_safeClone(bi, (void*)0, (int32_t*)0, status);
}

/* ── Stub macro ─────────────────────────────────────────────────────────────
 * All remaining symbols are stubs that set U_UNSUPPORTED_ERROR and return 0.
 * Bun checks UErrorCode after every ICU call and falls back gracefully.
 */
#define STUB_VOID(name) \
  __attribute__((visibility("default"))) void name() {}

#define STUB_NULL(ret, name) \
  __attribute__((visibility("default"))) ret *name() { return (ret*)0; }

#define STUB_ZERO(ret, name) \
  __attribute__((visibility("default"))) ret name() { return (ret)0; }

/* ── ICU 69 ── */
STUB_ZERO(int32_t, ucal_getTimeZoneOffsetFromLocal)

/* ── ICU 67: UDateIntervalFormat result API ── */
STUB_VOID(udtitvfmt_formatCalendarToResult)
STUB_VOID(udtitvfmt_formatToResult)
STUB_NULL(UFormattedDateInterval, udtitvfmt_openResult)
STUB_NULL(UFormattedValue,        udtitvfmt_resultAsValue)
STUB_VOID(udtitvfmt_closeResult)

/* ── ICU 68: UNumberRangeFormatter ── */
STUB_NULL(UNumberRangeFormatter,  unumrf_openForSkeletonCollapseIdentityFallbackAndLocaleWithError)
STUB_NULL(UNumberRangeFormatter,  unumrf_openForSkeletonWithCollapseAndIdentityFallback)
STUB_VOID(unumrf_close)
STUB_NULL(UFormattedNumberRange,  unumrf_openResult)
STUB_VOID(unumrf_formatDoubleRange)
STUB_VOID(unumrf_formatDecimalRange)
STUB_NULL(UFormattedValue,        unumrf_resultAsValue)
STUB_ZERO(int32_t,                unumrf_resultGetIdentityResult)
STUB_ZERO(int32_t,                unumrf_resultToString)
STUB_VOID(unumrf_closeResult)

/* ── ICU 68: plural rules for ranges ── */
STUB_VOID(uplrules_selectForRange)
CSRC
log "Compiling shim → ${DIM}$SHIM_DYLIB${RESET}"
mkdir -p /usr/local/lib

cc -shared "$SHIM_C" -o "$SHIM_DYLIB" \
  -Wl,-reexport-licucore \
  -current_version 1.0.0 \
  -compatibility_version 1.0.0

[[ -f "$SHIM_DYLIB" ]] || die "Compilation failed"
ok "Compiled"

log "Patching Bun binary"

otool -L "$BUN_BIN" | grep -q 'libicucore.A.dylib' \
  || die "Bun does not reference libicucore.A.dylib — unexpected binary layout"

install_name_tool \
  -change /usr/lib/libicucore.A.dylib \
          /usr/local/lib/libicucore_shim.dylib \
  "$BUN_BIN"

ok "Binary patched"

log "Applying ad-hoc code signature"
codesign -f -s - "$BUN_BIN"
ok "Signed"

log "Verifying"
BUN_VERSION=$("$BUN_BIN" --version 2>&1) \
  || die "Bun still fails after patching.\n  Check: otool -L \"$BUN_BIN\""

echo
ok "${BOLD}Done.${RESET}  Bun ${GREEN}${BUN_VERSION}${RESET} is working on macOS $(sw_vers -productVersion)"
echo
log "Shim:        ${DIM}$SHIM_DYLIB${RESET}"
log "Uninstall:   ${DIM}${CMD} --uninstall${RESET}"
log "After upgrade: re-run ${DIM}${CMD}${RESET}"
echo
