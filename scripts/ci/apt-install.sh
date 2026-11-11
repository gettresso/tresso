#!/usr/bin/env bash
# Installs system packages on a GitHub Ubuntu runner. The runners read their package mirrors from
# /etc/apt/apt-mirrors.txt or from the apt sources; when those do not answer (it happens: for hours the runners could
# not resolve any ubuntu.com host), apt waits twenty seconds per package and the job hangs. This tries the runner's own
# mirrors briefly and then switches to a mirror outside ubuntu.com. Packages stay signed by Ubuntu whichever mirror
# serves them.
#
# Usage: scripts/ci/apt-install.sh PACKAGE...
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: apt-install.sh PACKAGE..." >&2
  exit 2
fi

apt_options=(
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
)
mirror_list=/etc/apt/apt-mirrors.txt

case "$(dpkg --print-architecture)" in
  amd64 | i386) fallback_mirror=https://mirrors.edge.kernel.org/ubuntu/ ;;
  *) fallback_mirror=https://mirrors.mit.edu/ubuntu-ports/ ;;
esac

# Only this first try treats any source that fails as a failure: that is what tells a dead mirror from a live one.
if ! sudo timeout -k 10 90 apt-get "${apt_options[@]}" -o APT::Update::Error-Mode=any update; then
  echo "apt-install.sh: the runner's mirrors do not answer; using ${fallback_mirror}" >&2
  # Some runner images read their mirrors from the list file, others name ubuntu.com hosts in the sources themselves.
  if [ -f "${mirror_list}" ]; then
    printf '%s\tpriority:1\n' "${fallback_mirror}" | sudo tee "${mirror_list}" >/dev/null
  fi
  sources=()
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    if [ -f "${file}" ]; then
      sources+=("${file}")
    fi
  done
  if [ "${#sources[@]}" -gt 0 ]; then
    sudo sed -i -E "s#https?://([a-z0-9.-]+\\.)?(archive|security|ports)\\.ubuntu\\.com/ubuntu(-ports)?/?#${fallback_mirror}#g" "${sources[@]}"
  fi
  sudo timeout -k 10 240 apt-get "${apt_options[@]}" update

  # Ubuntu's index files carry no expiry date, so apt takes a mirror that stopped following Ubuntu without a word.
  # The release builds bundle these libraries, so a mirror that is days behind must fail the job.
  newest=0
  for index in /var/lib/apt/lists/*-security_InRelease; do
    if [ -f "${index}" ]; then
      stamp="$(date -d "$(sed -n 's/^Date: //p' "${index}" | head -n 1)" +%s)"
      if [ "${stamp}" -gt "${newest}" ]; then
        newest="${stamp}"
      fi
    fi
  done
  if [ "${newest}" -lt "$(($(date +%s) - 7 * 24 * 3600))" ]; then
    echo "apt-install.sh: the security index of ${fallback_mirror} is more than 7 days old; not using it" >&2
    exit 1
  fi
fi

sudo timeout -k 10 480 apt-get "${apt_options[@]}" install -y "$@"
