#!/usr/bin/env bash
# Stress a router running netui (or netui-agent) for calls that block rpcd,
# grow its memory or start too many processes at once, and check that rpcd
# survives. Only for bench routers: it fills the connection table, adds fake
# DHCP lease lines (removed afterwards) and, unless --installed, swaps in this
# checkout's netui-traffic and netui-devices plugins until it ends (restarting
# rpcd, which signs everyone out).
#
#   scripts/stress.sh [options] <router-ip>
#
#   --ssh CMD          ssh command, run as: CMD root@<router> <command> (default: ssh)
#   --scp CMD          scp command (default: scp -O)
#   --installed        test the router's own plugins, not this checkout's
#   --luci             also time luci getConntrackList on the same table
#                      (informational; it can take rpcd down)
#   --connections N    connection table target (default 15000; at most 90% of
#                      the router's nf_conntrack_max)
#   --hosts N          fake LAN hosts for the client and discovery tests (default 200)
#   --from IP          local address to send the flood from
#   --only LIST        comma-separated: traffic,clients,discover,devices,agent
#
# Needs python3, jq and curl here; ucode with the ubus and uloop modules there.
# Exit status 1 if any check fails.

set -euo pipefail

SSH=ssh
SCP='scp -O'
INSTALLED=0
LUCI=0
CONNECTIONS=15000
HOSTS=200
FROM=''
ONLY='traffic,clients,discover,devices,agent'

while [ $# -gt 1 ]; do
	case "$1" in
	--ssh) SSH=$2; shift 2 ;;
	--scp) SCP=$2; shift 2 ;;
	--installed) INSTALLED=1; shift ;;
	--luci) LUCI=1; shift ;;
	--connections) CONNECTIONS=$2; shift 2 ;;
	--hosts) HOSTS=$2; shift 2 ;;
	--from) FROM=$2; shift 2 ;;
	--only) ONLY=$2; shift 2 ;;
	*) echo "unknown option $1" >&2; exit 2 ;;
	esac
done
[ $# -eq 1 ] || { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
HOST=$1

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
for t in python3 jq curl; do command -v $t >/dev/null || { echo "needs $t" >&2; exit 2; }; done

R() { $SSH "root@$HOST" "$@"; }
want() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

FAILED=0
REPORT=()
result() { # result PASS|FAIL|INFO|SKIP <test> <detail>
	[ "$1" = FAIL ] && FAILED=1
	REPORT+=("$(printf '%-4s  %-28s  %s' "$1" "$2" "$3")")
	printf '%-4s  %-28s  %s\n' "$1" "$2" "$3"
}
# Field of the "<kind> <json>" line from router.sh output.
field() { printf '%s\n' "$1" | sed -n "s/^$2 //p" | tail -1 | jq -r "$3"; }

RD=$(R 'mktemp -d /tmp/netui-stress.XXXXXX')
cleanup() {
	set +e
	echo "--- cleaning up"
	R "sh $RD/router.sh leases-remove" 2>/dev/null
	R "sh $RD/router.sh tracking-off" 2>/dev/null
	[ "$INSTALLED" = 1 ] || R "sh $RD/router.sh plugins-restore" 2>/dev/null
	R "rm -rf $RD"
}
trap cleanup EXIT

mkdir -p "${TMPDIR:-/tmp}/netui-stress-plugins.$$"
P="${TMPDIR:-/tmp}/netui-stress-plugins.$$"
cp "$REPO/openwrt/files/usr/share/rpcd/ucode/netui-traffic" "$REPO/openwrt/files/usr/share/rpcd/ucode/netui-devices" \
	"$REPO/openwrt/files/usr/share/ucode/netui/conntrack.uc" "$P/"
R "mkdir $RD/plugins"
$SCP -q "$HERE/stress/measure.uc" "$HERE/stress/router.sh" "root@$HOST:$RD/"
$SCP -q "$P"/* "root@$HOST:$RD/plugins/"
rm -rf "$P"

if [ "$INSTALLED" = 0 ]; then
	echo "--- installing this checkout's plugins (rpcd restarts)"
	R "sh $RD/router.sh plugins-install"
fi

out=$(R "sh $RD/router.sh info")
echo "--- $(field "$out" info '"\(.release), \(.cpu), \(.mem_kb / 1024 | floor) MB"')"
OBJECTS=$(field "$out" info .objects)
CT_MAX=$(field "$out" info .conntrack_max)
MEM_MB=$(field "$out" info '.mem_kb / 1024 | floor')
# Discovery may use this much memory: 20 MB, or 5% on a large router (whose
# free memory moves more than that on its own, with a full connection table).
MEM_SLACK=$((MEM_MB / 20 > 20 ? MEM_MB / 20 : 20))
BASE_AVAIL=$(field "$out" sample .min_avail_kb)
BASE_PROCS=$(field "$out" sample .max_procs)
has() { case " $OBJECTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# The verdict on one measured call: rpcd alive and not restarted, the call
# inside its limit, and nobody else kept waiting long.
check_call() { # check_call <test> <out> <max-ms> <max-wait-ms> <extra detail>
	local name=$1 o=$2 max=$3 wait=$4 extra=${5:-}
	local ok ms pids lat rss avail
	ok=$(field "$o" call .ok)
	ms=$(field "$o" call .ms)
	pids=$(field "$o" sample '.rpcd_pids | length')
	lat=$(field "$o" latency .max_ms)
	rss=$(field "$o" sample .max_rpcd_kb)
	avail=$(field "$o" sample .min_avail_kb)
	local detail="${ms} ms, others waited ${lat} ms, rpcd ${rss} KB, free $((avail / 1024)) MB${extra:+, $extra}"
	if [ "$ok" != true ]; then
		result FAIL "$name" "call failed ($(field "$o" call .error)); $detail"
	elif [ "$pids" != 1 ]; then
		result FAIL "$name" "rpcd restarted; $detail"
	elif [ "$ms" -gt "$max" ] || [ "$lat" -gt "$wait" ]; then
		result FAIL "$name" "over ${max} ms / ${wait} ms; $detail"
	else
		result PASS "$name" "$detail"
	fi
}

# --- Connection table -------------------------------------------------------

conntrack_count() { R 'cat /proc/sys/net/netfilter/nf_conntrack_count'; }

if want traffic; then
	target=$((CT_MAX * 9 / 10))
	[ "$target" -gt "$CONNECTIONS" ] && target=$CONNECTIONS
	echo "--- filling the connection table to ~$target"
	R "sh $RD/router.sh tracking-on"
	for _ in 1 2 3 4; do
		n=$(conntrack_count)
		[ "$n" -ge $((target * 9 / 10)) ] && break
		python3 -I "$HERE/stress/flood.py" "$HOST" $(((target - n) * 13 / 10)) $FROM
	done
	n=$(conntrack_count)
	echo "--- $n connections tracked"
	# How many flows a router takes in depends on its speed; a few thousand is
	# enough to test with. Next to none means the flood went somewhere else.
	if [ "$n" -lt 1000 ]; then
		result FAIL "traffic: fill the table" "only $n connections tracked (flood from the right interface? --from)"
	elif [ "$n" -lt $((target / 2)) ]; then
		result INFO "traffic: fill the table" "$n of ~$target connections (the router took no more)"
	fi
	if has netui.traffic; then
		for round in 1 2; do
			o=$(R "sh $RD/router.sh measure netui.traffic connections '{}' 60")
			check_call "traffic: connections #$round" "$o" 2500 3000 \
				"$(field "$o" call '"\(.lines) of \(.total) lines\(if .partial then ", partial" else "" end), \(.bytes / 1024 | floor) KB"')"
		done
	else
		result SKIP "traffic: connections" "no netui.traffic on the router"
	fi
	if [ "$LUCI" = 1 ] && has luci; then
		o=$(R "sh $RD/router.sh measure luci getConntrackList '{}' 90")
		ok=$(field "$o" call .ok)
		result INFO "traffic: luci getConntrackList" "$n connections: ok=$ok, $(field "$o" call .ms) ms, $(field "$o" call '.bytes / 1024 | floor') KB, others waited $(field "$o" latency .max_ms) ms, rpcd $(field "$o" sample .max_rpcd_kb) KB, restarted=$(field "$o" sample '.rpcd_pids | length > 1')"
	fi
	R "sh $RD/router.sh tracking-off"
fi

# --- Many LAN hosts ---------------------------------------------------------

if want clients || want discover; then
	o=$(R "sh $RD/router.sh leases-add $HOSTS")
	added=$(field "$o" leases .added)
	echo "--- $added fake hosts in $(field "$o" leases '.subnet // .why')"
fi

if want clients && [ "${added:-0}" -gt 0 ]; then
	if has luci-rpc; then
		o=$(R "sh $RD/router.sh measure luci-rpc getDHCPLeases '{}' 60")
		check_call "clients: getDHCPLeases" "$o" 1500 2000 "$added fake hosts"
		o=$(R "sh $RD/router.sh measure luci-rpc getHostHints '{}' 60")
		check_call "clients: getHostHints" "$o" 1500 2000 "$added fake hosts"
	else
		result SKIP "clients" "no luci-rpc on the router"
	fi
fi

if want discover && [ "${added:-0}" -gt 0 ]; then
	if has netui.devices; then
		R 'rm -f /var/run/netui/discover.json'
		o=$(R "sh $RD/router.sh discover 180")
		calls=$(printf '%s\n' "$o" | sed -n 's/^call //p')
		n=$(printf '%s\n' "$calls" | wc -l)
		worst=$(printf '%s\n' "$calls" | jq -s 'map(.ms) | max')
		bad=$(printf '%s\n' "$calls" | jq -s 'map(select(.ok | not)) | length')
		left=$(printf '%s\n' "$calls" | jq -s 'last | .result.unchecked // .unchecked')
		procs=$(($(field "$o" sample .max_procs) - BASE_PROCS))
		drop=$(((BASE_AVAIL - $(field "$o" sample .min_avail_kb)) / 1024))
		lat=$(field "$o" latency .max_ms)
		pids=$(field "$o" sample '.rpcd_pids | length')
		detail="$n calls over $((n * 5)) s, slowest ${worst} ms, others waited ${lat} ms, +$procs processes, -$drop MB, $left unchecked at the end"
		if [ "$bad" != 0 ] || [ "$pids" != 1 ] || [ "$worst" -gt 1000 ] || [ "$lat" -gt 1500 ] || [ "$procs" -gt 60 ] || [ "$drop" -gt "$MEM_SLACK" ] || [ "$left" != 0 ]; then
			result FAIL "discover: $added hosts" "$detail"
		else
			result PASS "discover: $added hosts" "$detail"
		fi
	else
		result SKIP "discover" "no netui.devices on the router"
	fi
fi

if want clients || want discover; then R "sh $RD/router.sh leases-remove"; fi

# --- Adopted devices --------------------------------------------------------

if want devices; then
	if has netui.devices && R 'test -s /etc/netui/devices.json'; then
		R 'rm -f /var/run/netui/live.json'
		for round in 1 2 3; do
			o=$(R "sh $RD/router.sh measure netui.devices list '{}' 60")
			online=$(field "$o" call '[.result.devices[]? | .online] | map(tostring) | join(",")')
			# The first call probes addresses it has never seen; the rest answer from the background probe.
			if [ "$round" = 1 ]; then
				check_call "devices: list (first)" "$o" 4000 4500 "online: $online"
			else
				check_call "devices: list #$round" "$o" 500 1000 "online: $online"
			fi
			sleep 3
		done
	else
		result SKIP "devices" "no adopted devices on the router"
	fi
fi

# --- Unauthenticated calls (access points) ----------------------------------

if want agent; then
	if has netui.agent; then
		nonce=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
		R "sh $RD/router.sh watch 25" >"${TMPDIR:-/tmp}/netui-stress-watch.$$" &
		watch=$!
		sleep 2
		body() { printf '{"jsonrpc":"2.0","id":1,"method":"call","params":["00000000000000000000000000000000","netui.agent","%s",%s]}' "$1" "$2"; }
		for w in 1 2 3 4 5 6 7 8; do
			(
				end=$((SECONDS + 20))
				while [ $SECONDS -lt $end ]; do
					for m in info prove cert; do
						a='{}'; [ $m = info ] || a="{\"nonce\":\"$nonce\"}"
						curl -s -o /dev/null -m 10 -w '%{time_total} %{http_code}\n' -H 'Content-Type: application/json' \
							--data "$(body $m "$a")" "http://$HOST/ubus" || echo "10 000"
					done
				done
			) >"${TMPDIR:-/tmp}/netui-stress-agent.$$.$w" &
		done
		wait $(jobs -p | grep -v "^$watch$") 2>/dev/null || true
		wait $watch || true
		o=$(cat "${TMPDIR:-/tmp}/netui-stress-watch.$$")
		stats=$(cat "${TMPDIR:-/tmp}"/netui-stress-agent.$$.* | awk '{n++; if ($1 > m) m = $1; if ($2 != 200) e++} END {printf "%d %.0f %d", n, m * 1000, e}')
		rm -f "${TMPDIR:-/tmp}"/netui-stress-agent.$$.* "${TMPDIR:-/tmp}/netui-stress-watch.$$"
		read -r reqs worst errs <<<"$stats"
		lat=$(field "$o" latency .max_ms)
		pids=$(field "$o" sample '.rpcd_pids | length')
		detail="$reqs requests from 8 clients in 20 s, slowest ${worst} ms, $errs errors, others waited ${lat} ms, rpcd $(field "$o" sample .max_rpcd_kb) KB"
		if [ "$pids" != 1 ] || [ "$errs" != 0 ] || [ "$lat" -gt 3000 ]; then
			result FAIL "agent: unauthenticated" "$detail"
		else
			result PASS "agent: unauthenticated" "$detail"
		fi
	else
		result SKIP "agent" "no netui.agent on the router"
	fi
fi

echo
echo "=== $HOST"
printf '%s\n' "${REPORT[@]}"
exit $FAILED
