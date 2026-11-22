#!/bin/sh
# Router side of scripts/stress.sh (busybox ash). Lives in a temp dir with
# measure.uc and plugins/; every command prints "<kind> <json>" lines.
#
#   router.sh info
#   router.sh measure <object> <method> [json-args] [timeout-s]
#   router.sh watch <seconds>                 load while something else runs
#   router.sh discover <max-seconds>          netui.devices discover every 5 s
#   router.sh leases-add <n> | leases-remove  fake LAN hosts (lease lines only)
#   router.sh tracking-on | tracking-off      make sure the kernel tracks connections
#   router.sh plugins-install | plugins-restore

cd "$(dirname "$0")" || exit 1

LEASES=/tmp/dhcp.leases
# Fake hosts are only ever lease lines, never neighbour entries: a permanent
# neighbour entry on an address in use takes that host off the network.
FAKE=netui-stress-

bg_start() {
	rm -f s.json l.json
	ucode measure.uc sample 900 s.json </dev/null >/dev/null 2>&1 &
	echo $! >s.pid
	ucode measure.uc latency 900 l.json </dev/null >/dev/null 2>&1 &
	echo $! >l.pid
	sleep 1
}

bg_stop() {
	# rpcd is free again, so a latency call in flight returns at once.
	sleep 1
	kill "$(cat s.pid)" "$(cat l.pid)" 2>/dev/null
	echo "sample $(cat s.json 2>/dev/null)"
	echo "latency $(cat l.json 2>/dev/null)"
}

case "$1" in
info)
	. /etc/openwrt_release
	echo "info {\"release\": \"$DISTRIB_DESCRIPTION\", \"cpu\": \"$(grep -m1 -E 'cpu model|model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')\", \"mem_kb\": $(awk '/MemTotal/ {print $2}' /proc/meminfo), \"conntrack_max\": $(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 0), \"objects\": \"$(ubus list | grep -E '^(netui\.|luci-rpc$|luci$)' | tr '\n' ' ')\"}"
	ucode measure.uc sample 2 s.json >/dev/null
	echo "sample $(cat s.json)"
	;;
measure)
	shift
	bg_start
	echo "call $(ucode measure.uc call "$@")"
	bg_stop
	;;
watch)
	bg_start
	sleep "$2"
	bg_stop
	;;
discover)
	bg_start
	end=$(($(date +%s) + $2))
	while :; do
		r=$(ucode measure.uc call netui.devices discover '{}' 30)
		echo "call $r"
		case "$r" in *'"unchecked": 0,'* | *'"unchecked": 0 '*) break ;; esac
		[ "$(date +%s)" -ge "$end" ] && break
		sleep 5
	done
	bg_stop
	;;
leases-add)
	st=$(ubus call network.interface.lan status 2>/dev/null)
	addr=$(echo "$st" | jsonfilter -e '@["ipv4-address"][0].address')
	mask=$(echo "$st" | jsonfilter -e '@["ipv4-address"][0].mask')
	if [ -z "$addr" ] || [ "$mask" -gt 24 ]; then
		echo "leases {\"added\": 0, \"why\": \"no LAN of /24 or larger\"}"
		exit 0
	fi
	base=${addr%.*}
	used=" $(ip -4 neigh | cut -d' ' -f1 | tr '\n' ' ') $(cut -d' ' -f3 $LEASES 2>/dev/null | tr '\n' ' ') $(ip -4 -o addr | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ') "
	exp=$(($(date +%s) + 3600))
	n=0
	for i in $(seq 2 254); do
		[ "$n" -ge "$2" ] && break
		case "$used" in *" $base.$i "*) continue ;; esac
		echo "$exp 02:4e:55:00:00:$(printf %02x "$i") $base.$i $FAKE$i *" >>$LEASES
		n=$((n + 1))
	done
	echo "leases {\"added\": $n, \"subnet\": \"$base.0/24\"}"
	;;
leases-remove)
	# Only the fake lines: dnsmasq may have written real leases meanwhile.
	if [ -f $LEASES ]; then
		grep -v " $FAKE" $LEASES >leases.tmp
		cat leases.tmp >$LEASES
		rm -f leases.tmp
	fi
	;;
tracking-on)
	# The kernel only tracks connections while some firewall rule uses
	# conntrack; an access point with its firewall off has none. A table of
	# our own with an accepting chain and a counter on new connections.
	nft -f - <<-EOF
		table inet netui_stress {
			chain input { type filter hook input priority 0; policy accept; ct state new counter; }
		}
	EOF
	;;
tracking-off)
	nft delete table inet netui_stress 2>/dev/null
	;;
plugins-install)
	for f in rpcd/ucode/netui-traffic rpcd/ucode/netui-devices ucode/netui/conntrack.uc; do
		d=/usr/share/$f
		b=orig.$(basename "$f")
		if [ -f "$d" ]; then cp -p "$d" "$b"; else : >"$b.none"; fi
		mkdir -p "$(dirname "$d")"
		cp "plugins/$(basename "$f")" "$d"
	done
	/etc/init.d/rpcd restart
	sleep 2
	;;
plugins-restore)
	for f in rpcd/ucode/netui-traffic rpcd/ucode/netui-devices ucode/netui/conntrack.uc; do
		d=/usr/share/$f
		b=orig.$(basename "$f")
		if [ -f "$b" ]; then cp -p "$b" "$d"; elif [ -f "$b.none" ]; then rm -f "$d"; fi
	done
	# netui.devices was only here for the test: drop its probe state too.
	[ -f orig.netui-devices.none ] && rm -rf /var/run/netui/discover.* /var/run/netui/live.*
	/etc/init.d/rpcd restart
	sleep 2
	;;
*)
	echo "usage: router.sh info|measure|watch|discover|leases-add|leases-remove|plugins-install|plugins-restore" >&2
	exit 2
	;;
esac
