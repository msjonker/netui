# netui: limits per device and per person (Clients > a device > Speed limit,
# People > Pause and Bedtime).
#
# fw4 sources this on every firewall start and reload, through the script
# include netui adds with the first limit or person
# (`config include 'netui_limits'`). It reads two section types from the
# firewall config, which fw4 itself ignores:
#
# netui_limit (mac, download and upload in Mbit/s): the bridge table "netui".
#   Frames the router sends to a device (its downloads) and receives from it
#   (its uploads) beyond the rate are dropped. Matching on the bridge by MAC
#   covers IPv4 and IPv6, devices behind access points (they bridge), and
#   still holds with software flow offloading; hardware offloading bypasses
#   it.
#
# netui_person (name, list mac, paused, paused_until, bedtime, list bed_day,
#   bed_start, bed_stop): the inet table "netui". Its forward chain runs just
#   before fw4's, so it also stops connections that were already open; it
#   rejects what the person's devices send through the router (the internet,
#   other networks) while paused (until paused_until, epoch seconds, if set)
#   and during bedtime. The router itself (DHCP, DNS) and devices on the same
#   network stay reachable. Connections the flow offloader already took over
#   skip it until they close.
#
# Bedtime is in the router's time zone, a night per bed_day ("Mon" is the
# night from Monday into Tuesday). nft compares hours and days in UTC and does
# not move the day when it converts a local hour, so the windows are turned
# into UTC here with the current offset; after a daylight saving change they
# are an hour off until the next firewall reload (any apply, or a restart).
#
# Values come from UCI, which anyone with access can edit, so only MAC
# addresses and plain numbers reach nft.

TZ="$(cat /etc/TZ 2>/dev/null)" ucode -e '
const uci = require("uci").cursor();
const mac_re = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Mbit/s -> bytes per second; 0 for none.
const rate = (v) => match(v ?? "", /^[0-9]+(\.[0-9]+)?$/) && +v > 0 ? int(+v * 125000) : 0;
// A quarter second of burst keeps TCP from stalling at the limit.
const burst = (r) => r / 4 > 32768 ? int(r / 4) : 32768;
const down = [], up = [];
uci.foreach("firewall", "netui_limit", (s) => {
	if (s.enabled == "0" || !match(s.mac ?? "", mac_re))
		return;
	const mac = lc(s.mac), d = rate(s.download), u = rate(s.upload);
	if (d)
		push(down, `ether daddr ${mac} limit rate over ${d} bytes/second burst ${burst(d)} bytes drop`);
	if (u)
		push(up, `ether saddr ${mac} limit rate over ${u} bytes/second burst ${burst(u)} bytes drop`);
});

const now = time();
// Minutes east of UTC right now, from TZ (the router setting).
const offset = int((timegm(localtime(now)) - now) / 60);
const minutes = (v) => {
	const m = match(v ?? "", /^([0-9]{1,2}):([0-9]{2})$/);
	return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
};
const hhmm = (m) => sprintf("\"%02d:%02d\"", int(m / 60), m % 60);
const list = (v) => type(v) == "array" ? v : v == null ? [] : [ v ];

// [day, from, to) pieces in UTC, day 0 = Sunday as nft counts, minutes of day.
function bedtime(s) {
	const start = minutes(s.bed_start), stop = minutes(s.bed_stop);
	if (start == null || stop == null || start == stop)
		return [];
	const length = (stop - start + 1440) % 1440;
	const out = [];
	for (let d in list(s.bed_day)) {
		const i = index(DAYS, lc(substr(d, 0, 3)));
		if (i < 0)
			continue;
		// Minutes of the week from Monday 00:00 UTC.
		let from = ((i * 1440 + start - offset) % 10080 + 10080) % 10080;
		let left = length;
		while (left > 0) {
			const day = int(from / 1440), at = from % 1440;
			const n = left < 1440 - at ? left : 1440 - at;
			push(out, [ (day + 1) % 7, at, at + n ]);
			left -= n;
			from = (from + n) % 10080;
		}
	}
	return out;
}

const blocks = [];
uci.foreach("firewall", "netui_person", (s) => {
	const macs = filter(list(s.mac), (m) => match(m, mac_re));
	if (!length(macs))
		return;
	const who = length(macs) > 1 ? `{ ${join(", ", map(macs, lc))} }` : lc(macs[0]);
	if (s.paused == "1") {
		const until = match(s.paused_until ?? "", /^[0-9]{1,12}$/) ? +s.paused_until : 0;
		if (!until)
			push(blocks, `ether saddr ${who} reject`);
		else if (until > now)
			push(blocks, `ether saddr ${who} meta time < ${until} reject`);
	}
	if (s.bedtime == "1")
		for (let p in bedtime(s))
			push(blocks, `ether saddr ${who} meta day ${p[0]}` +
				(p[1] > 0 ? ` meta hour >= ${hhmm(p[1])}` : "") +
				(p[2] < 1440 ? ` meta hour < ${hhmm(p[2])}` : "") + " reject");
});

print("add table bridge netui\ndelete table bridge netui\n");
if (length(down) || length(up)) {
	print("table bridge netui {\n");
	print("\tchain download {\n\t\ttype filter hook output priority 0; policy accept;\n");
	for (let r in down) print(`\t\t${r}\n`);
	print("\t}\n\tchain upload {\n\t\ttype filter hook input priority 0; policy accept;\n");
	for (let r in up) print(`\t\t${r}\n`);
	print("\t}\n}\n");
}
print("add table inet netui\ndelete table inet netui\n");
if (length(blocks)) {
	print("table inet netui {\n\tchain forward {\n\t\ttype filter hook forward priority filter - 1; policy accept;\n");
	for (let r in blocks) print(`\t\t${r}\n`);
	print("\t}\n}\n");
}
' | TZ=UTC0 nft -f -
