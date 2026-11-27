// Builds the WhatsApp bridge (apps/whatsapp-bridge) that Tresso for Mac carries as a Tauri sidecar
// (tauri.macos.conf.json, bundle > externalBin): pure Go, so both Mac architectures build here with CGO_ENABLED=0 and
// lipo joins them into one universal binary. Tauri looks for the sidecar under the name of the target it builds for,
// so the same universal binary is written as
//   src-tauri/binaries/whatsapp-bridge-aarch64-apple-darwin   (cargo and tauri dev on Apple silicon)
//   src-tauri/binaries/whatsapp-bridge-x86_64-apple-darwin    (cargo and tauri dev on Intel)
//   src-tauri/binaries/whatsapp-bridge-universal-apple-darwin (tauri build --target universal-apple-darwin)
// Run by tauri dev and tauri build (beforeDevCommand, beforeBuildCommand); run it once by hand before cargo check,
// clippy or test on a Mac. A build whose sources, Go version and output did not change is skipped. It also checks that
// the bridge's third-party notices (apps/whatsapp-bridge/THIRD-PARTY-NOTICES.txt) list exactly the modules in the
// binary. Does nothing on other systems, which neither carry nor start the bridge.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', '..', 'whatsapp-bridge')
const binaries = join(here, '..', 'src-tauri', 'binaries')
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin']
const outputs = targets.map((target) => join(binaries, `whatsapp-bridge-${target}`))
const stamp = join(binaries, '.whatsapp-bridge.stamp')

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
}

let goVersion
try {
  goVersion = run('go', ['version']).trim()
} catch {
  console.error('Building the WhatsApp bridge for Tresso for Mac needs Go (see apps/whatsapp-bridge/go.mod for the version): https://go.dev/dl/')
  process.exit(1)
}

// What the binary is made of: the Go version and every file `go build` reads (tests are not part of the binary).
const hash = createHash('sha256').update(`${goVersion}\n`)
for (const name of readdirSync(source).sort()) {
  if ((name.endsWith('.go') && !name.endsWith('_test.go')) || name === 'go.mod' || name === 'go.sum') {
    hash.update(`${name}\n`).update(readFileSync(join(source, name)))
  }
}
const digest = hash.digest('hex')
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === digest && outputs.every((output) => existsSync(output))) {
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'tresso-whatsapp-bridge-'))
try {
  const thin = { arm64: join(work, 'whatsapp-bridge-arm64'), amd64: join(work, 'whatsapp-bridge-amd64') }
  for (const [arch, output] of Object.entries(thin)) {
    run('go', ['build', '-trimpath', '-o', output, '.'], { cwd: source, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: arch } })
  }
  const universal = join(work, 'whatsapp-bridge')
  run('lipo', ['-create', '-output', universal, thin.arm64, thin.amd64])
  for (const arch of ['arm64', 'x86_64']) {
    run('lipo', [universal, '-verify_arch', arch])
  }
  // The notices shipped with the app must name every module this binary links (whatsapp-bridge-notices.mjs).
  run('node', [join(here, 'whatsapp-bridge-notices.mjs'), '--check', thin.arm64], { stdio: ['ignore', 'inherit', 'inherit'] })
  mkdirSync(binaries, { recursive: true })
  for (const output of outputs) {
    copyFileSync(universal, output)
    chmodSync(output, 0o755)
  }
  writeFileSync(stamp, `${digest}\n`)
  console.log(`The WhatsApp bridge (arm64 and x86_64) is in ${binaries}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
