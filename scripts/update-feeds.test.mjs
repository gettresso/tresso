// node --test 'scripts/*.test.mjs'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  appcast,
  buildOf,
  cdata,
  latestJson,
  parseSparkleSignature,
  signedVersionOf,
  SPARKLE_FEED,
  TAURI_PLATFORMS,
  versionOf,
  xmlEscape,
} from './update-feeds.mjs'

/** A `<file>.sig` as `tauri signer sign --app-version` writes it: the minisign file in base64. */
function sig(trusted) {
  const text = [
    'untrusted comment: signature from tauri secret key',
    'RUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=',
    `trusted comment: ${trusted}`,
    'DDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==',
  ].join('\n')
  return Buffer.from(`${text}\n`).toString('base64')
}

const signedFor = (version) => (file) => sig(`timestamp:1791649051\tfile:${file}\tversion:${version}`)
const release = { tag: 'v0.4.0', notes: 'Notes', pubDate: '2026-10-29T14:00:00Z' }

test('a release tag gives its version, a prerelease too', () => {
  assert.equal(versionOf('v0.4.0'), '0.4.0')
  assert.equal(versionOf('v0.4.0-beta.1'), '0.4.0-beta.1')
  for (const bad of ['0.4.0', 'v0.4', 'v0.4.0-', 'v0.4.0 ', 'release-0.4.0']) {
    assert.throws(() => versionOf(bad), /vMAJOR/)
  }
})

test('latest.json lists every installer that updates in the app, with its signature', () => {
  const feed = latestJson({ ...release, signatureOf: signedFor('0.4.0') })
  assert.equal(feed.version, '0.4.0')
  assert.equal(feed.notes, 'Notes')
  assert.equal(feed.pub_date, '2026-10-29T14:00:00Z')
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    'linux-aarch64',
    'linux-aarch64-appimage',
    'linux-x86_64',
    'linux-x86_64-appimage',
    'windows-x86_64',
    'windows-x86_64-nsis',
  ])
  assert.deepEqual(feed.platforms['windows-x86_64'], {
    signature: signedFor('0.4.0')('tresso-windows-x64-setup.exe'),
    url: 'https://github.com/gettresso/tresso/releases/download/v0.4.0/tresso-windows-x64-setup.exe',
  })
  assert.equal(feed.platforms['linux-aarch64'].url.endsWith('/v0.4.0/tresso-linux-aarch64.AppImage'), true)
})

test('latest.json refuses a release with any installer unsigned', () => {
  const withoutArm = (file) => (file.includes('aarch64') ? null : signedFor('0.4.0')(file))
  assert.throws(() => latestJson({ ...release, signatureOf: withoutArm }), /No updater signature for linux-aarch64$/)
  const withoutWindows = (file) => (file.endsWith('.exe') ? null : signedFor('0.4.0')(file))
  assert.throws(() => latestJson({ ...release, signatureOf: withoutWindows }), /No updater signature for windows-x86_64$/)
})

test('latest.json refuses a signature not bound to the release version', () => {
  // Signed without --app-version: the app (requireSignedVersion) would refuse it.
  const unversioned = (file) => sig(`timestamp:1791649051\tfile:${file}`)
  assert.throws(() => latestJson({ ...release, signatureOf: unversioned }), /is for version \(none\), not 0\.4\.0/)
  // An older release's signature served as the new version.
  assert.throws(() => latestJson({ ...release, signatureOf: signedFor('0.3.0') }), /is for version 0\.3\.0, not 0\.4\.0/)
  // A prerelease signature is not the release.
  assert.throws(() => latestJson({ ...release, signatureOf: signedFor('0.4.0-beta.1') }), /is for version 0\.4\.0-beta\.1/)
})

test('the signed version is read from the trusted comment', () => {
  assert.equal(signedVersionOf(sig('timestamp:1\tfile:a\tversion:1.2.3')), '1.2.3')
  assert.equal(signedVersionOf(sig('timestamp:1\tfile:a')), null)
  assert.equal(signedVersionOf(Buffer.from('not a signature').toString('base64')), null)
})

test('every updater platform points at the installer that updates in the app', () => {
  for (const [platform, file] of TAURI_PLATFORMS) {
    const match = /^(windows|linux)-(x86_64|aarch64)(?:-(nsis|appimage))?$/.exec(platform)
    assert.ok(match, platform)
    assert.equal(file, match[1] === 'windows' ? `tresso-windows-x64-setup.exe` : `tresso-linux-${match[2]}.AppImage`, platform)
  }
})

test('a build number is a positive integer', () => {
  assert.equal(buildOf(412), '412')
  assert.equal(buildOf('1'), '1')
  for (const bad of ['0', '-3', '1.2', 'v12', '', '012']) {
    assert.throws(() => buildOf(bad), /not a positive integer/)
  }
})

test('the sign_update line gives the signature and length', () => {
  assert.deepEqual(parseSparkleSignature('sparkle:edSignature="AbC+/12=" length="4242"\n'), { signature: 'AbC+/12=', length: '4242' })
  assert.throws(() => parseSparkleSignature('Error: no key'), /Not a sign_update line/)
})

test('release notes cannot break out of the appcast', () => {
  assert.equal(xmlEscape('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;')
  assert.equal(cdata('x ]]> y'), '<![CDATA[x ]]]]><![CDATA[> y]]>')
  const xml = appcast({
    tag: 'v0.4.0-beta.1',
    build: '412',
    file: SPARKLE_FEED[1],
    notesHtml: '<p>Hi</p> ]]> <script>',
    pubDate: '2026-10-29T14:00:00Z',
    signature: 'AbC=',
    length: '10',
  })
  // Sparkle orders by the build number; people see the version.
  assert.match(xml, /<sparkle:version>412<\/sparkle:version>/)
  assert.match(xml, /<sparkle:shortVersionString>0\.4\.0-beta\.1<\/sparkle:shortVersionString>/)
  assert.match(xml, /<sparkle:fullReleaseNotesLink>https:\/\/github\.com\/gettresso\/tresso\/releases\/tag\/v0\.4\.0-beta\.1<\/sparkle:fullReleaseNotesLink>/)
  assert.match(xml, /<pubDate>Thu, 29 Oct 2026 14:00:00 GMT<\/pubDate>/)
  assert.match(
    xml,
    /<enclosure url="https:\/\/github\.com\/gettresso\/tresso\/releases\/download\/v0\.4\.0-beta\.1\/tresso-macos-universal\.app\.tar\.gz" sparkle:edSignature="AbC=" length="10" type="application\/octet-stream"\/>/,
  )
  // The only CDATA end markers are the section boundaries.
  assert.equal(xml.split(']]>').length - 1, 2)
})

test('the script writes both feeds from a folder of signed files, and refuses one without the Sparkle signature', () => {
  const dist = mkdtempSync(join(tmpdir(), 'tresso-feeds-'))
  for (const [, file] of TAURI_PLATFORMS) {
    writeFileSync(join(dist, `${file}.sig`), signedFor('0.4.0')(file))
  }
  writeFileSync(join(dist, 'notes.md'), "## What's new\n\n- **New:** A thing\n")
  writeFileSync(join(dist, 'notes.html'), '<h2>What&#39;s new</h2>')
  const script = fileURLToPath(new URL('./update-feeds.mjs', import.meta.url))
  const run = () => execFileSync(process.execPath, [script, dist, 'v0.4.0', '7', join(dist, 'notes.md'), join(dist, 'notes.html')], { stdio: 'pipe' })
  assert.throws(run, (error) => /No Sparkle signature for tresso-macos-universal\.app\.tar\.gz/.test(String(error.stderr)))
  writeFileSync(join(dist, `${SPARKLE_FEED[1]}.sparkle`), 'sparkle:edSignature="AbC=" length="10"\n')
  run()
  const latest = JSON.parse(readFileSync(join(dist, 'latest.json'), 'utf8'))
  assert.equal(latest.version, '0.4.0')
  assert.equal(latest.notes, "## What's new\n\n- **New:** A thing")
  const xml = readFileSync(join(dist, 'appcast.xml'), 'utf8')
  assert.match(xml, /<sparkle:version>7<\/sparkle:version>/)
  assert.match(xml, /<!\[CDATA\[<h2>What&#39;s new<\/h2>\]\]>/)
})
