#!/usr/bin/env bash
# Build the netui OpenWrt package in the official SDK container. Same steps
# locally and in CI (.github/workflows/release.yml).
#
#   npm run build
#   scripts/build-package.sh x86-64-openwrt-25.12 0.4.1   # -> out/…/netui-0.4.1-r1.apk
#   scripts/build-package.sh x86-64-openwrt-24.10 0.4.1   # -> out/…/netui_0.4.1-r1_all.ipk
#
# netui is PKGARCH:=all, so one SDK per package format covers every target.
# The SDK release only decides the format: 25.x builds .apk, 24.10 builds .ipk.
set -euo pipefail

sdk="${1:?usage: build-package.sh <sdk-image-tag> [version]}"
version="${2:-0.4.1}"
root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$root/dist/index.html" ]]; then
  echo "build-package.sh: dist/ is missing. Run 'npm run build' first." >&2
  exit 1
fi

out="$root/out/$sdk"
rm -rf "$out"
mkdir -p "$out"
# The SDK runs as its own user (uid 1000); let it write here whatever our uid is.
chmod a+rwx "$out"

# The images default to mirror-03, which is slow from GitHub's runners (~10 min
# vs seconds). setup.sh still checks the GPG-signed sha256sums whatever the host.
docker run --rm \
  -v "$root:/src:ro" \
  -v "$out:/out" \
  -e NETUI_VERSION="$version" \
  -e UPSTREAM_URL="${UPSTREAM_URL:-https://downloads.openwrt.org}" \
  "ghcr.io/openwrt/sdk:$sdk" \
  bash -euo pipefail -c '
    ./setup.sh 2>&1 | grep -E "^(https?:|sdk-|gpg: (Good|BAD))|OK$|FAILED" || true
    [ -f rules.mk ] || { echo "SDK setup failed" >&2; exit 1; }
    ln -s /src/openwrt package/netui
    make defconfig >/dev/null
    make package/netui/compile NETUI_DIST=/src/dist NETUI_VERSION="$NETUI_VERSION" V=s >/tmp/build.log 2>&1 \
      || { grep -iE "error|No such|missing|cannot" /tmp/build.log | tail -n 25; exit 1; }
    find bin -name "netui*.apk" -o -name "netui*.ipk" | xargs -r cp -t /out
  '

ls -l "$out"
