#!/usr/bin/env bash
# OpenWrt x86 test VMs for destructive testing (ports, VLANs, bridges, firewall
# input). Runs under libvirt (qemu:///system); needs membership
# of the libvirt group, not sudo. Everything lives on 10.232.0.0/16.
#
#   netui-router  eth0 LAN port (host is on it as 10.232.1.10)   10.232.1.1
#                 eth1 WAN (libvirt NAT, DHCP)
#                 eth2 port, cabled to netui-client eth0
#                 eth3, eth4 ports with nothing attached
#   netui-client  eth0 cable to router eth2 (DHCP client), eth1 mgmt 10.232.9.2
#
# Usage: dev/vm/vm.sh up | deploy | ssh [cmd] | client [cmd] | status | down
set -euo pipefail

RELEASE="${OPENWRT_RELEASE:-25.12.5}"
IMAGE="openwrt-$RELEASE-x86-64-generic-ext4-combined.img"
URL="https://downloads.openwrt.org/releases/$RELEASE/targets/x86/64"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/netui-vm"
KEY="$CACHE/id_ed25519"
ROUTER_IP=10.232.1.1
CLIENT_IP=10.232.9.2
VIRSH=(virsh -q -c qemu:///system)
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=3)

router() { ssh "${SSH_OPTS[@]}" "root@$ROUTER_IP" "$@"; }
client() { ssh "${SSH_OPTS[@]}" "root@$CLIENT_IP" "$@"; }

# name bridge [host-ip] [nat]
define_net() {
  local name="$1" bridge="$2" ip="${3:-}" nat="${4:-}"
  "${VIRSH[@]}" net-info "$name" >/dev/null 2>&1 && { "${VIRSH[@]}" net-start "$name" 2>/dev/null || true; return; }
  local xml="<network><name>$name</name><bridge name='$bridge' stp='off'/>"
  [[ -n "$nat" ]] && xml+="<forward mode='nat'/>"
  if [[ -n "$ip" ]]; then
    xml+="<ip address='$ip' netmask='255.255.255.0'>"
    [[ -n "$nat" ]] && xml+="<dhcp><range start='${ip%.*}.100' end='${ip%.*}.200'/></dhcp>"
    xml+="</ip>"
    [[ -z "$nat" ]] && xml+="<dns enable='no'/>"
  fi
  xml+="</network>"
  "${VIRSH[@]}" net-define /dev/stdin <<<"$xml" >/dev/null
  "${VIRSH[@]}" net-autostart "$name" >/dev/null
  "${VIRSH[@]}" net-start "$name" >/dev/null
}

fetch_image() {
  mkdir -p "$CACHE"
  [[ -f "$CACHE/$IMAGE" ]] && return
  echo "Downloading $IMAGE.gz"
  curl -fsSL -o "$CACHE/$IMAGE.gz" "$URL/$IMAGE.gz"
  local want
  want=$(curl -fsSL "$URL/sha256sums" | awk -v f="*$IMAGE.gz" '$2 == f { print $1 }')
  [[ "$(sha256sum "$CACHE/$IMAGE.gz" | cut -d' ' -f1)" == "$want" ]] || { echo "checksum mismatch" >&2; exit 1; }
  # OpenWrt pads the image; gunzip warns about trailing garbage and exits 2.
  gunzip -c "$CACHE/$IMAGE.gz" >"$CACHE/$IMAGE" 2>/dev/null || [[ $? == 2 ]]
}

# Copy the image and drop a uci-defaults script into its rootfs (partition 2)
# with debugfs, so no root, loop mounts or console scripting are needed.
make_disk() {
  local vm="$1" defaults="$2" raw="$CACHE/$1.img"
  cp "$CACHE/$IMAGE" "$raw"
  local start size
  read -r start size < <(sfdisk -J "$raw" | jq -r '.partitiontable.partitions[1] | "\(.start) \(.size)"')
  dd if="$raw" of="$CACHE/$vm.root" bs=512 skip="$start" count="$size" status=none
  sed "s|@PUBKEY@|$(cat "$KEY.pub")|" "$defaults" >"$CACHE/99-netui-vm"
  debugfs -w -f - "$CACHE/$vm.root" >/dev/null 2>&1 <<EOF
cd /etc/uci-defaults
write $CACHE/99-netui-vm 99-netui-vm
EOF
  debugfs -R "stat /etc/uci-defaults/99-netui-vm" "$CACHE/$vm.root" 2>/dev/null | grep -q Size || { echo "failed to seed $vm" >&2; exit 1; }
  dd if="$CACHE/$vm.root" of="$raw" bs=512 seek="$start" conv=notrunc status=none
  rm -f "$CACHE/$vm.root" "$CACHE/99-netui-vm"
  "${VIRSH[@]}" vol-delete --pool default "netui-$vm.img" >/dev/null 2>&1 || true
  "${VIRSH[@]}" vol-create-as default "netui-$vm.img" "$(stat -c %s "$raw")" --format raw >/dev/null
  "${VIRSH[@]}" vol-upload --pool default "netui-$vm.img" "$raw"
  rm -f "$raw"
}

wait_ssh() { # wait_ssh <fn> <what>
  for _ in $(seq 90); do "$1" true 2>/dev/null && return; sleep 2; done
  echo "$2 did not come up" >&2
  exit 1
}

up() {
  mkdir -p "$CACHE"
  [[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N '' -C netui-vm -f "$KEY"
  define_net netui-wan nuivm-wan 10.232.0.1 nat
  define_net netui-lan nuivm-lan 10.232.1.10
  define_net netui-p2 nuivm-p2
  define_net netui-p3 nuivm-p3
  define_net netui-p4 nuivm-p4
  define_net netui-mgmt nuivm-mgmt 10.232.9.1

  if ! "${VIRSH[@]}" dominfo netui-router >/dev/null 2>&1; then
    fetch_image
    make_disk router "$HERE/router-defaults.sh"
    virt-install -q --connect qemu:///system --name netui-router --memory 256 --vcpus 1 --osinfo linux2022 \
      --import --disk vol=default/netui-router.img,bus=virtio --graphics none --noautoconsole --autostart \
      --network network=netui-lan,model=virtio,mac=52:54:00:23:01:00 \
      --network network=netui-wan,model=virtio,mac=52:54:00:23:00:01 \
      --network network=netui-p2,model=virtio,mac=52:54:00:23:01:02 \
      --network network=netui-p3,model=virtio,mac=52:54:00:23:01:03 \
      --network network=netui-p4,model=virtio,mac=52:54:00:23:01:04
    fresh_router=1
  fi
  if ! "${VIRSH[@]}" dominfo netui-client >/dev/null 2>&1; then
    fetch_image
    make_disk client "$HERE/client-defaults.sh"
    virt-install -q --connect qemu:///system --name netui-client --memory 128 --vcpus 1 --osinfo linux2022 \
      --import --disk vol=default/netui-client.img,bus=virtio --graphics none --noautoconsole --autostart \
      --network network=netui-p2,model=virtio,mac=52:54:00:23:02:00 \
      --network network=netui-mgmt,model=virtio,mac=52:54:00:23:09:02
  fi
  "${VIRSH[@]}" start netui-router 2>/dev/null || true
  "${VIRSH[@]}" start netui-client 2>/dev/null || true

  wait_ssh router "netui-router ($ROUTER_IP)"
  if [[ -n "${fresh_router:-}" ]]; then
    # bridge(8) to inspect VLAN tables in tests; the rest is stock.
    echo "Installing ip-bridge on the router"
    router 'apk update >/dev/null && apk add ip-bridge >/dev/null' || echo "(apk failed; WAN down?)" >&2
  fi
  deploy
  wait_ssh client "netui-client ($CLIENT_IP)"
  echo "Router: http://$ROUTER_IP/netui/ (netui / netui), LuCI at http://$ROUTER_IP/"
}

deploy() {
  [[ -f "$REPO/dist/index.html" ]] || { echo "Run npm run build first" >&2; exit 1; }
  router 'rm -rf /www/netui && mkdir -p /www/netui'
  tar -C "$REPO/dist" -cf - . | router 'tar -C /www/netui -xf -'
  router 'cat >/usr/share/rpcd/acl.d/netui.json' <"$REPO/openwrt/files/usr/share/rpcd/acl.d/netui.json"
  router '/etc/init.d/rpcd restart'
  echo "Deployed dist/ and ACL to netui-router"
}

down() {
  for vm in netui-router netui-client; do
    "${VIRSH[@]}" destroy "$vm" >/dev/null 2>&1 || true
    "${VIRSH[@]}" undefine "$vm" --remove-all-storage >/dev/null 2>&1 || true
  done
  for n in netui-wan netui-lan netui-p2 netui-p3 netui-p4 netui-mgmt; do
    "${VIRSH[@]}" net-destroy "$n" >/dev/null 2>&1 || true
    "${VIRSH[@]}" net-undefine "$n" >/dev/null 2>&1 || true
  done
  echo "Removed test VMs and networks"
}

status() {
  "${VIRSH[@]}" list --all | grep netui- || echo "no VMs"
  router 'uci show network | grep -E "=bridge-vlan|ports|device="' 2>/dev/null || true
}

cmd="${1:-}"
shift || true
case "$cmd" in
  up) up ;;
  deploy) deploy ;;
  down) down ;;
  status) status ;;
  ssh) router "$@" ;;
  client) client "$@" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
