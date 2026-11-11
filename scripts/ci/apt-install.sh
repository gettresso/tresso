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

# Tried in this order. All follow Ubuntu within hours.
case "$(dpkg --print-architecture)" in
  amd64 | i386)
    fallback_mirrors=(
      https://mirrors.edge.kernel.org/ubuntu/
      https://mirror.leaseweb.com/ubuntu/
    )
    ;;
  *)
    fallback_mirrors=(
      https://ftp.tu-chemnitz.de/pub/linux/ubuntu-ports/
      https://mirrors.mit.edu/ubuntu-ports/
    )
    ;;
esac

# Ubuntu's index files carry no expiry date, so apt takes a mirror that stopped following Ubuntu without a word. The
# release builds bundle these libraries, so a mirror whose security index is more than two days behind does not count.
index_is_recent() {
  local newest=0 index dated stamp
  for index in /var/lib/apt/lists/*-security_InRelease; do
    if [ -f "${index}" ]; then
      dated="$(sed -n 's/^Date: //p' "${index}" | head -n 1)"
      if [ -z "${dated}" ]; then
        continue
      fi
      stamp="$(date -d "${dated}" +%s)"
      if [ "${stamp}" -gt "${newest}" ]; then
        newest="${stamp}"
      fi
    fi
  done
  [ "${newest}" -ge "$(($(date +%s) - 2 * 24 * 3600))" ]
}

# Only this first try treats any source that fails as a failure: that is what tells a dead mirror from a live one.
if ! sudo timeout -k 10 90 apt-get "${apt_options[@]}" -o APT::Update::Error-Mode=any update; then
  # Some runner images read their mirrors from the list file, others name ubuntu.com hosts in the sources.
  sources=()
  backups="$(mktemp -d)"
  ubuntu_hosts='https?://([a-z0-9.-]+\.)?(archive|security|ports)\.ubuntu\.com/ubuntu(-ports)?/?'
  for file in "${mirror_list}" /etc/apt/sources.list /etc/apt/sources.list.d/*.list \
    /etc/apt/sources.list.d/*.sources; do
    if [ -f "${file}" ]; then
      sources+=("${file}")
      cp "${file}" "${backups}/$(basename "${file}")"
    fi
  done

  switched=false
  for mirror in "${fallback_mirrors[@]}"; do
    echo "apt-install.sh: the runner's mirrors do not answer; trying ${mirror}" >&2
    for file in "${sources[@]}"; do
      if [ "${file}" = "${mirror_list}" ]; then
        printf '%s\tpriority:1\n' "${mirror}" | sudo tee "${file}" >/dev/null
      else
        sed -E "s#${ubuntu_hosts}#${mirror}#g" "${backups}/$(basename "${file}")" | sudo tee "${file}" >/dev/null
      fi
    done
    sudo rm -f /var/lib/apt/lists/*_InRelease
    if sudo timeout -k 10 100 apt-get "${apt_options[@]}" update && index_is_recent; then
      switched=true
      break
    fi
    echo "apt-install.sh: ${mirror} does not answer or is more than 2 days behind" >&2
  done
  if [ "${switched}" = false ]; then
    echo "apt-install.sh: no package mirror answers" >&2
    exit 1
  fi
fi

sudo timeout -k 10 480 apt-get "${apt_options[@]}" install -y "$@"
