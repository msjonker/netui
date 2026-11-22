#!/usr/bin/env bash
# netui's rpcd plugins under a real rpcd, in the official OpenWrt rootfs
# images (test/plugins/check.uc). Without arguments: every release netui
# supports. CI runs it on every push.
#
#   scripts/test-plugins.sh [image ...]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
# Pinned like the workflows' actions; refresh with: docker pull <tag> && docker inspect --format '{{index .RepoDigests 0}}' <tag>
IMAGES=(
	'openwrt/rootfs:x86-64-24.10.8@sha256:9972a4b4747cd136abd597475d7b88c51a49fd849d0d53f069a2f4bf446061b9'
	'openwrt/rootfs:x86-64-25.12.6@sha256:14401c04218c2e0da0448f099710ada2460636a92395f353351cc616cf3f67af'
)
[ $# -gt 0 ] && IMAGES=("$@")
status=0
for image in "${IMAGES[@]}"; do
	echo "=== $image"
	docker run --rm -v "$REPO:/src:ro" "$image" sh /src/test/plugins/run.sh /src || status=1
done
exit $status
