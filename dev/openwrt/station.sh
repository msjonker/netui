#!/bin/sh
# Waits for wifi.sh to move a radio in, then joins the dev SSID.
while :; do
  for d in /sys/class/net/*; do [ -d "$d/wireless" ] && iface="${d##*/}" && break 2; done
  sleep 1
done
echo "station: using $iface"
cat >/tmp/wpa.conf <<CONF
network={
  ssid="netui-dev"
  psk="netui-dev-pass"
}
CONF
ip link set "$iface" up
wpa_supplicant -B -i "$iface" -c /tmp/wpa.conf
exec udhcpc -f -i "$iface" -s /bin/true -x hostname:tablet -t 0 -A 5
