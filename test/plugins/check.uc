// netui's rpcd plugins under a real rpcd (test/plugins/run.sh, in an OpenWrt
// rootfs container): that each one loads, and that the calls the browser polls
// stay bounded however large the router's tables get. rpcd runs one call at a
// time, so an unbounded one stalls every other request, and one that takes it
// down signs every session out. Exit status 1 if any check fails.

'use strict';

import { connect } from 'ubus';
import { readfile, writefile, open, popen, lsdir, unlink } from 'fs';

let failed = 0;
function check(ok, name, detail) {
	printf('%s  %s%s\n', ok ? 'ok  ' : 'FAIL', name, detail != null ? ` (${detail})` : '');
	if (!ok)
		failed++;
}

function now() {
	const c = clock(true);
	return c[0] * 1000 + c[1] / 1000000;
}

function sh(cmd) {
	const p = popen(cmd);
	const out = p.read('all');
	p.close();
	return trim(out ?? '');
}

const conn = connect(null, 60);
function call(object, method, args) {
	const start = now();
	const r = conn.call(object, method, args ?? {});
	return { r, ms: int(now() - start) };
}

function rpcd_pid() {
	for (let d in lsdir('/proc'))
		if (match(d, /^[0-9]+$/) && match(readfile(`/proc/${d}/status`) ?? '', /^Name:\s+rpcd\n/))
			return +d;
	return null;
}

const pid = rpcd_pid();
check(pid != null, 'rpcd is running');

// --- Every plugin loads ------------------------------------------------------
// A plugin that fails to compile is silently missing from ubus.

for (let o in ['netui.devices', 'netui.traffic', 'netui.config', 'netui.history', 'netui.users', 'netui.packages',
	'netui.firmware', 'netui.services', 'netui.speedtest', 'netui.tailscale'])
	check(conn.list(o) != null, `${o} is registered`);

// --- Connection table --------------------------------------------------------

const conntrack = require('netui.conntrack');

function synth(path, n) {
	const lines = [];
	for (let i = 0; i < n; i++)
		push(lines, `ipv4     2 tcp      6 7440 ESTABLISHED src=192.168.1.${10 + i % 200} dst=203.0.113.${i % 250} sport=${30000 + i % 30000} dport=443 packets=${i} bytes=${i * 97} src=203.0.113.${i % 250} dst=203.0.113.250 sport=443 dport=${30000 + i % 30000} packets=${i} bytes=${i * 1500} [ASSURED] mark=0 zone=0 use=2\n`);
	writefile(path, join('', lines));
}

function whole_lines(text) {
	if (!length(text))
		return true;
	if (substr(text, -1) != '\n')
		return false;
	for (let l in split(substr(text, 0, -1), '\n'))
		if (substr(l, 0, 3) != 'ipv' || index(l, ' use=') < 0)
			return false;
	return true;
}

synth('/tmp/ct-big', 20000);
let fd = open('/tmp/ct-big');
let r = conntrack.read(fd, { max_bytes: 524288, time_ms: 60000 });
fd.close();
check(r.partial && length(r.text) <= 524288 && length(r.text) > 400000, 'a large table stops at the size limit',
	`${length(r.text)} of ${length(readfile('/tmp/ct-big'))} bytes`);
check(whole_lines(r.text), 'and sends whole lines only');

// A table that is slow to read (a busy kernel): 20 ms a chunk, 50 ms allowed.
fd = open('/tmp/ct-big');
const slow = { read: (n) => { const until = now() + 20; while (now() < until); return fd.read(n); } };
r = conntrack.read(slow, { max_bytes: 524288, time_ms: 50 });
fd.close();
check(r.partial && length(r.text) <= 5 * 65536 && whole_lines(r.text), 'it stops at the time limit, on a line end', `${length(r.text)} bytes`);

synth('/tmp/ct-small', 100);
fd = open('/tmp/ct-small');
r = conntrack.read(fd, { max_bytes: 524288, time_ms: 1000 });
fd.close();
check(!r.partial && r.text == readfile('/tmp/ct-small'), 'a small table comes whole');
unlink('/tmp/ct-big');
unlink('/tmp/ct-small');

let t = call('netui.traffic', 'connections');
check(type(t.r?.text) == 'string' && type(t.r?.partial) == 'bool', 'netui.traffic connections answers', `${t.ms} ms`);

// --- Many LAN hosts ----------------------------------------------------------
// Fake hosts as lease lines in this container's subnet; none of them exists,
// so each probe waits for ARP to give up (~3 s), as for a device that left.

const me = split(sh("ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1"), '\n')[0];
const base = join('.', slice(split(me, '.'), 0, 3));
const leases = [];
const HOSTS = 120;
for (let i = 10; i < 10 + HOSTS; i++)
	if (`${base}.${i}` != me)
		push(leases, sprintf('%d 02:4e:55:00:00:%02x %s.%d host-%d *\n', time() + 3600, i, base, i, i));
writefile('/tmp/dhcp.leases', join('', leases));

// Process count while discovery runs, from a sampler of our own.
const sampler = '/tmp/procs.max';
writefile(sampler, '0\n');
const sampler_pid = sh(`sh -c 'm=0; while :; do n=$(ls -d /proc/[0-9]* | wc -l); [ $n -gt $m ] && m=$n && echo $m > ${sampler}; done' >/dev/null 2>&1 & echo $!`);
const before = length(filter(lsdir('/proc'), (d) => match(d, /^[0-9]+$/)));

let slowest = 0, calls = 0, left = -1, last;
const deadline = now() + 120000;
while (now() < deadline) {
	t = call('netui.devices', 'discover');
	calls++;
	slowest = max(slowest, t.ms);
	last = t.r;
	left = t.r?.unchecked ?? -1;
	if (left == 0)
		break;
	sh('sleep 2');
}
sh(`kill ${sampler_pid}`);
const extra = +trim(readfile(sampler) ?? '0') - before;
check(type(last?.devices) == 'array', 'discover answers');
check(slowest < 1000, `discover answers quickly with ${HOSTS} hosts to probe`, `slowest of ${calls} calls ${slowest} ms`);
check(left == 0, 'and checks every host in the background', `${left} left`);
check(extra <= 60, 'probing at most 16 at a time', `${extra} extra processes at most`);

// --- An adopted device that does not answer --------------------------------

writefile('/etc/netui/devices.json', sprintf('%J', { devices: { '02:4e:55:00:00:01': {
	mac: '02:4e:55:00:00:01', name: 'Gone AP', ip: `${base}.250`, password: 'not-used', model: 'Example AP',
} } }));
let first = call('netui.devices', 'list');
check(first.r?.devices?.[0]?.online === false, 'list reports a device that does not answer as offline', `first call ${first.ms} ms`);
let worst = 0;
for (let i = 0; i < 3; i++) {
	sh('sleep 1');
	worst = max(worst, call('netui.devices', 'list').ms);
}
check(worst < 500, 'and later calls do not wait for it', `slowest ${worst} ms`);

check(call('netui.devices', 'batch', { mac: '02:4e:55:00:00:01', calls: [{ object: 'uci', method: 'set', args: {} }] }).r?.error == 'not allowed',
	'batch refuses writes');
const many = [];
for (let i = 0; i < 33; i++)
	push(many, { object: 'system', method: 'info' });
check(call('netui.devices', 'batch', { mac: '02:4e:55:00:00:01', calls: many }).r?.error == 'invalid calls', 'batch refuses more than 32 calls');
check(call('netui.devices', 'batch', { mac: '02:4e:55:00:00:99', calls: [{ object: 'system', method: 'info' }] }).r?.error == 'unknown device',
	'batch refuses an unknown device');
t = call('netui.devices', 'batch', { mac: '02:4e:55:00:00:01', calls: [{ object: 'system', method: 'info' }, { object: 'system', method: 'board' }] });
const single = call('netui.devices', 'call', { mac: '02:4e:55:00:00:01', object: 'system', method: 'info', args: {} });
check(type(t.r?.error) == 'string' && t.r.error == single.r?.error, 'batch to a device that does not answer fails as a whole, like call',
	`${t.r?.error}, ${t.ms} ms`);

// --- rpcd survived all of it -------------------------------------------------

check(rpcd_pid() == pid, 'rpcd never restarted');

printf('\n%s\n', failed ? `${failed} failed` : 'all passed');
exit(failed ? 1 : 0);
