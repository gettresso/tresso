#!/usr/bin/env bash
# Install the Tresso desktop app from GitHub releases.
# https://github.com/gettresso/tresso
#
#   curl -fsSL https://sherin.dev/tresso/install.sh | bash
#   curl -fsSL https://sherin.dev/tresso/install.sh | bash -s v0.2.0
#
# TRESSO_VERSION pins a release like the first argument. TRESSO_INSTALL sets where the app goes: on macOS the folder
# that gets Tresso.app (default /Applications, or ~/Applications when that is not writable), on Linux the folder that
# gets Tresso.AppImage (default ~/.local/share/tresso).

if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: install.sh requires bash" >&2
  exit 1
fi

set -euo pipefail

repo="gettresso/tresso"
github="https://github.com/${repo}"

# The three parts of the Tresso mark (Do, Hand over, Know), in their dark-theme shades so they read on any terminal.
stops=(143 162 255 242 154 85 108 199 178)
basic_codes=(34 33 36)
accent_rgb="143;162;255"
accent_256=111
tagline="Every email is something to do, to hand over, or to know."
logo_block=(
  '████████╗██████╗ ███████╗███████╗███████╗ ██████╗ '
  '╚══██╔══╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗'
  '   ██║   ██████╔╝█████╗  ███████╗███████╗██║   ██║'
  '   ██║   ██╔══██╗██╔══╝  ╚════██║╚════██║██║   ██║'
  '   ██║   ██║  ██║███████╗███████║███████║╚██████╔╝'
  '   ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝ ╚═════╝ '
)
logo_ascii=(
  ' _____   ____    _____   ____    ____     ___  '
  '|_   _| |  _ \  | ____| / ___|  / ___|   / _ \ '
  '  | |   | |_) | |  _|   \___ \  \___ \  | | | |'
  '  | |   |  _ <  | |___   ___) |  ___) | | |_| |'
  '  |_|   |_| \_\ |_____| |____/  |____/   \___/ '
)

# Presentation: logo, step lines, spinner, and a summary box. Runs on bash 3.2 (macOS).
tty=0
if [ -t 1 ]; then
  tty=1
  # Keep the terminal on fd 3: inside $(...) stdout is a pipe, and with curl | bash so is stdin.
  exec 3>&1
fi

color=1
if [ -n "${NO_COLOR:-}" ] || [ "${TERM:-}" = "dumb" ] || { [ "$tty" -eq 0 ] && [ -z "${CLICOLOR_FORCE:-}" ]; }; then
  color=0
fi

# Unicode art needs a UTF-8 locale and a bash that counts characters, not bytes.
unicode=0
probe="✓"
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*)
    if [ "${#probe}" -eq 1 ]; then
      unicode=1
    fi
    ;;
  "")
    # No locale at all is common in fresh macOS shells. Try a UTF-8 one for this script only;
    # an explicit C or POSIX locale keeps the ASCII fallback.
    for candidate in en_US.UTF-8 C.UTF-8; do
      LC_CTYPE="$candidate"
      if [ "${#probe}" -eq 1 ]; then
        unicode=1
        break
      fi
    done
    if [ "$unicode" -eq 0 ]; then
      unset LC_CTYPE
    fi
    ;;
esac

depth="basic"
case "${COLORTERM:-}" in
  truecolor | 24bit) depth="truecolor" ;;
  *)
    case "${TERM:-}" in
      *256color*) depth="256" ;;
    esac
    ;;
esac

if [ "$color" -eq 1 ]; then
  c_reset=$'\033[0m'
  c_bold=$'\033[1m'
  c_dim=$'\033[2m'
  c_red=$'\033[31m'
  c_green=$'\033[32m'
  c_yellow=$'\033[33m'
  case "$depth" in
    truecolor) c_accent=$'\033['"38;2;${accent_rgb}m" ;;
    256) c_accent=$'\033['"38;5;${accent_256}m" ;;
    *) c_accent=$'\033['"${basic_codes[0]}m" ;;
  esac
else
  c_reset=""
  c_bold=""
  c_dim=""
  c_red=""
  c_green=""
  c_yellow=""
  c_accent=""
fi

if [ "$unicode" -eq 1 ]; then
  mark_ok="✓"
  mark_warn="!"
  mark_err="✗"
  spinner_frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  box_tl="╭"
  box_tr="╮"
  box_bl="╰"
  box_br="╯"
  box_h="─"
  box_v="│"
  logo_rows=("${logo_block[@]}")
else
  mark_ok="+"
  mark_warn="!"
  mark_err="x"
  spinner_frames=("|" "/" "-" "\\")
  box_tl="+"
  box_tr="+"
  box_bl="+"
  box_br="+"
  box_h="-"
  box_v="|"
  logo_rows=("${logo_ascii[@]}")
fi

cursor_hidden=0

terminal_columns() {
  local size="" cols=""
  if [ "$tty" -eq 1 ]; then
    size="$(stty size <&3 2>/dev/null || true)"
    cols="${size#* }"
  fi
  case "$cols" in
    "" | *[!0-9]*) cols="${COLUMNS:-80}" ;;
  esac
  case "$cols" in
    "" | *[!0-9]*) cols=80 ;;
  esac
  printf '%s\n' "$cols"
}

# Sets $paint to the escape for column $1 of $2 on the logo gradient ($stops, three RGB stops).
gradient_escape() {
  local column="$1" span="$2" shadow="$3"
  local fraction=$((column * 1000 / (span > 1 ? span - 1 : 1)))
  local from_r from_g from_b to_r to_g to_b local_f
  if [ "$fraction" -lt 500 ]; then
    from_r=${stops[0]} from_g=${stops[1]} from_b=${stops[2]} to_r=${stops[3]} to_g=${stops[4]} to_b=${stops[5]}
    local_f=$((fraction * 2))
  else
    from_r=${stops[3]} from_g=${stops[4]} from_b=${stops[5]} to_r=${stops[6]} to_g=${stops[7]} to_b=${stops[8]}
    local_f=$(((fraction - 500) * 2))
  fi
  local r=$((from_r + (to_r - from_r) * local_f / 1000))
  local g=$((from_g + (to_g - from_g) * local_f / 1000))
  local b=$((from_b + (to_b - from_b) * local_f / 1000))
  local weight="1"
  if [ "$shadow" -eq 1 ]; then
    r=$((r * 55 / 100))
    g=$((g * 55 / 100))
    b=$((b * 55 / 100))
    weight="22"
  fi
  case "$depth" in
    truecolor)
      paint=$'\033['"${weight};38;2;${r};${g};${b}m"
      ;;
    256)
      local lr lg lb
      lr=$(xterm_level "$r")
      lg=$(xterm_level "$g")
      lb=$(xterm_level "$b")
      paint=$'\033['"${weight};38;5;$((16 + 36 * lr + 6 * lg + lb))m"
      ;;
    *)
      local code="${basic_codes[0]}"
      if [ "$fraction" -ge 670 ]; then
        code="${basic_codes[2]}"
      elif [ "$fraction" -ge 340 ]; then
        code="${basic_codes[1]}"
      fi
      if [ "$shadow" -eq 1 ]; then
        paint=$'\033[2;'"${code}m"
      else
        paint=$'\033[1;'"${code}m"
      fi
      ;;
  esac
}

xterm_level() {
  if [ "$1" -lt 48 ]; then
    printf '0'
  elif [ "$1" -lt 115 ]; then
    printf '1'
  else
    printf '%s' $((($1 - 35) / 40))
  fi
}

print_logo() {
  local span="${#logo_rows[0]}"
  local cols
  cols="$(terminal_columns)"
  printf '\n'
  if [ $((span + 2)) -le "$cols" ]; then
    local row line i ch shadow last=""
    for row in "${logo_rows[@]}"; do
      if [ "$color" -eq 0 ]; then
        printf '  %s\n' "$row"
        continue
      fi
      line=""
      i=0
      while [ "$i" -lt "${#row}" ]; do
        ch="${row:$i:1}"
        if [ "$ch" = " " ]; then
          line="${line} "
        else
          shadow=0
          if [ "$unicode" -eq 1 ] && [ "$ch" != "█" ]; then
            shadow=1
          fi
          gradient_escape "$i" "$span" "$shadow"
          if [ "$paint" != "$last" ]; then
            line="${line}${paint}"
            last="$paint"
          fi
          line="${line}${ch}"
        fi
        i=$((i + 1))
      done
      last=""
      printf '  %s%s\n' "$line" "$c_reset"
    done
    printf '\n'
  fi
  printf '  %s%s%s  %s\n\n' "$c_bold" "$tagline" "$c_reset" "${c_dim}installer${c_reset}"
}

step() {
  printf '  %s %-10s %s\n' "${c_green}${mark_ok}${c_reset}" "$1" "${c_dim}$2${c_reset}"
}

note() {
  printf '  %s %-10s %s\n' "${c_yellow}${mark_warn}${c_reset}" "$1" "$2"
}

error() {
  printf '  %s %s\n' "${c_bold}${c_red}${mark_err}${c_reset}" "${c_red}$*${c_reset}" >&2
}

die() {
  error "$@"
  exit 1
}

show_cursor() {
  if [ "$cursor_hidden" -eq 1 ]; then
    printf '\033[?25h'
    cursor_hidden=0
  fi
}

# Runs "$@" in the background with a spinner and label $1 when stdout is a terminal.
# Its stderr is held back and printed after the spinner line is cleared.
spin() {
  local label="$1"
  shift
  if [ "$tty" -eq 0 ]; then
    "$@"
    return
  fi
  # A label wider than the terminal would wrap, and \r would only redraw its last row.
  local room=$(($(terminal_columns) - 5))
  if [ "${#label}" -gt "$room" ] && [ "$room" -gt 3 ]; then
    label="${label:0:$((room - 3))}..."
  fi
  local log="${tmpdir}/spin.log"
  "$@" 2>"$log" &
  local pid=$!
  local frame=0
  local count="${#spinner_frames[@]}"
  printf '\033[?25l'
  cursor_hidden=1
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r  %s %s' "${c_accent}${spinner_frames[$((frame % count))]}${c_reset}" "$label"
    frame=$((frame + 1))
    sleep 0.08
  done
  printf '\r\033[2K'
  show_cursor
  local status=0
  wait "$pid" || status=$?
  if [ "$status" -ne 0 ] && [ -s "$log" ]; then
    sed 's/^/    /' "$log" >&2
  fi
  return "$status"
}

display_path() {
  case "$1" in
    "${HOME}"/*) printf '~%s\n' "${1#"${HOME}"}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

human_size() {
  awk -v bytes="$1" 'BEGIN {
    if (bytes >= 1048576) printf "%.1f MB", bytes / 1048576
    else if (bytes >= 1024) printf "%.0f KB", bytes / 1024
    else printf "%d B", bytes
  }'
}

# Prints a rounded box. Arguments alternate plain text and its colored form.
summary_box() {
  local width=0 plain
  local -a plains=() painted=()
  while [ "$#" -gt 0 ]; do
    if [ "$#" -gt 2 ] || [ -n "$1" ]; then
      plains+=("$1")
      painted+=("$2")
    fi
    shift 2
  done
  for plain in "${plains[@]}"; do
    if [ "${#plain}" -gt "$width" ]; then
      width="${#plain}"
    fi
  done
  local i=0
  if [ $((width + 10)) -gt "$(terminal_columns)" ]; then
    printf '\n'
    while [ "$i" -lt "${#painted[@]}" ]; do
      printf '  %s\n' "${painted[$i]}"
      i=$((i + 1))
    done
    printf '\n'
    return
  fi
  local rule=""
  while [ "$i" -lt $((width + 6)) ]; do
    rule="${rule}${box_h}"
    i=$((i + 1))
  done
  local blank
  blank="$(printf '%*s' $((width + 6)) '')"
  printf '\n  %s\n' "${c_dim}${box_tl}${rule}${box_tr}${c_reset}"
  printf '  %s%s%s\n' "${c_dim}${box_v}${c_reset}" "$blank" "${c_dim}${box_v}${c_reset}"
  i=0
  while [ "$i" -lt "${#plains[@]}" ]; do
    local pad=$((width - ${#plains[$i]}))
    printf '  %s   %s%*s   %s\n' "${c_dim}${box_v}${c_reset}" "${painted[$i]}" "$pad" '' "${c_dim}${box_v}${c_reset}"
    i=$((i + 1))
  done
  printf '  %s%s%s\n' "${c_dim}${box_v}${c_reset}" "$blank" "${c_dim}${box_v}${c_reset}"
  printf '  %s\n\n' "${c_dim}${box_bl}${rule}${box_br}${c_reset}"
}

if ! command -v curl >/dev/null 2>&1; then
  die "curl is required"
fi

download() {
  curl -fsSL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 -o "$2" "$1"
}

normalize_version() {
  local raw="$1"
  case "$raw" in
    "") die "empty version" ;;
    *[!A-Za-z0-9._-]*) die "invalid version: ${raw}" ;;
  esac
  case "$raw" in
    v*) printf '%s\n' "$raw" ;;
    *) printf 'v%s\n' "$raw" ;;
  esac
}

resolve_version() {
  if [ -n "${1:-}" ]; then
    normalize_version "$1"
    return
  fi
  if [ -n "${TRESSO_VERSION:-}" ]; then
    normalize_version "$TRESSO_VERSION"
    return
  fi
  local latest_url="${github}/releases/latest" effective=""
  if ! effective="$(curl -fsSL --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "$latest_url")"; then
    die "could not find the latest release at ${latest_url}"
  fi
  case "$effective" in
    */releases/tag/*) ;;
    *) die "no release published yet at ${latest_url}" ;;
  esac
  normalize_version "${effective##*/}"
}

# The release file for this computer; macOS gets one app for Apple Silicon and Intel.
platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      printf '%s\n' "macos-universal"
      ;;
    Linux)
      case "$arch" in
        x86_64 | amd64) printf '%s\n' "linux-x86_64" ;;
        arm64 | aarch64) printf '%s\n' "linux-aarch64" ;;
        *) die "unsupported platform: ${os} ${arch}" ;;
      esac
      ;;
    MINGW* | MSYS* | CYGWIN*)
      die "on Windows, run: powershell -c \"irm https://sherin.dev/tresso/install.ps1|iex\""
      ;;
    *)
      die "unsupported platform: ${os} ${arch}"
      ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    die "sha256sum or shasum is required to verify the download"
  fi
}

verify_checksum() {
  local file="$1" asset="$2" sums="$3" expected="" actual=""
  expected="$(grep -E "[[:space:]]\\*?${asset//./\\.}$" "$sums" | awk 'NR == 1 { print $1 }' || true)"
  if [ -z "$expected" ]; then
    die "checksum mismatch: SHA256SUMS has no entry for ${asset}"
  fi
  expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  actual="$(sha256_file "$file" | tr '[:upper:]' '[:lower:]')"
  if [ "$actual" != "$expected" ]; then
    error "checksum mismatch for ${asset}"
    error "expected ${expected}"
    error "actual   ${actual}"
    exit 1
  fi
}

print_logo

version="$(resolve_version "${1:-}")"
name="$(platform)"
case "$name" in
  macos-*) asset="tresso-${name}.app.tar.gz" ;;
  linux-*) asset="tresso-${name}.AppImage" ;;
esac
base="${github}/releases/download/${version}"

step "Version" "${version}"
step "Platform" "${name}"

tmpdir=""
cleanup() {
  show_cursor
  if [ -n "$tmpdir" ]; then
    rm -rf "$tmpdir"
  fi
}
trap cleanup EXIT
tmpdir="$(mktemp -d)"

file="${tmpdir}/${asset}"
sums="${tmpdir}/SHA256SUMS"

fetch_release() {
  download "${base}/${asset}" "$file" && download "${base}/SHA256SUMS" "$sums"
}

if ! spin "Downloading ${asset}" fetch_release; then
  if [ ! -s "$file" ]; then
    die "download failed: ${base}/${asset}"
  fi
  die "download failed: ${base}/SHA256SUMS"
fi
step "Download" "${asset} ($(human_size "$(wc -c <"$file" | tr -d ' ')"))"

verify_checksum "$file" "$asset" "$sums"
step "Checksum" "SHA-256 matches SHA256SUMS"

install_macos() {
  local dir="${TRESSO_INSTALL:-}"
  if [ -z "$dir" ]; then
    dir="/Applications"
    if [ ! -w "$dir" ]; then
      dir="${HOME}/Applications"
    fi
  fi
  dir="${dir%/}"
  mkdir -p "$dir" || die "could not create ${dir}"

  local extract="${tmpdir}/extract"
  mkdir -p "$extract"
  tar -xzf "$file" -C "$extract"
  [ -d "${extract}/Tresso.app" ] || die "the download does not contain Tresso.app"

  if pgrep -xq tresso-desktop 2>/dev/null; then
    note "Running" "Tresso is open; quit and reopen it to use ${version}"
  fi

  # Swap in the new app in one move, so a failed copy never leaves half an app behind.
  dest="${dir}/Tresso.app"
  local stage="${dir}/.Tresso.app.new"
  rm -rf "$stage"
  cp -R "${extract}/Tresso.app" "$stage"
  rm -rf "$dest"
  mv "$stage" "$dest"
  step "Installed" "$(display_path "$dest")"

  # The app has no Apple Developer ID signature yet: without the quarantine flag, Gatekeeper opens it directly.
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  step "Gatekeeper" "quarantine flag removed"

  open_plain="open -a Tresso"
  open_painted="${c_bold}${c_accent}open -a Tresso${c_reset}"
  if [ "$dir" != "/Applications" ]; then
    open_plain="open \"$(display_path "$dest")\""
    open_painted="${c_bold}${c_accent}${open_plain}${c_reset}"
  fi
}

launcher_safe() {
  case "$1" in
    *[\"\`\$\\%]* | *$'\n'*) die "the install folder may not contain \", \`, \$, \\, % or a line break: $1" ;;
  esac
}

install_linux() {
  local dir="${TRESSO_INSTALL:-"${HOME}/.local/share/tresso"}"
  dir="${dir%/}"
  # A full path without $(...), which would drop a trailing line break from it. The launcher entry quotes this path,
  # so characters that need escaping there are refused before anything is created.
  case "$dir" in
    /*) ;;
    *) dir="${PWD}/${dir}" ;;
  esac
  launcher_safe "$dir"
  mkdir -p "$dir" || die "could not create ${dir}"

  dest="${dir}/Tresso.AppImage"
  cp "$file" "${dest}.new"
  chmod 755 "${dest}.new"
  mv -f "${dest}.new" "$dest"
  step "Installed" "$(display_path "$dest")"

  # A command on PATH, when ~/.local/bin is one.
  local bin="${HOME}/.local/bin"
  mkdir -p "$bin"
  ln -sfn "$dest" "${bin}/tresso"
  case ":${PATH}:" in
    *":${bin}:"*) step "Linked" "$(display_path "${bin}/tresso")" ;;
    *) note "Linked" "$(display_path "${bin}/tresso"), but that folder is not on PATH" ;;
  esac

  # The launcher entry, which also makes Tresso the handler of tresso:// links: sign-in comes back through one.
  local data="${XDG_DATA_HOME:-"${HOME}/.local/share"}"
  local icons="${data}/icons/hicolor/256x256/apps"
  mkdir -p "${data}/applications" "$icons"
  # The icon is not in SHA256SUMS: a PNG for the launcher, fetched over https from the release's own tag.
  if download "https://raw.githubusercontent.com/${repo}/${version}/apps/desktop/src-tauri/icons/128x128@2x.png" "${tmpdir}/tresso.png"; then
    cp "${tmpdir}/tresso.png" "${icons}/tresso.png"
  else
    note "Icon" "could not download the icon; the launcher entry has none"
  fi
  cat >"${data}/applications/tresso.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Tresso
Comment=${tagline}
Exec="${dest}" %u
Icon=tresso
Terminal=false
Categories=Network;Email;Office;
MimeType=x-scheme-handler/tresso;
StartupWMClass=tresso-desktop
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${data}/applications" >/dev/null 2>&1 || true
  fi
  if command -v xdg-mime >/dev/null 2>&1 && xdg-mime default tresso.desktop x-scheme-handler/tresso 2>/dev/null; then
    step "Launcher" "Tresso is in your apps and opens tresso:// links"
  else
    note "Launcher" "added, but xdg-mime is missing: sign-in may not find its way back to Tresso"
  fi

  # AppImages mount themselves with FUSE 2.
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    note "FUSE" "libfuse2 is missing: install libfuse2 (libfuse2t64 on Ubuntu 24.04+) or use the .deb from the release"
  fi

  open_plain="tresso"
  open_painted="${c_bold}${c_accent}tresso${c_reset}"
}

dest=""
open_plain=""
open_painted=""
case "$name" in
  macos-*) install_macos ;;
  linux-*) install_linux ;;
esac

title="Tresso ${version#v} is installed"
summary_box \
  "${mark_ok} ${title}" "${c_bold}${c_green}${mark_ok}${c_reset} ${c_bold}${title}${c_reset}" \
  "" "" \
  "Location  $(display_path "$dest")" "${c_dim}Location${c_reset}  $(display_path "$dest")" \
  "Open      ${open_plain}" "${c_dim}Open${c_reset}      ${open_painted}" \
  "Server    Tresso Cloud, or your own at sign-in" "${c_dim}Server${c_reset}    Tresso Cloud, or your own at sign-in"
