#!/usr/bin/env bash
# Makes the release DMG: Tresso-<version>.dmg with a disk named "Tresso <version>", like the owner's other macOS apps.
#
# Usage: scripts/ci/make-dmg.sh BUNDLE VERSION OUT
#   BUNDLE   Tauri's bundle folder (src-tauri/target/<target>/release/bundle), after `tauri bundle --bundles app,dmg`
#   VERSION  the version in the file and disk name, for example 0.8.0
#   OUT      the folder that gets Tresso-<version>.dmg
#
# Tauri names the disk after the product and has no setting for it, and renaming the finished disk would not do: the
# background in its .DS_Store points at the disk by name. So this runs the create-dmg script Tauri left next to its
# own DMG once more, with exactly the arguments Tauri passes (tauri-bundler, bundle/macos/dmg/mod.rs) but the disk
# name, and the Finder layout from the same merged config Tauri reads. Run from the repository root.
#
# Each run starts clean, so scripts/ci/retry.sh can run it again after Finder's AppleScript failed: it detaches a disk
# an earlier run left mounted and removes that run's images.
set -euo pipefail

bundle="${1:?usage: make-dmg.sh BUNDLE VERSION OUT}"
version="${2:?usage: make-dmg.sh BUNDLE VERSION OUT}"
out="${3:?usage: make-dmg.sh BUNDLE VERSION OUT}"

root="${PWD}"
config="${root}/apps/desktop/src-tauri"
script="${root}/${bundle}/dmg/bundle_dmg.sh"
app="${root}/${bundle}/macos/Tresso.app"
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"
dmg="${out}/Tresso-${version}.dmg"
volume="Tresso ${version}"

if [ ! -x "${script}" ]; then
  echo "make-dmg.sh: Tauri left no ${script}: its DMG bundler changed" >&2
  exit 1
fi
if [ ! -d "${app}" ]; then
  echo "make-dmg.sh: no ${app}" >&2
  exit 1
fi

# An earlier run that stopped half way can leave its read-write image (rw.<pid>.<name>) mounted, and a second disk
# named "Tresso <version>" would confuse Finder's AppleScript, which finds the disk by name.
shopt -s nullglob
for image in "${out}"/rw.*."Tresso-${version}.dmg"; do
  hdiutil info | awk -v image="${image}" '
    /^image-path/ { found = index($0, image) > 0; next }
    found && /^\/dev\/disk[0-9]+[ \t]/ { print $1; found = 0 }
  ' | while read -r device; do
    hdiutil detach -force "${device}" >/dev/null
  done
  rm -f "${image}"
done
rm -f "${dmg}"

# The Finder layout from tauri.conf.json with tauri.macos.conf.json merged over it (a JSON merge patch, as Tauri
# merges its platform files). The release's --config override only sets versions.
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions.
read -r app_x app_y folder_x folder_y width height background < <(node -e '
  const fs = require("fs")
  const merge = (base, patch) => {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch
    const result = base !== null && typeof base === "object" && !Array.isArray(base) ? { ...base } : {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete result[key]
      else result[key] = merge(result[key], value)
    }
    return result
  }
  const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {})
  const config = merge(read(`${process.argv[1]}/tauri.conf.json`), read(`${process.argv[1]}/tauri.macos.conf.json`))
  const dmg = config.bundle?.macOS?.dmg ?? {}
  const unsupported = Object.keys(dmg).filter(
    (key) => !["appPosition", "applicationFolderPosition", "windowSize", "background"].includes(key),
  )
  if (unsupported.length > 0) {
    console.error(`make-dmg.sh: bundle.macOS.dmg has settings this script does not pass on: ${unsupported.join(", ")}`)
    process.exit(1)
  }
  // Tauri would add --window-pos for dmg.windowPosition (refused above) and --eula for bundle.licenseFile.
  if (config.bundle?.licenseFile) {
    console.error("make-dmg.sh: bundle.licenseFile is set, which Tauri passes as --eula and this script does not")
    process.exit(1)
  }
  const values = [dmg.appPosition?.x, dmg.appPosition?.y, dmg.applicationFolderPosition?.x,
    dmg.applicationFolderPosition?.y, dmg.windowSize?.width, dmg.windowSize?.height, dmg.background]
  if (values.some((value) => value === undefined || /\s/.test(String(value)))) {
    console.error("make-dmg.sh: bundle.macOS.dmg lacks a position, the window size or the background")
    process.exit(1)
  }
  console.log(values.join(" "))
' "${config}")
# Tauri resolves the background against src-tauri, and takes the volume icon from the bundle's .icns, which is the
# icon inside the app.
background="${config}/${background}"
icon="$(plutil -extract CFBundleIconFile raw "${app}/Contents/Info.plist")"
icon="${app}/Contents/Resources/${icon%.icns}.icns"

cd "${root}/${bundle}/macos"
"${script}" \
  --volname "${volume}" \
  --icon Tresso.app "${app_x}" "${app_y}" \
  --app-drop-link "${folder_x}" "${folder_y}" \
  --window-size "${width}" "${height}" \
  --hide-extension Tresso.app \
  --background "${background}" \
  --volicon "${icon}" \
  "${dmg}" Tresso.app
