// Router side of scripts/stress.sh. Runs as root on the router (local ubus,
// no ACL). Every mode prints one JSON object.
//
//   ucode measure.uc call <object> <method> [json-args] [timeout-s]
//       time one ubus call: { ok, ms, bytes, error?, result? (small replies) }
//   ucode measure.uc sample <seconds> [file]
//       every 100 ms: MemAvailable, process count, rpcd's pid and size:
//       { min_avail_kb, max_procs, max_rpcd_kb, rpcd_pids }
//   ucode measure.uc latency <seconds> [file]
//       `uci configs` every 200 ms: how long any other caller waits behind a
//       slow call. It has to be an rpcd object (`system` is procd's, and
//       would not wait); everything through the web UI waits on rpcd anyway,
//       since uhttpd asks rpcd's session object before each call.
//       { calls, max_ms, failed }
//
// With a file, sample and latency also write their summary there on every
// tick, so they can be stopped at any time.

'use strict';

import { readfile, writefile, lsdir } from 'fs';
import * as ubus from 'ubus';
import * as uloop from 'uloop';

function now() {
	const c = clock(true);
	return c[0] * 1000 + c[1] / 1000000;
}

function avail_kb() {
	const m = match(readfile('/proc/meminfo') ?? '', /MemAvailable: +([0-9]+)/);
	return m ? +m[1] : null;
}

function rpcd() {
	for (let d in lsdir('/proc') ?? []) {
		if (!match(d, /^[0-9]+$/))
			continue;
		const st = readfile(`/proc/${d}/status`) ?? '';
		if (match(st, /^Name:\s+rpcd\n/)) {
			const kb = match(st, /VmRSS:\s+([0-9]+)/);
			return { pid: +d, kb: kb ? +kb[1] : 0 };
		}
	}
	return null;
}

function procs() {
	return length(filter(lsdir('/proc') ?? [], (d) => match(d, /^[0-9]+$/)));
}

function every(ms, seconds, tick) {
	uloop.init();
	const end = now() + seconds * 1000;
	let t;
	t = uloop.timer(1, function() {
		tick();
		if (now() < end)
			t.set(ms);
		else
			uloop.end();
	});
	uloop.run();
}

const mode = ARGV[0];

if (mode == 'call') {
	const timeout = +(ARGV[4] ?? 60);
	const conn = ubus.connect(null, timeout);
	const args = ARGV[3] ? json(ARGV[3]) : {};
	const start = now();
	const r = conn.call(ARGV[1], ARGV[2], args);
	const ms = now() - start;
	const out = { ok: r != null, ms: int(ms), bytes: r != null ? length(sprintf('%J', r)) : 0 };
	if (r == null)
		out.error = ubus.error();
	else if (out.bytes < 4096)
		out.result = r;
	if (type(r) == 'object')
		for (let k in ['total', 'partial', 'unchecked', 'scanning'])
			if (exists(r, k))
				out[k] = r[k];
	if (type(r?.rows) == 'array')
		out.rows = length(r.rows);
	if (type(r?.text) == 'string')
		out.lines = length(split(r.text, '\n')) - 1;
	printf('%J\n', out);
}
else if (mode == 'sample') {
	const out = { min_avail_kb: null, max_procs: 0, max_rpcd_kb: 0, rpcd_pids: [] };
	const file = ARGV[2];
	every(100, +ARGV[1], () => {
		const a = avail_kb(), p = procs(), r = rpcd();
		if (a != null && (out.min_avail_kb == null || a < out.min_avail_kb))
			out.min_avail_kb = a;
		if (p > out.max_procs)
			out.max_procs = p;
		if (r) {
			if (r.kb > out.max_rpcd_kb)
				out.max_rpcd_kb = r.kb;
			if (index(out.rpcd_pids, r.pid) < 0)
				push(out.rpcd_pids, r.pid);
		}
		if (file)
			writefile(file, sprintf('%J\n', out));
	});
	printf('%J\n', out);
}
else if (mode == 'latency') {
	const out = { calls: 0, max_ms: 0, failed: 0 };
	const file = ARGV[2];
	const conn = ubus.connect(null, 60);
	every(200, +ARGV[1], () => {
		const start = now();
		const r = conn.call('uci', 'configs', {});
		const ms = int(now() - start);
		out.calls++;
		if (r == null)
			out.failed++;
		if (ms > out.max_ms)
			out.max_ms = ms;
		if (file)
			writefile(file, sprintf('%J\n', out));
	});
	printf('%J\n', out);
}
else {
	warn('usage: ucode measure.uc call|sample|latency ...\n');
	exit(2);
}
