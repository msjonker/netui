// netui.conntrack: read the kernel's connection table (/proc/net/nf_conntrack)
// as text, within a size and time budget, cut at a line end. Used by the
// netui.traffic plugin; a module of its own so tests can feed it synthetic
// tables.
//
//   read(fd, { max_bytes, time_ms }) -> { text, partial }
//
// The browser parses the text. Parsing in ucode cost 1.5 ms a line on a
// 560 MHz MIPS router (600 connections a second, while every other rpcd
// call waits); reading the text costs a tenth of that.
//
// Loaded with require('netui.conntrack') (from /usr/share/ucode/netui/conntrack.uc).

'use strict';

const CHUNK = 65536;

function now() {
	const c = clock(true);
	return c[0] * 1000 + c[1] / 1000000;
}

function read(fd, opts) {
	const max_bytes = opts?.max_bytes ?? 524288;
	const time_ms = opts?.time_ms ?? 1000;
	const start = now();
	const parts = [];
	let size = 0;
	let partial = false;
	for (let chunk = fd.read(CHUNK); length(chunk); chunk = fd.read(CHUNK)) {
		const room = max_bytes - size;
		if (length(chunk) > room || now() - start > time_ms) {
			push(parts, substr(chunk, 0, room));
			partial = true;
			break;
		}
		push(parts, chunk);
		size += length(chunk);
	}
	let text = join('', parts);
	// Only whole lines: a cut inside a number would read as a smaller one.
	if (partial)
		text = substr(text, 0, rindex(text, '\n') + 1);
	return { text, partial };
}

return { read };
