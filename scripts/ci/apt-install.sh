#!/usr/bin/env bash
# Installs system packages on a GitHub Ubuntu runner. The runners read their package mirrors from
# /etc/apt/apt-mirrors.txt; when those do not answer (it happens: for hours the runners could not resolve any
# ubuntu.com host), apt waits twenty seconds per package and the job hangs. This tries the runner's own mirrors
# briefly and then switches to a mirror outside ubuntu.com. Packages stay signed by Ubuntu whichever mirror serves them.
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
  -o APT::Update::Error-Mode=any
)
mirror_list=/etc/apt/apt-mirrors.txt

case "$(dpkg --print-architecture)" in
  amd64 | i386) fallback_mirror=https://mirrors.edge.kernel.org/ubuntu/ ;;
  *) fallback_mirror=https://mirrors.ocf.berkeley.edu/ubuntu-ports/ ;;
esac

if ! sudo timeout 90 apt-get "${apt_options[@]}" update; then
  if [ ! -f "${mirror_list}" ]; then
    echo "apt-install.sh: the package index could not be read and ${mirror_list} does not exist" >&2
    exit 1
  fi
  echo "apt-install.sh: the runner's mirrors do not answer; using ${fallback_mirror}" >&2
  printf '%s\tpriority:1\n' "${fallback_mirror}" | sudo tee "${mirror_list}" >/dev/null
  sudo timeout 300 apt-get "${apt_options[@]}" update
fi

sudo timeout 480 apt-get "${apt_options[@]}" install -y "$@"
