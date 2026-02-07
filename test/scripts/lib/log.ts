// Colored logging helpers for test output

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

export function pass(test: string, detail?: string): void {
  const msg = detail ? `${test} — ${detail}` : test
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}

export function fail(test: string, detail?: string): void {
  const msg = detail ? `${test} — ${detail}` : test
  console.log(`  ${RED}✗${RESET} ${msg}`)
}

export function info(msg: string): void {
  console.log(`  ${CYAN}ℹ${RESET} ${msg}`)
}

export function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}

export function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`)
}

export function summary(passed: number, failed: number): void {
  const total = passed + failed
  const color = failed > 0 ? RED : GREEN
  console.log(`\n${BOLD}Results: ${color}${passed}/${total} passed${RESET}`)
  if (failed > 0) {
    console.log(`${RED}${failed} test(s) failed${RESET}`)
  }
}

export function dim(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`)
}
