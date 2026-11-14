// Build a .tar.gz the way busybox tar does (ustar headers), for backup tests.

function header(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (s: string, off: number) => h.set(enc.encode(s), off);
  put(name, 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(size.toString(8).padStart(11, '0') + '\0', 124);
  put('00000000000\0', 136);
  put('        ', 148);
  h[156] = '0'.charCodeAt(0);
  put('ustar\0', 257);
  put('00', 263);
  const sum = h.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

export async function tarball(files: Record<string, string>): Promise<Blob> {
  const parts: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = new TextEncoder().encode(text);
    parts.push(header(name, body.length), body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((off, p) => (tar.set(p, off), off + p.length), 0);
  const gz = new Response(tar).body!.pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(gz).arrayBuffer()]);
}
