# netui: speed limits per device (Clients > a device > Speed limit).
#
# fw4 sources this on every firewall start and reload, through the script
# include netui adds with the first limit (`config include 'netui_limits'`).
# It turns the firewall config's netui_limit sections (mac, download and
# upload in Mbit/s) into the bridge table "netui": frames the router sends to
# a device (its downloads) and receives from it (its uploads) beyond the rate
# are dropped. Matching on the bridge by MAC covers IPv4 and IPv6, devices
# behind access points (they bridge), and still holds with software flow
# offloading; hardware offloading bypasses it.
#
# Values come from UCI, which anyone with access can edit, so only MAC
# addresses and plain numbers reach nft.

ucode -e '
const uci = require("uci").cursor();
const mac_re = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
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
print("add table bridge netui\ndelete table bridge netui\n");
if (length(down) || length(up)) {
	print("table bridge netui {\n");
	print("\tchain download {\n\t\ttype filter hook output priority 0; policy accept;\n");
	for (let r in down) print(`\t\t${r}\n`);
	print("\t}\n\tchain upload {\n\t\ttype filter hook input priority 0; policy accept;\n");
	for (let r in up) print(`\t\t${r}\n`);
	print("\t}\n}\n");
}
' | nft -f -
