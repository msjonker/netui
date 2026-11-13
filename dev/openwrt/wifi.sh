#!/usr/bin/env bash
# Give the dev router two simulated radios and the station one.
#
# Needs `sudo modprobe mac80211_hwsim radios=3` on the host first. Only phys
# whose driver is mac80211_hwsim are touched; real WiFi hardware is ignored.
# Moving a phy between network namespaces needs root in the host namespace,
# so it runs in a short-lived privileged helper container.
#
# Radios fall back to the host when a container stops; re-run after router:up.
set -euo pipefail

router=netui-openwrt
station=netui-client-tablet
cd "$(dirname "$0")"

hwsim_phys() {
  for p in /sys/class/ieee80211/*; do
    [[ "$(readlink -f "$p/device/driver" 2>/dev/null)" == */mac80211_hwsim ]] && echo "${p##*/}"
  done | sort -V
}

mapfile -t phys < <(hwsim_phys)
if ((${#phys[@]} == 0)); then
  if docker exec "$router" sh -c 'ls /sys/class/ieee80211/ 2>/dev/null | grep -q .'; then
    echo "Radios already in the router."
  else
    echo "No mac80211_hwsim radios on the host. Run: sudo modprobe mac80211_hwsim radios=3" >&2
    exit 1
  fi
else
  if ((${#phys[@]} < 3)); then
    echo "Need 3 hwsim radios, found ${#phys[@]}. Run: sudo rmmod mac80211_hwsim; sudo modprobe mac80211_hwsim radios=3" >&2
    exit 1
  fi
  docker compose -f compose.yaml --profile wifi up -d --build station >/dev/null
  router_pid=$(docker inspect -f '{{.State.Pid}}' "$router")
  station_pid=$(docker inspect -f '{{.State.Pid}}' "$station")
  echo "Moving ${phys[0]} ${phys[1]} -> $router, ${phys[2]} -> $station"
  docker run --rm --privileged --net=host --pid=host alpine:3 sh -c "
    apk add -q --no-cache iw >/dev/null &&
    iw phy ${phys[0]} set netns $router_pid &&
    iw phy ${phys[1]} set netns $router_pid &&
    iw phy ${phys[2]} set netns $station_pid"
fi

# First time only: generate the wireless config and bring up a dual-band SSID.
docker exec "$router" sh -c '
  [ -s /etc/config/wireless ] && grep -q netui-dev /etc/config/wireless && { wifi up; exit 0; }
  rm -f /etc/config/wireless
  wifi config
  set -- $(uci show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-device$/\1/p")
  uci -q batch <<UCI
set wireless.$1.band=2g
set wireless.$1.channel=6
set wireless.$1.htmode=HT20
set wireless.$1.country=US
set wireless.$1.disabled=0
set wireless.$2.band=5g
set wireless.$2.channel=36
set wireless.$2.htmode=VHT80
set wireless.$2.country=US
set wireless.$2.disabled=0
set wireless.default_$1.ssid=netui-dev
set wireless.default_$1.encryption=psk2
set wireless.default_$1.key=netui-dev-pass
set wireless.default_$2.ssid=netui-dev
set wireless.default_$2.encryption=psk2
set wireless.default_$2.key=netui-dev-pass
UCI
  uci commit wireless
  wifi up
'
echo "WiFi up. Give the station ~15s to associate."
