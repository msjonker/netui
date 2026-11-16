// Demo mode (`vite build --mode demo`): netui runs against a simulated
// router in the browser, so it can be tried from a static web page. main.tsx
// imports this module only when import.meta.env.MODE is 'demo'; the
// production build drops the import, and with it everything in src/demo/.
//
// The simulation sits behind fetch(): /ubus and /cgi-bin/* never leave the
// page, so every netui code path above the transport is the real one.

import { render, h } from 'preact';
import { saveSession } from '../api/ubus';
import type { UciConfig } from '../api/types';
import { DemoRouter } from './router';
import { DemoBadge } from './DemoBadge';

interface RpcRequest {
  id: number;
  params: [string, string, string, Record<string, unknown>];
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installDemo(): void {
  const router = new DemoRouter();
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    const ubus = url.pathname === '/ubus';
    const cgi = url.pathname.startsWith('/cgi-bin/');
    if (!ubus && !cgi) return realFetch(input, init);

    // A little latency, so spinners and optimistic states behave as on a router.
    await pause(40 + Math.random() * 80);
    if (Date.now() < router.downUntil) throw new TypeError('Failed to fetch');

    if (cgi) return cgiResponse(router, url.pathname.slice('/cgi-bin/'.length), init?.body);

    const body = JSON.parse(String(init?.body ?? 'null')) as RpcRequest | RpcRequest[];
    const answer = (r: RpcRequest) => {
      const [sid, object, method, args] = r.params;
      return { jsonrpc: '2.0', id: r.id, result: router.call(sid, object, method, args ?? {}) };
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  };

  // Signed in from the start; signing out shows the login screen, where any password works.
  const { id, timeout } = router.autoLogin();
  saveSession({ id, username: 'netui', timeoutMs: timeout * 1000, expiresAt: Date.now() + timeout * 1000 });

  const host = document.createElement('div');
  document.body.append(host);
  render(h(DemoBadge, {}), host);

  (window as unknown as { netuiDemo: DemoRouter }).netuiDemo = router;
}

async function cgiResponse(router: DemoRouter, path: string, body: BodyInit | null | undefined): Promise<Response> {
  if (path === 'cgi-backup') {
    const tar = await backupArchive(router.configs());
    return new Response(tar, { headers: { 'Content-Type': 'application/x-targz' } });
  }
  if (path === 'cgi-upload' && body instanceof FormData) {
    const file = body.get('filedata');
    if (!(file instanceof Blob)) return new Response('Bad request', { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : new Uint8Array(32);
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    return Response.json({ size: bytes.length, checksum: hex.slice(0, 32), sha256sum: hex });
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------------------
// A real backup archive: /etc/config/* in UCI's file format, as a .tar.gz.

function uciFile(config: UciConfig): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  let out = '';
  for (const s of Object.values(config)) {
    out += `\nconfig ${s['.type']}${s['.anonymous'] ? '' : ` ${q(s['.name'])}`}\n`;
    for (const [k, v] of Object.entries(s)) {
      if (k.startsWith('.')) continue;
      if (Array.isArray(v)) for (const item of v) out += `\tlist ${k} ${q(String(item))}\n`;
      else out += `\toption ${k} ${q(String(v))}\n`;
    }
  }
  return out;
}

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (s: string, at: number, len: number) => header.set(enc.encode(s).slice(0, len), at);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o600, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(data.length, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const sum = header.reduce((a, b) => a + b, 0);
  put(octal(sum, 7) + ' ', 148, 8);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  padded.set(header);
  padded.set(data, 512);
  return padded;
}

async function backupArchive(configs: Record<string, UciConfig>): Promise<Blob> {
  const enc = new TextEncoder();
  const parts = Object.entries(configs).map(([name, c]) => tarEntry(`etc/config/${name}`, enc.encode(uciFile(c))));
  // As on a router with netui installed: its rpcd logins and the keep.d list that puts its files in backups.
  const login = (user: string, group: string) =>
    `\nconfig login\n\toption username '${user}'\n\toption password '$p$${user}'\n\tlist read '${group}'\n\tlist write '${group}'\n`;
  parts.push(tarEntry('etc/config/rpcd', enc.encode(login('netui', 'netui') + login('viewer', 'netui-viewer'))));
  parts.push(tarEntry('lib/upgrade/keep.d/netui', enc.encode('/www/netui/\n/etc/netui/\n')));
  const tar = new Blob([...parts, new Uint8Array(1024)].map((p) => p.slice().buffer as ArrayBuffer));
  return new Response(tar.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
