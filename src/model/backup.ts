// Reading a config backup (`sysupgrade -b`) in the browser before restoring
// it: what it would change, and where the router would be afterwards.

export interface BackupInfo {
  /** Packages with settings in the backup (files under etc/config/). */
  configs: string[];
  hostname?: string;
  /** The LAN address after a restore, without prefix; undefined for DHCP. */
  lanAddress?: string;
  /** netui's own files are in it (installed with keep.d support). */
  netui: boolean;
  /** rpcd logins (usernames) the router will have afterwards. */
  logins: string[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

async function gunzip(b: Blob): Promise<Uint8Array> {
  try {
    const raw = new Response(await b.arrayBuffer()).body!;
    return new Uint8Array(await new Response(raw.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  } catch {
    throw new BackupError('This is not a backup file: it is not gzip-compressed.');
  }
}

/** Regular files in a ustar/GNU tar archive (what busybox tar writes). */
export function untar(data: Uint8Array): Map<string, Uint8Array> {
  const dec = new TextDecoder();
  const text = (b: Uint8Array) => dec.decode(b).replace(/\0[\s\S]*$/, '');
  const files = new Map<string, Uint8Array>();
  let longName: string | undefined;
  for (let off = 0; off + 512 <= data.length; ) {
    const h = data.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const prefix = text(h.subarray(345, 500));
    let name = (prefix ? `${prefix}/` : '') + text(h.subarray(0, 100));
    const size = parseInt(text(h.subarray(124, 136)).trim() || '0', 8);
    if (Number.isNaN(size)) throw new BackupError('This is not a backup file: the archive is damaged.');
    const type = String.fromCharCode(h[156]!);
    const body = data.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = text(body);
      continue;
    }
    if (longName) [name, longName] = [longName, undefined];
    if (type === '0' || type === '\0') files.set(name.replace(/^\.?\//, ''), body);
  }
  return files;
}

/** Values of one option in UCI file syntax, from the sections matching `type` (and `name`). */
export function uciValues(conf: string, type: string, option: string, name?: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of conf.split('\n')) {
    const sec = /^\s*config\s+(\S+)(?:\s+['"]?([^'"\s]+)['"]?)?/.exec(line);
    if (sec) {
      inSection = sec[1] === type && (name === undefined || sec[2] === name);
      continue;
    }
    const opt = /^\s*(?:option|list)\s+(\S+)\s+(['"]?)(.*)\2\s*$/.exec(line);
    if (inSection && opt && opt[1] === option) out.push(opt[3]!);
  }
  return out;
}

export async function readBackup(file: Blob): Promise<BackupInfo> {
  const files = untar(await gunzip(file));
  const configs = [...files.keys()].filter((f) => /^etc\/config\/[^/]+$/.test(f)).map((f) => f.slice('etc/config/'.length));
  if (!configs.includes('network') || !configs.includes('system')) {
    throw new BackupError('This archive is not an OpenWrt settings backup: it has no network or system settings.');
  }
  const conf = (n: string) => new TextDecoder().decode(files.get(`etc/config/${n}`));
  const network = conf('network');
  const proto = uciValues(network, 'interface', 'proto', 'lan')[0];
  const ip = uciValues(network, 'interface', 'ipaddr', 'lan')[0];
  return {
    configs: configs.sort(),
    hostname: uciValues(conf('system'), 'system', 'hostname')[0],
    lanAddress: proto === 'static' && ip ? ip.split('/')[0] : undefined,
    netui: files.has('lib/upgrade/keep.d/netui'),
    logins: files.has('etc/config/rpcd') ? uciValues(conf('rpcd'), 'login', 'username') : [],
  };
}
