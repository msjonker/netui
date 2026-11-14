#!/usr/bin/env bash
# Record real ubus responses from the router into test/fixtures/ubus/.
#
# Read-only: every call here is a getter. Runs `ubus call` over ssh, so it
# works before the netui rpcd login exists. Secrets are redacted locally with
# jq before anything is written; review the diff before committing anyway
# (hostnames and MACs of your clients end up in the leases/hints fixtures).
#
# Usage:
#   ROUTER_HOST=192.168.1.1 scripts/record-fixtures.sh [ssh-user]   # real device over ssh
#   NETUI_DEVICE=dl-wrx36 ROUTER_HOST=192.168.1.1 scripts/record-fixtures.sh  # -> dl-wrx36/
#   NETUI_CONTAINER=netui-openwrt scripts/record-fixtures.sh        # dev container (dev/openwrt)
#   NETUI_VM=vlan scripts/record-fixtures.sh                         # test VM (dev/vm) -> vm/vlan/
set -euo pipefail

out="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/ubus"

if [[ -n "${NETUI_VM:-}" ]]; then
  # A named scenario: record the VM in each state the tests need.
  out="$out/vm/$NETUI_VM"
  source="test VM ($NETUI_VM)"
  remote() { "$(dirname "$0")/../dev/vm/vm.sh" ssh "$@"; }
elif [[ -n "${NETUI_CONTAINER:-}" ]]; then
  out="$out/dev-container"
  source="docker container $NETUI_CONTAINER"
  remote() { docker exec "$NETUI_CONTAINER" sh -c "$*"; }
else
  host="${ROUTER_HOST:?set ROUTER_HOST or NETUI_CONTAINER}"
  user="${1:-root}"
  source="$user@$host"
  [[ -n "${NETUI_DEVICE:-}" ]] && out="$out/$NETUI_DEVICE"
  ctl="$(mktemp -u /tmp/netui-ssh.XXXXXX)"
  ssh_opts=(-o ControlMaster=auto -o ControlPath="$ctl" -o ControlPersist=30 -o BatchMode=yes)
  trap 'ssh "${ssh_opts[@]}" -O exit "$user@$host" 2>/dev/null || true' EXIT
  remote() { ssh "${ssh_opts[@]}" "$user@$host" "$@"; }
fi
mkdir -p "$out"

# Any string-valued field whose key looks like a credential.
redact='walk(if type == "object" then with_entries(
  if (.key | test("^(key[1-4]?|password|passwd|sae_password|auth_secret|acct_secret|psk|wpa_psk|secret|private_?key|preshared_?key|ubus_rpc_session)$"; "i"))
     and (.value | type == "string")
  then .value = "REDACTED" else . end) else . end)'

# Scan results list the neighbours' networks: keep the radio facts, replace
# names and BSSIDs with stable placeholders (locally administered MACs).
anonymize_scan='.results |= (to_entries | map(.value + {
  ssid: (if .value.ssid then "neighbor-\(.key)" else .value.ssid end),
  bssid: ("02:00:00:00:" + ((.key / 256 | floor) | tostring | if length < 2 then "0" + . else . end) + ":" + ((.key % 256) | tostring | if length < 2 then "0" + . else . end))
}))'

failed=()
record() { # record <file> <object> <method> [json-args]
  local file="$1" obj="$2" method="$3" args="${4:-{\}}"
  local json
  if json="$(remote ubus call "$obj" "$method" "'$args'" 2>&1)" && jq -e . >/dev/null 2>&1 <<<"$json"; then
    jq --sort-keys "$redact" <<<"$json" >"$out/$file.json"
    echo "  ok   $file"
  else
    echo "  FAIL $file: $json" >&2
    failed+=("$file")
  fi
}

echo "Recording from $source into $out"

remote cat /etc/openwrt_release >"$out/_openwrt_release.txt"
for obj in network.interface network.device iwinfo luci-rpc system uci session log luci luci.upnp luci.ddns luci.wireguard hostapd; do
  remote ubus -v list "$obj"
done >"$out/_ubus_list.txt"
echo "  ok   _openwrt_release.txt, _ubus_list.txt"

# Dashboard
record network.interface.dump network.interface dump
record network.device.status network.device status
record system.info system info
record system.board system board
record luci-rpc.getBoardJSON luci-rpc getBoardJSON

# Clients
record luci-rpc.getDHCPLeases luci-rpc getDHCPLeases
record luci-rpc.getHostHints luci-rpc getHostHints

# Radios: info + assoclist per device
record iwinfo.devices iwinfo devices
for dev in $(jq -r '.devices[]?' "$out/iwinfo.devices.json" 2>/dev/null); do
  record "iwinfo.info.$dev" iwinfo info "{\"device\":\"$dev\"}"
  record "iwinfo.assoclist.$dev" iwinfo assoclist "{\"device\":\"$dev\"}"
  record "iwinfo.scan.$dev" iwinfo scan "{\"device\":\"$dev\"}" &&
    jq "$anonymize_scan" "$out/iwinfo.scan.$dev.json" >"$out/.scan.tmp" && mv "$out/.scan.tmp" "$out/iwinfo.scan.$dev.json"
  record "iwinfo.survey.$dev" iwinfo survey "{\"device\":\"$dev\"}"
  record "iwinfo.freqlist.$dev" iwinfo freqlist "{\"device\":\"$dev\"}"
  record "iwinfo.txpowerlist.$dev" iwinfo txpowerlist "{\"device\":\"$dev\"}"
  record "iwinfo.countrylist.$dev" iwinfo countrylist "{\"device\":\"$dev\"}"
  # hostapd.<ifname> exists only while the AP is up.
  if remote ubus list "hostapd.$dev" >/dev/null 2>&1; then
    record "hostapd.$dev.get_status" "hostapd.$dev" get_status
    record "hostapd.$dev.get_clients" "hostapd.$dev" get_clients
  fi
done

# Networks / WiFi / Firewall
configs=(network wireless dhcp firewall system)
# No radios in the dev container, so no wireless config to read.
[[ -n "${NETUI_CONTAINER:-}${NETUI_VM:-}" ]] && configs=(network dhcp firewall system)
for cfg in "${configs[@]}"; do
  record "uci.get.$cfg" uci get "{\"config\":\"$cfg\"}"
done
record uci.changes uci changes

# Optional services: present only when the package is installed.
optional() { # optional <file> <object> <method> [json-args]
  if remote ubus list "$2" >/dev/null 2>&1; then record "$@"; else echo "  skip $1 (no $2)"; fi
}
for cfg in sqm upnpd ddns wifi_schedule; do
  if remote test -f "/etc/config/$cfg"; then record "uci.get.$cfg" uci get "{\"config\":\"$cfg\"}"; else echo "  skip uci.get.$cfg"; fi
done
optional luci.upnp.get_status luci.upnp get_status
optional luci.ddns.get_services_status luci.ddns get_services_status
optional luci.ddns.get_ddns_state luci.ddns get_ddns_state
optional luci.wireguard.getWgInstances luci.wireguard getWgInstances
optional luci.getTimezones luci getTimezones
optional luci.getLocaltime luci getLocaltime
optional luci.getUnixtime luci getUnixtime
optional luci.getConntrackList luci getConntrackList
optional log.read log read '{"lines":200,"stream":false,"oneshot":true}'

if ((${#failed[@]})); then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "Done. Review with: git diff -- test/fixtures/ubus"
