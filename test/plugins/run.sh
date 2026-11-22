#!/bin/sh
# Runs inside an OpenWrt rootfs container (scripts/test-plugins.sh): a real
# ubusd and rpcd with this checkout's plugins, then test/plugins/check.uc.
set -e
SRC=${1:-/src}

mkdir -p /var/run/ubus /var/lock /usr/share/ucode/netui /etc/netui
cp "$SRC"/openwrt/files/usr/share/rpcd/ucode/* /usr/share/rpcd/ucode/
cp "$SRC"/openwrt/files/usr/share/ucode/netui/* /usr/share/ucode/netui/
cp "$SRC"/openwrt/files/usr/share/rpcd/acl.d/netui.json /usr/share/rpcd/acl.d/

ubusd &
sleep 1
rpcd &
sleep 2

exec ucode "$SRC/test/plugins/check.uc"
