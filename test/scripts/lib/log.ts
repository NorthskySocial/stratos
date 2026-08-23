// Colored logging helpers and shared check counters for test output.
//
// pass(), fail(), and skip() increment module-level counters. finish()
// prints the summary and exits non-zero when any check failed, or when
// no checks ran at all — a phase that silently does nothing cannot go
// green. info/warn/error/dim/section are pure printers.

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

let passedCount = 0
let failedCount = 0
let skippedCount = 0

export function pass(test: string, detail?: string): void {
  passedCount++
  const msg = detail ? `${test} — ${detail}` : test
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}

export function fail(test: string, detail?: string): void {
  failedCount++
  const msg = detail ? `${test} — ${detail}` : test
  console.log(`  ${RED}✗${RESET} ${msg}`)
}

export function skip(test: string, detail?: string): void {
  skippedCount++
  const msg = detail ? `${test} — ${detail}` : test
  console.log(`  ${YELLOW}○${RESET} ${msg} ${DIM}(skipped)${RESET}`)
}

export function assert(
  condition: unknown,
  testName: string,
  detail?: string,
): void {
  if (condition) {
    pass(testName, detail)
  } else {
    fail(testName, detail)
  }
}

export function assertFalse(
  condition: unknown,
  testName: string,
  detail?: string,
): void {
  assert(!condition, testName, detail)
}

export function failureCount(): number {
  return failedCount
}

export function info(msg: string): void {
  console.log(`  ${CYAN}ℹ${RESET} ${msg}`)
}

export function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}

export function error(msg: string, error: { error: string }): void {
  console.log(`  ${RED}E${RESET} ${msg}`)
  console.error(error.error)
}

export function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`)
}

/** Print the counted summary and exit; the exit code is the phase verdict. */
export function finish(): never {
  const total = passedCount + failedCount
  const color = failedCount > 0 ? RED : GREEN
  console.log(
    `\n${BOLD}Results: ${color}${passedCount}/${total} passed${RESET}`,
  )
  if (skippedCount > 0) {
    console.log(`${YELLOW}${skippedCount} check(s) skipped${RESET}`)
  }
  if (failedCount > 0) {
    console.log(`${RED}${failedCount} check(s) failed${RESET}`)
    Deno.exit(1)
  }
  if (total === 0 && skippedCount === 0) {
    console.log(`${RED}No checks ran — failing the phase${RESET}`)
    Deno.exit(1)
  }
  Deno.exit(0)
}

export function dim(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`)
}
