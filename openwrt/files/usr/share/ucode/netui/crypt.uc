// netui.crypt: password hashes for rpcd logins, made in ucode so a password
// never appears on a command line (`uhttpd -m <password>` puts it in the
// process list, readable by every local process while it runs).
//
// SHA-256-crypt ("$5$salt$hash", 5000 rounds), the scheme musl's crypt(3)
// checks when rpcd verifies a login. Needs ucode's digest module; hash()
// returns null without it, and callers fall back to `uhttpd -m`.
//
// Loaded with require('netui.crypt') (from /usr/share/ucode/netui/crypt.uc).

'use strict';

const ITOA = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let digest = null;
try {
	digest = require('digest');
}
catch (e) {
	digest = null;
}

// Binary SHA-256 of a (binary) string.
const H = (s) => hexdec(digest.sha256(s));

// `d` repeated and cut to `n` bytes.
function stretch(d, n) {
	let out = '';
	for (; n >= 32; n -= 32)
		out += d;
	return out + substr(d, 0, n);
}

function b64(b2, b1, b0, n) {
	let w = (b2 << 16) | (b1 << 8) | b0, out = '';
	for (; n > 0; n--) {
		out += substr(ITOA, w & 0x3f, 1);
		w >>= 6;
	}
	return out;
}

function sha256_crypt(password, salt) {
	const P = password, S = substr(salt, 0, 16), pl = length(P);
	const B = H(P + S + P);
	let a = P + S, n;
	for (n = pl; n > 32; n -= 32)
		a += B;
	a += substr(B, 0, n);
	for (n = pl; n > 0; n >>= 1)
		a += (n & 1) ? B : P;
	const A = H(a);

	let dp = '';
	for (let i = 0; i < pl; i++)
		dp += P;
	const Pp = stretch(H(dp), pl);
	let ds = '';
	for (let i = 0; i < 16 + ord(A, 0); i++)
		ds += S;
	const Sp = stretch(H(ds), length(S));

	let C = A;
	for (let i = 0; i < 5000; i++) {
		let c = (i & 1) ? Pp : C;
		if (i % 3)
			c += Sp;
		if (i % 7)
			c += Pp;
		c += (i & 1) ? C : Pp;
		C = H(c);
	}

	const o = (i) => ord(C, i);
	const enc = b64(o(0), o(10), o(20), 4) + b64(o(21), o(1), o(11), 4) + b64(o(12), o(22), o(2), 4) +
		b64(o(3), o(13), o(23), 4) + b64(o(24), o(4), o(14), 4) + b64(o(15), o(25), o(5), 4) +
		b64(o(6), o(16), o(26), 4) + b64(o(27), o(7), o(17), 4) + b64(o(18), o(28), o(8), 4) +
		b64(o(9), o(19), o(29), 4) + b64(0, o(31), o(30), 3);
	return `$5$${S}$${enc}`;
}

// A hash with a fresh random salt, or null without the digest module.
function hash(password) {
	if (!digest?.sha256 || type(password) != 'string')
		return null;
	const f = require('fs').open('/dev/urandom');
	const raw = f?.read(16);
	f?.close();
	if (length(raw ?? '') != 16)
		return null;
	let salt = '';
	for (let i = 0; i < 16; i++)
		salt += substr(ITOA, ord(raw, i) & 0x3f, 1);
	return sha256_crypt(password, salt);
}

return { hash, sha256_crypt, available: () => !!digest?.sha256 };
