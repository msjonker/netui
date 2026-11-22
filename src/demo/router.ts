// The demo router: answers netui's ubus calls from memory. Live state
// (interfaces, WiFi, counters, clients) is derived from the committed UCI
// configs, so applying a change shows up the way it would on a router.
// Nothing here is reachable from the production build (see ./index.ts).

import { UbusStatus } from '../api/ubus';
import type {
  AddonKey,
  AssocStation,
  ConnectionsReply,
  DeviceStatus,
  DeviceStatusMap,
  FirmwareJob,
  IfaceAddress,
  InterfaceStatus,
  LogEntry,
  ManagedDevice,
  NetuiUser,
  PackagesJob,
  PendingDevice,
  SpeedTestResult,
  UciConfig,
  UciValue,
  WgInstances,
} from '../api/types';
import { ADDONS } from '../model/addons';
import { Status, UciStore } from './uci';
import { DemoHistory } from './history';
import {
  ADDON_CONFIG,
  AP_BOARD,
  AP_MAC,
  APP_PORTS,
  BOARD,
  CLIENTS,
  INSTALLED,
  ROUTER_MAC,
  VPN_PEERS,
  WAN,
  apNetwork,
  apWireless,
  AP_PORTS,
  initialConfigs,
  type Band,
  type DemoClient,
} from './data';
import { CONFIG_PACKAGES, maskConfig } from './configMask';
import timezones from '../../test/fixtures/ubus/dl-wrx36/plain/luci.getTimezones.json';
import countries from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.countrylist.phy0-ap0.json';
import freq5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.freqlist.phy0-ap0.json';
import freq2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.freqlist.phy1-ap0.json';
import power5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.txpowerlist.phy0-ap0.json';
import power2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.txpowerlist.phy1-ap0.json';
import survey5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy0-ap0.json';
import survey2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.survey.phy1-ap0.json';
import scan5 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.scan.phy0-ap0.json';
import scan2 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.scan.phy1-ap0.json';
import adblockOn from '../../test/fixtures/ubus/bench-v2/netui.services.adblock.blocking.json';
import adblockOff from '../../test/fixtures/ubus/bench-v2/netui.services.adblock.stopped.json';
import tailscaleFixture from '../../test/fixtures/ubus/dl-wrx36/plain/tailscale.status.json';
import mwanFixture from '../../test/fixtures/ubus/bench-v2/gateway.mwan3.status.json';

type Args = Record<string, unknown>;
type Handler = (args: Args, sid: string) => unknown;

const now = () => Date.now() / 1000;
const clone = <T>(v: T): T => structuredClone(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : []);
const upper = (mac: string) => mac.toUpperCase();
const ok = (code = 0) => ({ code });

/** A stable pseudo-random number in [0, 1) for a seed. */
function hash(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** How busy a client is right now, 0.15..1, smooth over time. */
function activity(t: number, seed: number): number {
  const slow = 0.5 + 0.5 * Math.sin(t / (40 + seed * 9) + seed);
  const fast = 0.6 + 0.4 * Math.sin(t / (6 + (seed % 5)) + seed * 1.7);
  const burst = hash(Math.floor(t / 15) + seed * 101) > 0.85 ? 1.6 : 1;
  return Math.min(1, 0.15 + 0.85 * slow * fast * burst);
}

function macPlus(mac: string, n: number): string {
  const b = mac.split(':').map((h) => parseInt(h, 16));
  b[5] = (b[5]! + n) & 0xff;
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

function cidr(v: string): IfaceAddress | undefined {
  const m = /^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/.exec(v.trim());
  return m ? { address: m[1]!, mask: Number(m[2] ?? 24) } : undefined;
}

function randomKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

// ---------------------------------------------------------------------------
// Timed jobs (package installs, firmware, speed test): a script of log lines
// that appear as time passes, then an exit code.

interface Job {
  started: number;
  steps: [at: number, line: string][];
  exit: number;
  done?: () => void;
}

/** Finish a job on time, as the router would, whether or not anyone polls it. */
function timed<T extends Job>(j: T): T {
  setTimeout(() => jobLog(j), ((j.steps.at(-1)?.[0] ?? 0) + 1) * 1000 + 50);
  return j;
}

function jobLog(j: Job): { log: string; running: boolean } {
  const t = now() - j.started;
  const lines = j.steps.filter(([at]) => at <= t).map(([, l]) => l);
  const running = t < (j.steps.at(-1)?.[0] ?? 0) + 1;
  if (!running && j.done) {
    const done = j.done;
    j.done = undefined;
    done();
  }
  return { log: lines.join('\n') + (lines.length ? '\n' : ''), running };
}

// ---------------------------------------------------------------------------

interface Wlan {
  ifname: string;
  radio: string;
  phy: string;
  band: Band;
  ssid: string;
  network: string;
  channel: number;
  htmode: string;
  bssid: string;
  encryption: string;
}

interface ClientState {
  rx: number;
  tx: number;
  joined: number;
  kickedUntil: number;
  online: boolean;
  /** rx + tx when the demo started. */
  base: number;
}

type PkgJob = Job & { meta: Omit<PackagesJob, 'running' | 'exit' | 'log' | 'started'> };
type FwJob = Job & { action: 'check' | 'upgrade'; version: string | null };

/** What the firmware and add-on plugins know, on the gateway or an access point. */
interface Node {
  installed: Record<AddonKey, boolean>;
  packagesJob: PkgJob | null;
  firmware: { installed: string; job: FwJob | null; checked: boolean };
  /** Overlay storage, MB. */
  storageMb: number;
  /** When it last started (Unix seconds). */
  boot: number;
  profile: string;
  /** Flash and restart: down for `seconds`, then `after` runs. */
  restart(seconds: number, after: () => void): void;
}

interface Ap {
  device: ManagedDevice;
  uci: UciStore;
  node: Node;
}

export class DemoRouter {
  private boot = now() - (3 * 86400 + 4 * 3600 + 17 * 60);
  private installed = { ...INSTALLED };
  private uci: UciStore;
  private history: DemoHistory;
  private sessions = new Map<string, { username: string; readOnly: boolean }>();
  private users: NetuiUser[] = [
    { username: 'netui', role: 'admin' },
    { username: 'viewer', role: 'viewer' },
  ];
  private last = now();
  private clients = new Map<string, ClientState>();
  private log: LogEntry[] = [];
  private logId = 1;
  private upnp = [
    { num: '1', proto: 'UDP', extport: 3074, intaddr: '192.168.1.103', intport: 3074, descr: 'Game voice chat', expires: 2400, host_hint: 'game-console' },
    { num: '2', proto: 'TCP', extport: 32400, intaddr: '192.168.1.102', intport: 32400, descr: 'Media server', expires: 0, host_hint: 'nas' },
  ];
  private aps: Ap[];
  private pending: PendingDevice[] = [
    { ip: '192.168.1.3', mac: '02:5e:00:53:30:00', hostname: 'OpenWrt', model: AP_BOARD.model, release: 'OpenWrt 25.12.6 r33311-981c978eff', agent: '0.3.0', adopted: false },
  ];
  private gw: Node = {
    installed: this.installed,
    packagesJob: null,
    firmware: { installed: BOARD.version, job: null, checked: false },
    storageMb: 96,
    boot: 0, // unused: the gateway's is this.boot
    profile: `example_ax3000 (${BOARD.board_name})`,
    restart: (seconds, after) => this.restart(seconds, after),
  };
  private speed: { job: Job | null; history: SpeedTestResult[] } = {
    job: null,
    history: [{ at: Math.floor(now() - 86400 * 2), download: 912_400_000, upload: 41_800_000, ping: 9.8, jitter: 1.2, server: 'Example City' }],
  };
  private tailscale = { up: false };
  /** When each outgoing WireGuard tunnel was first seen, for its handshake and counters. */
  private tunnelUp: Record<string, number> = {};
  private adblockBusyUntil = 0;
  /** The router is "restarting" until this time; calls fail like a dropped connection. */
  downUntil = 0;

  constructor() {
    this.uci = new UciStore(initialConfigs(), (c) => this.configInstalled(c), (configs) => this.committed(configs));
    this.history = new DemoHistory(this.uci);
    const t = now();
    for (const c of CLIENTS) {
      const age = (t - this.boot) * (0.25 + 0.5 * hash(c.host));
      const rx = (c.down * age * 0.2) / 8;
      const tx = (c.up * age * 0.2) / 8;
      this.clients.set(c.mac, { rx, tx, joined: t - age, kickedUntil: 0, online: true, base: rx + tx });
    }
    this.aps = [
      {
        device: {
          mac: AP_MAC,
          name: 'Office AP',
          model: AP_BOARD.model,
          board_name: AP_BOARD.board_name,
          ip: '192.168.1.2',
          online: true,
          hostname: 'office-ap',
          release: `OpenWrt ${BOARD.version} ${BOARD.revision}`,
          agent: '0.3.0',
          adopted_at: Math.floor(this.boot - 86400 * 9),
        },
        uci: new UciStore({ wireless: apWireless(), network: apNetwork(true) }, () => true),
        node: this.apNode(() => this.aps[0]!),
      },
    ];
    this.seedLog();
  }

  // -------------------------------------------------------------------------
  // Dispatch

  /** One JSON-RPC call: [status, data?]. */
  call(sid: string, object: string, method: string, args: Args): [number, unknown?] {
    const r = this.dispatch(sid, object, method, args);
    if (r[0] !== 0 && object !== 'session') console.debug(`[demo] ${object}.${method} -> status ${r[0]}`, args);
    return r;
  }

  private dispatch(sid: string, object: string, method: string, args: Args): [number, unknown?] {
    this.advance();
    if (object === 'session' && method === 'login') return this.login(args);
    const session = this.sessions.get(sid);
    if (object === 'session' && method === 'access') {
      if (!session) return [UbusStatus.PERMISSION_DENIED];
      return [0, args.function ? { access: !session.readOnly || !WRITES.has(`${args.object}.${args.function}`) } : {}];
    }
    if (!session) return [UbusStatus.PERMISSION_DENIED];
    if (object === 'session' && method === 'destroy') {
      this.sessions.delete(sid);
      return [0];
    }
    if (session.readOnly && WRITES.has(`${object}.${method}`)) return [UbusStatus.PERMISSION_DENIED];
    const handler = this.handler(object, method);
    if (!handler) return [UbusStatus.NOT_FOUND];
    try {
      const data = handler(args, sid);
      return data === undefined ? [0] : [0, data];
    } catch (e) {
      if (e instanceof Status) return [e.code];
      console.error('demo router', object, method, e);
      return [UbusStatus.UNKNOWN_ERROR];
    }
  }

  private handler(object: string, method: string): Handler | undefined {
    if (object.startsWith('hostapd.') && method === 'del_client') {
      return (a) => this.kick(String(a.addr ?? ''));
    }
    return this.table()[`${object}.${method}`];
  }

  private login(args: Args): [number, unknown?] {
    const username = str(args.username) || 'netui';
    const user = this.users.find((u) => u.username === username);
    if (!user || !str(args.password)) return [UbusStatus.PERMISSION_DENIED];
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    this.sessions.set(id, { username, readOnly: user.role === 'viewer' });
    return [0, { ubus_rpc_session: id, timeout: 3600, expires: 3600, acls: {}, data: { username } }];
  }

  /** A session made without the login screen, so visitors land on the dashboard. */
  autoLogin(): { id: string; timeout: number } {
    const [, data] = this.login({ username: 'netui', password: 'demo' });
    return { id: (data as { ubus_rpc_session: string }).ubus_rpc_session, timeout: 3600 };
  }

  /** The committed configs, for a backup archive. */
  configs(): Record<string, UciConfig> {
    return Object.fromEntries(this.uci.names().map((c) => [c, this.uci.committed(c)]));
  }

  /** Restart: every session is gone, like rpcd's in-memory sessions. */
  private restart(seconds: number, after?: () => void): void {
    this.downUntil = Date.now() + seconds * 1000;
    setTimeout(() => {
      this.sessions.clear();
      after?.();
      this.boot = now();
      this.ifaceSince.clear();
      this.ifacesSeeded = false;
      for (const s of this.clients.values()) s.joined = now() + 20 + Math.random() * 30;
      this.addLog(0, `[    0.000000] Linux version ${BOARD.kernel} (builder@buildhost) #0 SMP`, 6);
      this.addLog(1, "netifd: Interface 'wan' is now up");
    }, 2_000);
  }

  // -------------------------------------------------------------------------
  // Add-ons

  private addonOfConfig(config: string): AddonKey | undefined {
    return (Object.keys(ADDON_CONFIG) as AddonKey[]).find((k) => ADDON_CONFIG[k] === config);
  }

  private configInstalled(config: string): boolean {
    const addon = this.addonOfConfig(config);
    return !addon || this.installed[addon];
  }

  // -------------------------------------------------------------------------
  // Live state

  private wlans(wireless = this.uci.committed('wireless'), mac = ROUTER_MAC): Wlan[] {
    const out: Wlan[] = [];
    const radios = Object.values(wireless).filter((s) => s['.type'] === 'wifi-device');
    radios.forEach((r, i) => {
      if (str(r.disabled) === '1') return;
      const band = (str(r.band) ?? '2g') as Band;
      const ch = Number(str(r.channel)) || (band === '5g' ? 36 : 6);
      // netifd numbers each mode on its own: phy0-ap0, phy0-ap1, phy0-mesh0.
      const count: Record<string, number> = {};
      for (const s of Object.values(wireless)) {
        if (s['.type'] !== 'wifi-iface' || str(s.device) !== r['.name'] || str(s.disabled) === '1') continue;
        const kind = (str(s.mode) ?? 'ap') === 'mesh' ? 'mesh' : 'ap';
        const k = (count[kind] = (count[kind] ?? -1) + 1);
        const ifname = `phy${i}-${kind}${k}`;
        out.push({
          ifname,
          radio: r['.name'],
          phy: `phy${i}`,
          band,
          ssid: str(s.ssid) ?? (str(s.mesh_id) || 'OpenWrt'),
          network: list(s.network)[0] ?? 'lan',
          channel: ch,
          htmode: str(r.htmode) ?? 'HE20',
          bssid: macPlus(mac, 0x10 * (i + 1) + k + (kind === 'mesh' ? 8 : 0)),
          encryption: str(s.encryption) ?? 'none',
        });
      }
    });
    return out;
  }

  private blocked(mac: string): boolean {
    return Object.values(this.uci.committed('firewall')).some(
      (s) => s['.type'] === 'rule' && str(s.enabled) !== '0' && list(s.src_mac).some((m) => m.toLowerCase() === mac) && str(s.target) !== 'ACCEPT',
    );
  }

  /** Where a client is attached right now, if anywhere. */
  private where(c: DemoClient, t = now()): { wlan?: Wlan; ap?: Ap; port?: string } | undefined {
    const s = this.clients.get(c.mac)!;
    if (t < s.kickedUntil || t < s.joined) return undefined;
    if (c.cycle && (t - this.boot) % 600 > c.cycle) return undefined;
    if ('wired' in c.link) return { port: c.link.wired };
    const { band, ap: onAp } = c.link;
    if (onAp) {
      const ap = this.aps.find((a) => a.device.mac === AP_MAC && a.device.online);
      const wlan = ap && this.wlans(ap.uci.committed('wireless'), ap.device.mac).find((w) => w.band === band && w.network === c.net);
      return wlan ? { wlan, ap } : undefined;
    }
    const wlan = this.wlans().find((w) => w.band === band && w.network === c.net);
    return wlan ? { wlan } : undefined;
  }

  private ipOf(c: DemoClient): string {
    const fixed = Object.values(this.uci.committed('dhcp')).find(
      (s) => s['.type'] === 'host' && list(s.mac).some((m) => m.toLowerCase() === c.mac) && str(s.ip),
    );
    return str(fixed?.ip) ?? `192.168.${c.net === 'lan' ? 1 : 10}.${c.host}`;
  }

  /** Move the byte counters forward and log clients coming and going. */
  private advance(): void {
    const t = now();
    const dt = Math.min(t - this.last, 60);
    if (dt <= 0) return;
    this.last = t;
    for (const c of CLIENTS) {
      const s = this.clients.get(c.mac)!;
      const at = this.where(c, t);
      if (!!at !== s.online) {
        s.online = !!at;
        if (at?.wlan && !at.ap) {
          this.addLog(1, `hostapd: ${at.wlan.ifname}: AP-STA-CONNECTED ${c.mac} auth_alg=sae`, 30, t);
          this.addLog(1, `dnsmasq-dhcp[1]: DHCPACK(br-${c.net === 'lan' ? 'lan.1' : 'lan.10'}) ${this.ipOf(c)} ${c.mac} ${c.name}`, 30, t);
        } else if (!at && !('wired' in c.link) && !c.link.ap) {
          const w = this.wlans().find((x) => 'band' in c.link && x.band === c.link.band && x.network === c.net);
          if (w) this.addLog(1, `hostapd: ${w.ifname}: AP-STA-DISCONNECTED ${c.mac}`, 30, t);
          if (c.cycle) this.addLog(1, `dnsmasq-dhcp[1]: DHCPRELEASE(br-${c.net === 'lan' ? 'lan.1' : 'lan.10'}) ${this.ipOf(c)} ${c.mac}`, 30, t);
        }
      }
      if (!at || this.blocked(c.mac)) continue;
      const seed = c.host + (c.net === 'iot' ? 50 : 0);
      s.rx += (c.down * activity(t, seed) * dt) / 8;
      s.tx += (c.up * activity(t, seed + 3) * dt) / 8;
    }
  }

  private stats(rx: number, tx: number) {
    return {
      rx_bytes: Math.floor(rx),
      tx_bytes: Math.floor(tx),
      rx_packets: Math.floor(rx / 1100),
      tx_packets: Math.floor(tx / 1100),
      rx_errors: 0,
      tx_errors: 0,
      rx_dropped: Math.floor(rx / 9e7),
      tx_dropped: 0,
    };
  }

  /** Byte totals over the clients a filter picks: [received by clients, sent by clients]. */
  private sum(pick: (c: DemoClient, at: ReturnType<DemoRouter['where']>) => boolean): [number, number] {
    let rx = 0;
    let tx = 0;
    for (const c of CLIENTS) {
      if (!pick(c, this.where(c))) continue;
      const s = this.clients.get(c.mac)!;
      rx += s.rx;
      tx += s.tx;
    }
    return [rx, tx];
  }

  private deviceStatus(): DeviceStatusMap {
    const net = this.uci.committed('network');
    const out: DeviceStatusMap = {};
    const base = (type: string, devtype: string | undefined, mac: string, rx: number, tx: number, extra: Partial<DeviceStatus> = {}): DeviceStatus => ({
      type,
      ...(devtype ? { devtype } : {}),
      up: true,
      present: true,
      carrier: true,
      macaddr: mac,
      mtu: 1500,
      statistics: this.stats(rx, tx),
      ...extra,
    });
    const all = this.sum(() => true);
    out.wan = base('Network device', 'ethernet', macPlus(ROUTER_MAC, 1), all[0] * 1.03 + 4e8, all[1] * 1.05 + 9e7, { speed: '1000F' });
    const ports = ['lan1', 'lan2', 'lan3', 'lan4'];
    ports.forEach((p, i) => {
      const [rx, tx] = p === 'lan4' ? this.sum((_c, at) => !!at?.ap) : this.sum((c) => 'wired' in c.link && c.link.wired === p);
      const live = p === 'lan4' || CLIENTS.some((c) => 'wired' in c.link && c.link.wired === p);
      // From the port's side: what clients send arrives (rx), what they receive leaves (tx).
      out[p] = base('Network device', 'ethernet', macPlus(ROUTER_MAC, 2 + i), tx, rx, live ? { speed: p === 'lan2' ? '1000F' : '1000F' } : { carrier: false, speed: '-1' });
    });

    // Bridges and their VLANs, from the config.
    for (const d of Object.values(net)) {
      if (d['.type'] !== 'device' || str(d.type) !== 'bridge') continue;
      const name = str(d.name)!;
      const vlans = Object.values(net).filter((v) => v['.type'] === 'bridge-vlan' && str(v.device) === name);
      const members = [...list(d.ports), ...this.wlans().filter((w) => this.bridgeOf(w.network) === name).map((w) => w.ifname)];
      const [rx, tx] = this.sum((c) => c.net === 'lan' || c.net === 'iot');
      out[name] = base('bridge', 'bridge', ROUTER_MAC, tx, rx, {
        'bridge-members': members,
        'bridge-attributes': { vlan_filtering: vlans.length > 0 },
        ...(vlans.length
          ? {
              'bridge-vlans': vlans.map((v) => ({
                id: Number(str(v.vlan)),
                local: true,
                ports: list(v.ports).map((p) => {
                  const [port, flags = ''] = p.split(':');
                  return flags.includes('t') ? `${port}:t` : flags.includes('*') ? `${port}:*` : port!;
                }),
              })),
            }
          : {}),
      });
      for (const v of vlans) {
        const id = str(v.vlan)!;
        const netName = Object.values(net).find((i) => i['.type'] === 'interface' && str(i.device) === `${name}.${id}`)?.['.name'];
        const [vrx, vtx] = this.sum((c) => c.net === netName);
        out[`${name}.${id}`] = base('VLAN', 'vlan', ROUTER_MAC, vtx, vrx);
      }
    }
    for (const w of this.wlans()) {
      const [rx, tx] = this.sum((_c, at) => at?.wlan?.ifname === w.ifname && !at.ap);
      out[w.ifname] = base('Network device', 'wlan', w.bssid, tx, rx);
    }
    for (const s of Object.values(net)) {
      if (s['.type'] === 'interface' && str(s.proto) === 'wireguard' && str(s.disabled) !== '1') {
        const up = (now() - this.boot) * 900;
        out[s['.name']] = base('Network device', undefined, '', up * 0.4, up, { mtu: 1420 });
      }
    }
    out.lo = { type: 'Network device', up: true, present: true, carrier: true, mtu: 65536, statistics: this.stats(3e6, 3e6) };
    return out;
  }

  private bridgeOf(network: string): string | undefined {
    const dev = str(this.uci.committed('network')[network]?.device);
    return dev?.replace(/\.\d+$/, '');
  }

  /** When each interface came up: at boot, or when a change added or re-enabled it. */
  private ifaceSince = new Map<string, number>();
  private ifacesSeeded = false;

  private interfaces(): { interface: InterfaceStatus[] } {
    const out: InterfaceStatus[] = [];
    const seen = new Set<string>();
    for (const s of Object.values(this.uci.committed('network'))) {
      if (s['.type'] !== 'interface') continue;
      const name = s['.name'];
      const off = str(s.disabled) === '1' || str(s.auto) === '0';
      if (!off) {
        seen.add(name);
        if (!this.ifaceSince.has(name)) this.ifaceSince.set(name, this.ifacesSeeded ? now() : this.boot + 40);
      }
      const uptime = Math.floor(now() - (this.ifaceSince.get(name) ?? now()));
      const proto = str(s.proto) ?? 'none';
      const device = str(s.device);
      const i: InterfaceStatus = { interface: name, up: false, pending: false, available: true, proto, ...(device ? { device } : {}) };
      out.push(i);
      if (off) continue;
      if (proto === 'static') {
        const addrs = list(s.ipaddr)
          .map((a) => (a.includes('/') || !str(s.netmask) ? cidr(a) : cidr(`${a}/${maskBits(str(s.netmask)!)}`)))
          .filter((a): a is IfaceAddress => !!a);
        Object.assign(i, { up: true, uptime, l3_device: device, 'ipv4-address': addrs, route: [] });
        if (name === 'lan') {
          i['ipv6-prefix-assignment'] = [{ address: `${WAN.prefix6}`, mask: 60, 'local-address': { address: `${WAN.prefix6}1`, mask: 60 } }];
        }
      } else if (proto === 'dhcp' || proto === 'pppoe') {
        const l3 = proto === 'pppoe' ? `pppoe-${name}` : device;
        Object.assign(i, {
          up: true,
          uptime,
          l3_device: l3,
          'ipv4-address': [{ address: WAN.address, mask: 24 }],
          route: [{ target: '0.0.0.0', mask: 0, nexthop: WAN.gateway, source: `${WAN.address}/32` }],
          'dns-server': WAN.dns,
        });
      } else if (proto === 'dhcpv6') {
        Object.assign(i, {
          up: true,
          uptime,
          l3_device: device,
          'ipv6-address': [{ address: WAN.address6, mask: 64 }],
          'ipv6-prefix': [{ address: WAN.prefix6, mask: 56 }],
          route: [{ target: '::', mask: 0, nexthop: 'fe80::1', source: `${WAN.address6}/64` }],
          'dns-server': ['2001:db8:4a2::53'],
        });
      } else if (proto === 'wireguard') {
        const addrs = list(s.addresses).map(cidr).filter((a): a is IfaceAddress => !!a);
        Object.assign(i, { up: true, uptime, device: name, l3_device: name, 'ipv4-address': addrs, route: [] });
      } else if (name === 'loopback' || device === 'lo') {
        Object.assign(i, { up: true, uptime, l3_device: 'lo', 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }] });
      }
    }
    for (const name of this.ifaceSince.keys()) if (!seen.has(name)) this.ifaceSince.delete(name);
    this.ifacesSeeded = true;
    return { interface: out };
  }

  private stations(wlan: Wlan, ap?: Ap): AssocStation[] {
    const t = now();
    return CLIENTS.filter((c) => {
      const at = this.where(c, t);
      return at?.wlan?.ifname === wlan.ifname && at.ap === ap;
    }).map((c) => {
      const s = this.clients.get(c.mac)!;
      const signal = ('signal' in c.link ? c.link.signal : -60) + Math.round(Math.sin(t / 9 + c.host) * 2);
      const top = wlan.band === '5g' ? 1_201_000 : 172_100;
      const rate = Math.round(top * Math.min(1, Math.max(0.2, (signal + 90) / 40)));
      return {
        mac: upper(c.mac),
        signal,
        signal_avg: signal + 1,
        noise: -95,
        inactive: Math.floor(hash(t + c.host) * 2500),
        connected_time: Math.floor(t - Math.max(s.joined, s.kickedUntil, this.boot)),
        rx: { rate: Math.round(rate * 0.8), mcs: 9, '40mhz': wlan.band === '5g', short_gi: false, packets: Math.floor(s.tx / 900), bytes: Math.floor(s.tx) },
        tx: { rate, mcs: 11, '40mhz': wlan.band === '5g', short_gi: false, packets: Math.floor(s.rx / 1300), bytes: Math.floor(s.rx) },
      };
    });
  }

  private kick(addr: string): void {
    const c = CLIENTS.find((x) => x.mac === addr.toLowerCase());
    if (!c) throw new Status(UbusStatus.NOT_FOUND);
    const s = this.clients.get(c.mac)!;
    // Deauthenticated: it rejoins shortly and keeps its DHCP lease.
    s.kickedUntil = now() + 12;
  }

  private iwinfo(device: string, wlans = this.wlans(), wireless = this.uci.committed('wireless')) {
    const w = wlans.find((x) => x.ifname === device);
    const radioName = w?.radio ?? device;
    const radio = wireless[radioName];
    if (!w && radio?.['.type'] !== 'wifi-device') throw new Status(UbusStatus.NOT_FOUND);
    const band = (w?.band ?? str(radio?.band) ?? '2g') as Band;
    const index = Object.values(wireless).filter((s) => s['.type'] === 'wifi-device').findIndex((s) => s['.name'] === radioName);
    const channel = w?.channel ?? (Number(str(radio?.channel)) || (band === '5g' ? 36 : 6));
    const five = band === '5g';
    return {
      phy: `phy${index}`,
      ...(w ? { ssid: w.ssid, bssid: upper(w.bssid), mode: 'Master' } : {}),
      channel,
      frequency: five ? 5000 + channel * 5 : 2407 + channel * 5,
      band: five ? '5 GHz' : '2.4 GHz',
      txpower: five ? 23 : 20,
      noise: -95,
      quality_max: 70,
      country: str(radio?.country) ?? 'US',
      htmode: str(radio?.htmode) ?? (five ? 'HE80' : 'HE20'),
      htmodes: five ? ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80', 'HE160'] : ['HT20', 'HT40', 'HE20', 'HE40'],
      hwmodes: five ? ['n', 'ac', 'ax'] : ['b', 'g', 'n', 'ax'],
      encryption: w && w.encryption !== 'none' ? { enabled: true, description: w.encryption.startsWith('sae') ? 'mixed WPA2/WPA3 PSK/SAE (CCMP)' : 'WPA2 PSK (CCMP)' } : { enabled: false },
    };
  }

  private bandOf(device: string): Band {
    const w = this.wlans().find((x) => x.ifname === device);
    const radio = this.uci.committed('wireless')[w?.radio ?? device];
    return (w?.band ?? str(radio?.band) ?? '2g') as Band;
  }

  private leases() {
    const t = now();
    return {
      // A device that comes and goes releases its lease when it leaves, so it shows as offline.
      dhcp_leases: CLIENTS.filter((c) => this.clients.get(c.mac)!.joined < t && (!c.cycle || this.where(c, t)))
        .map((c) => ({
          expires: Math.floor(43200 - ((t + c.host * 997) % 43200)),
          hostname: c.name,
          ipaddr: this.ipOf(c),
          macaddr: upper(c.mac),
          duid: `01${c.mac.replace(/:/g, '')}`,
        })),
      dhcp6_leases: [],
    };
  }

  private hints() {
    const out: Record<string, { name?: string; ipaddrs: string[]; ip6addrs: string[] }> = {};
    // Addresses come from the neighbour table, which forgets devices that left.
    const t = now();
    for (const c of CLIENTS) out[upper(c.mac)] = { name: `${c.name}.lan`, ipaddrs: this.where(c, t) ? [this.ipOf(c)] : [], ip6addrs: [] };
    out[upper(ROUTER_MAC)] = { name: 'home-router.lan', ipaddrs: ['192.168.1.1'], ip6addrs: [] };
    out[upper(AP_MAC)] = { name: 'office-ap.lan', ipaddrs: ['192.168.1.2'], ip6addrs: [] };
    return out;
  }

  private conntrack(): ConnectionsReply {
    const t = now();
    const out: string[] = [];
    // As the kernel prints /proc/net/nf_conntrack; the router side sends it as is.
    const line = (proto: string, src: string, sport: number, dst: string, dport: number, bytes: number) => {
      const l4 = proto === 'tcp' ? 'tcp      6 7440 ESTABLISHED' : 'udp      17 59';
      const sent = Math.floor(bytes / 3);
      return `ipv4     2 ${l4} src=${src} dst=${dst} sport=${sport} dport=${dport} packets=${Math.floor(sent / 1100) + 1} bytes=${sent} src=${dst} dst=${src} sport=${dport} dport=${sport} packets=${Math.floor((bytes - sent) / 1100) + 1} bytes=${bytes - sent} [ASSURED] mark=0 zone=0 use=2`;
    };
    for (const c of CLIENTS) {
      if (!this.where(c, t) || this.blocked(c.mac)) continue;
      const s = this.clients.get(c.mac)!;
      // The client's connections carry all of its traffic, so per-client rates add up.
      const conns = c.apps.flatMap((app, i) => Array.from({ length: 1 + Math.floor(hash(c.host * 7 + i) * 4) }, (_, k) => ({ app, i, k, w: 0.2 + hash(c.host + i * 13 + k) })));
      const total = conns.reduce((a, x) => a + x.w, 0);
      c.apps.forEach((app, i) => {
        const [proto, port] = APP_PORTS[app]!;
        for (const { k, w } of conns.filter((x) => x.app === app)) {
          // Open connections carry what the client sent since the demo started, plus a little history.
          const share = ((s.rx + s.tx - s.base * 0.99) * w) / total;
          out.push(
            line(
              proto.toLowerCase(),
              this.ipOf(c),
              40000 + Math.floor(hash(c.host * 3 + k + i) * 20000),
              `${k % 2 ? '198.51.100' : '192.0.2'}.${10 + Math.floor(hash(c.host * 31 + i * 7 + k) * 200)}`,
              port,
              Math.floor(share),
            ),
          );
        }
      });
      out.push(line('udp', this.ipOf(c), 50000 + c.host, c.net === 'lan' ? '192.168.1.1' : '192.168.10.1', 53, 180));
    }
    return { total: out.length, partial: false, text: out.map((l) => `${l}\n`).join('') };
  }

  // -------------------------------------------------------------------------
  // Log

  private addLog(source: 0 | 1, msg: string, priority = source === 0 ? 6 : 30, t = now()): void {
    this.log.push({ id: this.logId++, msg, priority, source, time: Math.floor(t * 1000) });
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
  }

  private seedLog(): void {
    const b = this.boot;
    const lines: [number, 0 | 1, string, number?][] = [
      [0, 0, `[    0.000000] Linux version ${BOARD.kernel} (builder@buildhost) (aarch64-openwrt-linux-musl-gcc 14.3.0) #0 SMP`],
      [2, 0, '[    2.104411] br-lan: port 1(lan1) entered blocking state'],
      [14, 1, "netifd: Network device 'wan' link is up"],
      [15, 1, "netifd: Interface 'wan' is now up"],
      [16, 1, "netifd: Interface 'wan6' is now up"],
      [17, 1, "netifd: Interface 'wg0' is now up"],
      [18, 1, 'firewall: Reloading firewall due to ifup of wan (wan)'],
      [21, 1, 'hostapd: phy0-ap0: AP-ENABLED'],
      [21, 1, 'hostapd: phy1-ap0: AP-ENABLED'],
      [22, 1, 'hostapd: phy1-ap1: AP-ENABLED'],
    ];
    for (const [dt, src, msg, prio] of lines) this.addLog(src, msg, prio, b + dt);
    const t = now();
    const events: [number, string][] = [];
    for (const c of CLIENTS) {
      const s = this.clients.get(c.mac)!;
      const ip = this.ipOf(c);
      const bridge = c.net === 'lan' ? 'br-lan.1' : 'br-lan.10';
      // A renewal every 6 hours since it joined, and the join itself.
      for (let at = s.joined; at < t; at += 6 * 3600) events.push([at, `dnsmasq-dhcp[1]: DHCPACK(${bridge}) ${ip} ${c.mac} ${c.name}`]);
      if (!('wired' in c.link) && !c.link.ap) {
        const ifname = c.net === 'iot' ? 'phy1-ap1' : c.link.band === '5g' ? 'phy0-ap0' : 'phy1-ap0';
        events.push([s.joined - 1, `hostapd: ${ifname}: AP-STA-CONNECTED ${c.mac} auth_alg=sae`]);
      }
    }
    events.push([t - 5400, 'dropbear[2310]: Password auth succeeded for \'root\' from 192.168.1.101:51522']);
    events.push([t - 9000, `hostapd: phy0-ap0: AP-STA-POSSIBLE-PSK-MISMATCH 6a:20:b1:44:0e:93`]);
    events.sort((a, b) => a[0] - b[0]);
    for (const [at, msg] of events) this.addLog(1, msg, 30, at);
  }

  // -------------------------------------------------------------------------
  // Usage (nlbwmon)

  private nlbw(params: string[]): { code: number; stdout?: string; stderr?: string } {
    if (!this.installed.usage) throw new Status(UbusStatus.NOT_FOUND);
    if (params.includes('list')) {
      const d = new Date();
      const periods = [0, 1, 2].map((k) => {
        const p = new Date(d.getFullYear(), d.getMonth() - k, 1);
        return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-01`;
      });
      return { code: 0, stdout: periods.slice(1).join('\n') + '\n' };
    }
    const period = params[params.indexOf('-t') + 1];
    // A whole month for past periods, the month so far for the current one.
    const scale = params.includes('-t') ? 2 + 0.3 * hash(Number(period?.slice(5, 7) ?? 1)) : (new Date().getDate() / 30) * 2.2;
    const data: (string | number | null)[][] = [];
    for (const c of CLIENTS) {
      c.apps.forEach((app, i) => {
        const [proto, port] = APP_PORTS[app]!;
        const w = i === 0 ? 0.7 : 0.3 / (c.apps.length - 1 || 1);
        const rx = Math.floor((c.down / 8) * 86400 * 30 * 0.03 * scale * w);
        const tx = Math.floor((c.up / 8) * 86400 * 30 * 0.03 * scale * w);
        data.push([proto, port, c.mac, Math.floor(rx / 4e6) + 5, rx, Math.floor(rx / 1200), tx, Math.floor(tx / 1200), app]);
      });
    }
    return { code: 0, stdout: JSON.stringify({ columns: ['proto', 'port', 'mac', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts', 'layer7'], data }) };
  }

  // -------------------------------------------------------------------------
  // Diagnostics (busybox output)

  private diagnostic(command: string, params: string[]): { code: number; stdout?: string; stderr?: string } {
    const target = params.at(-1) ?? '';
    const ipOf = (host: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : host.endsWith('.invalid') ? null : `192.0.2.${10 + Math.floor(hash(host.length * 7 + host.charCodeAt(0)) * 200)}`);
    const ip = ipOf(target);
    const name = command.split('/').pop();
    if (name === 'ping') {
      if (!ip) return { code: 1, stderr: `ping: bad address '${target}'\n` };
      const n = Number(params[1]) || 4;
      const times = Array.from({ length: n }, (_, i) => 9 + hash(i + target.length) * 6);
      const lines = times.map((ms, i) => `64 bytes from ${ip}: seq=${i} ttl=57 time=${ms.toFixed(3)} ms`);
      const min = Math.min(...times);
      const max = Math.max(...times);
      const avg = times.reduce((a, b) => a + b, 0) / n;
      return {
        code: 0,
        stdout: `PING ${target} (${ip}): 56 data bytes\n${lines.join('\n')}\n\n--- ${target} ping statistics ---\n${n} packets transmitted, ${n} packets received, 0% packet loss\nround-trip min/avg/max = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)} ms\n`,
      };
    }
    if (name === 'nslookup') {
      if (!ip) return { code: 1, stdout: `Server:\t\t127.0.0.1\nAddress:\t127.0.0.1:53\n\n** server can't find ${target}: NXDOMAIN\n\n` };
      return { code: 0, stdout: `Server:\t\t127.0.0.1\nAddress:\t127.0.0.1:53\n\nNon-authoritative answer:\nName:\t${target}\nAddress: ${ip}\n\n` };
    }
    if (name === 'traceroute') {
      if (!ip) return { code: 1, stderr: `traceroute: bad address '${target}'\n` };
      const hops = [WAN.gateway, '198.51.100.17', '198.51.100.94', '192.0.2.201', '192.0.2.66', ip];
      const out = hops.map((h, i) => `${String(i + 1).padStart(2)}  ${h}  ${(1 + i * 2.4 + hash(i) * 2).toFixed(3)} ms`);
      return { code: 0, stdout: `traceroute to ${target} (${ip}), 20 hops max, 46 byte packets\n${out.join('\n')}\n` };
    }
    throw new Status(UbusStatus.NOT_FOUND);
  }

  // -------------------------------------------------------------------------
  // Firmware, packages, speed test

  private firmwareStatus(n: Node) {
    if (!n.installed.firmware) return { available: false, job: null, branches: null };
    const f = n.firmware;
    let job: FirmwareJob | null = null;
    if (f.job) {
      const { log, running } = jobLog(f.job);
      job = { action: f.job.action, version: f.job.version, started: Math.floor(f.job.started), running, exit: running ? null : f.job.exit, log };
    }
    return {
      available: true,
      installed: f.installed,
      job,
      branches: f.checked ? { current: '25.12', latest: { '23.05': '23.05.6', '24.10': '24.10.8', '25.12': NEXT_VERSION, SNAPSHOT: 'SNAPSHOT' } } : null,
    };
  }

  private owutHeader(n: Node, to: string): [number, string][] {
    return [
      [0, 'ASU-Server     https://sysupgrade.openwrt.org'],
      [0, 'Upstream       https://downloads.openwrt.org'],
      [1, `Target         ${BOARD.target}`],
      [1, `Profile        ${n.profile}`],
      [1, 'Package-arch   aarch64_generic'],
      [2, `Version-from   ${n.firmware.installed} ${BOARD.revision} (kernel ${BOARD.kernel})`],
      [2, `Version-to     ${to} r33402-5d1e0b7c9a (kernel 6.12.80)`],
    ];
  }

  private firmwareCheck(n: Node): { result: boolean } {
    const to = NEXT_VERSION;
    const current = n.firmware.installed === NEXT_VERSION;
    n.firmware.job = timed({
      action: 'check' as const,
      version: null,
      started: now(),
      exit: 0,
      steps: [
        ...this.owutHeader(n, to),
        ...(current
          ? ([[3, 'There are no changes, upgrade not necessary']] as [number, string][])
          : ([
              [3, '14 packages are out-of-date'],
              [3, "It is safe to proceed with an upgrade (re-run with '--verbose' for details)"],
            ] as [number, string][])),
      ],
      done: () => (n.firmware.checked = true),
    });
    return { result: true };
  }

  private firmwareUpgrade(n: Node, version: string): { result: boolean } {
    const steps: [number, string][] = [...this.owutHeader(n, version), [3, 'Status:   queued - 0 ahead of you'], [5, 'Status:   container_setup'], [7, 'Status:   validate_manifest']];
    for (let s = 10; s <= 20; s += 3) steps.push([s, 'Status:   building_image']);
    steps.push([22, 'Build succeeded'], [23, 'Download progress: 35%'], [24, 'Download progress: 80%'], [25, 'Download progress: 100%']);
    steps.push([26, 'Image saved to /tmp/firmware.bin'], [27, 'Installing /tmp/firmware.bin and rebooting...']);
    n.firmware.job = timed({
      action: 'upgrade' as const,
      version,
      started: now(),
      exit: 0,
      steps,
      done: () =>
        n.restart(45, () => {
          n.firmware = { installed: version, job: null, checked: false };
        }),
    });
    return { result: true };
  }

  private packagesStatus(n: Node) {
    const addons: Partial<Record<AddonKey, { installed: boolean }>> = {};
    for (const k of Object.keys(ADDONS) as AddonKey[]) addons[k] = { installed: n.installed[k] };
    let job: PackagesJob | null = null;
    if (n.packagesJob) {
      const { log, running } = jobLog(n.packagesJob);
      job = { ...n.packagesJob.meta, started: Math.floor(n.packagesJob.started), running, exit: running ? null : n.packagesJob.exit, log };
    }
    const used = (Object.keys(ADDONS) as AddonKey[]).filter((k) => n.installed[k]).reduce((a, k) => a + ADDONS[k].mb, 0);
    return { manager: 'apk', free: Math.floor((n.storageMb - used) * 1024), addons, job };
  }

  private packagesChange(n: Node, action: 'install' | 'remove', addon: AddonKey): { error?: string } {
    if (!(addon in ADDONS)) return { error: 'unknown add-on' };
    if (n.packagesJob && jobLog(n.packagesJob).running) return { error: 'Another install is still running.' };
    if (action === 'remove' && addon === 'mesh') return { error: 'The full WiFi package cannot be removed.' };
    const pkg = PACKAGE_NAMES[addon];
    const steps: [number, string][] =
      action === 'install'
        ? [
            [0, 'Refreshing the package lists'],
            [2, `Installing ${pkg}`],
            [3, `(1/1) Installing ${pkg}`],
            [4, 'OK: 52.4 MiB in 201 packages'],
            [5, 'Done'],
          ]
        : [
            [0, `Removing ${pkg}`],
            [2, `(1/1) Purging ${pkg}`],
            [3, 'Done'],
          ];
    n.packagesJob = timed({
      started: now(),
      steps,
      exit: 0,
      meta: { action, addon, packages: [pkg] },
      done: () => {
        n.installed[addon] = action === 'install';
      },
    });
    return {};
  }

  private speedStatus() {
    const j = this.speed.job;
    const running = j ? jobLog(j).running : false;
    return {
      available: this.installed.speedtest,
      tool: this.installed.speedtest ? 'librespeed' : null,
      running,
      started: running && j ? Math.floor(j.started) : null,
      error: null,
      history: this.speed.history,
    };
  }

  // -------------------------------------------------------------------------
  // Access points (netui.devices call)

  private apNode(self: () => Ap): Node {
    const installed = Object.fromEntries((Object.keys(ADDONS) as AddonKey[]).map((k) => [k, k === 'steering' || k === 'firmware'])) as Record<AddonKey, boolean>;
    const node: Node = {
      installed,
      packagesJob: null,
      firmware: { installed: BOARD.version, job: null, checked: false },
      storageMb: 26,
      boot: this.boot + 95,
      profile: `example_ax1800 (${AP_BOARD.board_name})`,
      restart: (seconds, after) => {
        self().device.online = false;
        setTimeout(() => {
          after();
          node.boot = now();
          self().device.online = true;
        }, seconds * 1000);
      },
    };
    return node;
  }

  private relay(args: Args): unknown {
    const ap = this.aps.find((a) => a.device.mac === str(args.mac));
    if (!ap) return { error: 'Unknown device' };
    if (!ap.device.online) return { error: 'The device did not answer', code: 4 };
    const object = str(args.object) ?? '';
    const method = str(args.method) ?? '';
    const a = (args.args ?? {}) as Args;
    const wireless = () => ap.uci.committed('wireless');
    const wlans = () => this.wlans(wireless(), ap.device.mac);
    const handlers: Record<string, () => unknown> = {
      'system.info': () => ({ ...this.systemInfo(), uptime: Math.floor(now() - ap.node.boot), memory: { total: 471_859_200, free: 301_989_888, available: 322_961_408, shared: 98_304, buffered: 0, cached: 30_408_704 } }),
      'system.board': () => ({
        hostname: ap.device.hostname,
        model: ap.device.model,
        board_name: ap.device.board_name,
        kernel: BOARD.kernel,
        system: 'ARMv8 Processor rev 4',
        release: {
          distribution: 'OpenWrt',
          version: ap.node.firmware.installed,
          revision: BOARD.revision,
          target: BOARD.target,
          description: `OpenWrt ${ap.node.firmware.installed} ${BOARD.revision}`,
        },
      }),
      'system.reboot': () => {
        ap.node.restart(40, () => {});
        return {};
      },
      'iwinfo.devices': () => ({ devices: wlans().map((w) => w.ifname) }),
      'iwinfo.info': () => this.iwinfo(String(a.device), wlans(), wireless()),
      'iwinfo.assoclist': () => {
        const w = wlans().find((x) => x.ifname === a.device);
        return { results: w ? this.stations(w, ap) : [] };
      },
      'iwinfo.freqlist': () => freqs(this.iwinfo(String(a.device), wlans(), wireless())),
      'iwinfo.txpowerlist': () => clone(this.iwinfo(String(a.device), wlans(), wireless()).band === '5 GHz' ? power5 : power2),
      'network.device.status': () => {
        const [rx, tx] = this.sum((_c, at) => at?.ap === ap);
        const st = this.stats(rx, tx);
        const idle = this.stats(0, 0);
        const map: DeviceStatusMap = {
          // The uplink to the gateway, and a printer on lan2.
          wan: { type: 'Network device', devtype: 'ethernet', up: true, present: true, carrier: true, speed: '1000F', macaddr: macPlus(ap.device.mac, 1), statistics: this.stats(tx, rx) },
          lan1: { type: 'Network device', devtype: 'ethernet', up: true, present: true, carrier: false, macaddr: macPlus(ap.device.mac, 2), statistics: idle },
          lan2: { type: 'Network device', devtype: 'ethernet', up: true, present: true, carrier: true, speed: '100F', macaddr: macPlus(ap.device.mac, 3), statistics: idle },
          'br-lan': { type: 'bridge', devtype: 'bridge', up: true, present: true, carrier: true, macaddr: ap.device.mac, 'bridge-members': ['lan1', 'lan2', 'wan', ...wlans().map((w) => w.ifname)], statistics: st },
        };
        for (const w of wlans()) {
          const [wrx, wtx] = this.sum((_c, at) => at?.ap === ap && at.wlan?.ifname === w.ifname);
          map[w.ifname] = { type: 'Network device', devtype: 'wlan', up: true, present: true, carrier: true, macaddr: w.bssid, statistics: this.stats(wtx, wrx) };
        }
        return map;
      },
      'uci.get': () => ap.uci.get(String(a.config)),
      'uci.set': () => ap.uci.set(String(a.config), String(a.section), a.values as Record<string, UciValue>),
      'uci.add': () => ({ section: ap.uci.add(String(a.config), String(a.type), str(a.name), (a.values ?? {}) as Record<string, UciValue>) }),
      'uci.delete': () => ap.uci.delete(String(a.config), String(a.section), a.options ? list(a.options) : str(a.option) ? [str(a.option)!] : undefined),
      'uci.apply': () => ap.uci.apply(!!a.rollback, Number(a.timeout ?? 30)),
      'uci.confirm': () => ap.uci.confirm(),
      'uci.revert': () => ap.uci.revert(String(a.config)),
      'uci.changes': () => ap.uci.changes(str(a.config)),
      'netui.agent.ports': () => clone(AP_PORTS),
      'netui.packages.status': () => this.packagesStatus(ap.node),
      'netui.packages.install': () => this.packagesChange(ap.node, 'install', a.addon as AddonKey),
      'netui.packages.remove': () => this.packagesChange(ap.node, 'remove', a.addon as AddonKey),
      'netui.firmware.status': () => this.firmwareStatus(ap.node),
      'netui.firmware.check': () => this.firmwareCheck(ap.node),
      'netui.firmware.upgrade': () => this.firmwareUpgrade(ap.node, str(a.version) ?? NEXT_VERSION),
    };
    if (object.startsWith('hostapd.') && method === 'del_client') {
      this.kick(String(a.addr ?? ''));
      return { status: 0, data: {} };
    }
    const h = handlers[`${object}.${method}`];
    if (!h) return { status: UbusStatus.PERMISSION_DENIED };
    try {
      const data = h();
      return { status: 0, data: data ?? {} };
    } catch (e) {
      if (e instanceof Status) return { status: e.code };
      throw e;
    }
  }

  private systemInfo() {
    const t = now();
    const load = (k: number) => Math.floor((0.08 + 0.1 * activity(t, k)) * 65536);
    return {
      localtime: Math.floor(t),
      uptime: Math.floor(t - this.boot),
      load: [load(1), load(2), load(3)] as [number, number, number],
      memory: { total: 1_002_418_176, free: 612_384_768, available: 701_349_888, shared: 1_064_960, buffered: 0, cached: 92_274_688 },
      root: { total: 98_304, free: 71_680, used: 26_624, avail: 71_680 },
    };
  }

  private wg(): WgInstances {
    const out: WgInstances = {};
    const net = this.uci.committed('network');
    const t = Math.floor(now());
    for (const s of Object.values(net)) {
      if (s['.type'] !== 'interface' || str(s.proto) !== 'wireguard') continue;
      const name = s['.name'];
      const peers = Object.values(net).filter((p) => p['.type'] === `wireguard_${name}` && str(p.disabled) !== '1');
      out[name] = {
        name,
        public_key: 'Hx9cQ2mB7vR4tY1wE6uI3oP8aS5dF0gJ2kL7zX4cV1n=',
        listen_port: str(s.listen_port) ?? '51820',
        fwmark: 'off',
        peers: peers.map((p, i) => {
          // A peer with an endpoint is a tunnel the router dials out on (the VPN service): it comes up at once.
          if (str(p.endpoint_host)) {
            const up = t - (this.tunnelUp[name] ??= t);
            return {
              name: str(p.description) ?? null,
              public_key: str(p.public_key) ?? '',
              endpoint: `198.51.100.200:${str(p.endpoint_port) ?? '51820'}`,
              allowed_ips: list(p.allowed_ips),
              latest_handshake: String(t - (up % 120)),
              transfer_rx: String(up * 182_000 + 92_160),
              transfer_tx: String(up * 21_500 + 9_216),
              persistent_keepalive: str(p.persistent_keepalive) ?? 'off',
            };
          }
          const live = i === 0 && VPN_PEERS.some((v) => v.key === str(p.public_key));
          return {
            name: str(p.description) ?? null,
            public_key: str(p.public_key) ?? '',
            endpoint: live ? '198.51.100.77:41820' : '(none)',
            allowed_ips: live ? list(p.allowed_ips) : [],
            latest_handshake: live ? String(t - 40 - (t % 110)) : i === 1 ? String(t - 86400 * 2 - 3 * 3600 - 1260) : '0',
            transfer_rx: live ? String(48_211_904 + (t % 100000) * 40) : '0',
            transfer_tx: live ? String(512_998_100 + (t % 100000) * 900) : '0',
            persistent_keepalive: str(p.persistent_keepalive) ?? 'off',
          };
        }),
      };
    }
    return out;
  }

  // -------------------------------------------------------------------------

  private committed(configs: string[]): void {
    const t = now();
    for (const c of configs) {
      if (c === 'network') this.addLog(1, "netifd: Interface 'lan' is now up", 30, t);
      if (c === 'firewall') this.addLog(1, 'firewall: Reloading firewall due to config change', 30, t);
      if (c === 'wireless') for (const w of this.wlans()) this.addLog(1, `hostapd: ${w.ifname}: AP-ENABLED`, 30, t);
    }
  }

  private table(): Record<string, Handler> {
    const u = this.uci;
    return {
      'network.interface.dump': () => this.interfaces(),
      'network.device.status': () => this.deviceStatus(),
      'system.info': () => this.systemInfo(),
      'system.board': () => ({
        hostname: str(Object.values(u.committed('system')).find((s) => s['.type'] === 'system')?.hostname) ?? 'OpenWrt',
        model: BOARD.model,
        board_name: BOARD.board_name,
        kernel: BOARD.kernel,
        system: BOARD.system,
        rootfs_type: 'squashfs',
        release: {
          distribution: 'OpenWrt',
          version: this.gw.firmware.installed,
          revision: BOARD.revision,
          target: BOARD.target,
          description: `OpenWrt ${this.gw.firmware.installed} ${BOARD.revision}`,
          builddate: '1793664000',
        },
      }),
      'system.reboot': () => this.restart(30),
      'system.validate_firmware_image': () => ({ valid: true, forceable: true, allow_backup: true, tests: { fwtool_signature: true, fwtool_device_match: true } }),
      'luci-rpc.getBoardJSON': () => ({
        model: { id: BOARD.board_name, name: BOARD.model },
        network: { lan: { ports: ['lan1', 'lan2', 'lan3', 'lan4'], protocol: 'static' }, wan: { device: 'wan', protocol: 'dhcp' } },
      }),
      'luci-rpc.getDHCPLeases': () => this.leases(),
      'luci-rpc.getHostHints': () => this.hints(),
      'iwinfo.devices': () => ({ devices: this.wlans().map((w) => w.ifname) }),
      'iwinfo.info': (a) => this.iwinfo(String(a.device)),
      'iwinfo.assoclist': (a) => {
        const w = this.wlans().find((x) => x.ifname === a.device);
        if (!w) throw new Status(UbusStatus.NOT_FOUND);
        return { results: this.stations(w) };
      },
      'iwinfo.freqlist': (a) => freqs(this.iwinfo(String(a.device))),
      'iwinfo.txpowerlist': (a) => clone(this.bandOf(String(a.device)) === '5g' ? power5 : power2),
      'iwinfo.countrylist': () => clone(countries),
      'iwinfo.survey': (a) => {
        // The recorded survey for the other channels; the one in use gets counters that keep moving.
        // Noise is an unsigned byte: 161 = -95 dBm.
        const five = this.bandOf(String(a.device)) === '5g';
        const s = clone(five ? survey5 : survey2);
        const { frequency } = this.iwinfo(String(a.device));
        const active = Math.floor((now() - this.boot) * 1000);
        // netui shows the change between two polls, so the counters must move smoothly.
        const busy = Math.floor(active * (five ? 0.12 : 0.31) + 1500 * Math.sin(now() / 17));
        for (const r of s.results) {
          if (r.mhz === frequency) Object.assign(r, { active_time: active, busy_time: busy, rx_time: Math.floor(busy * 0.3), tx_time: Math.floor(busy * 0.45), noise: five ? 161 : 164 });
        }
        return s;
      },
      'iwinfo.scan': (a) => scan(this.bandOf(String(a.device))),
      'uci.get': (a) => u.get(String(a.config)),
      // What read-only sessions read instead: credentials masked, committed values.
      'netui.config.get': (a) => {
        const config = String(a.config);
        if (!CONFIG_PACKAGES.includes(config)) return { error: 'not available' };
        const cfg = u.committed(config);
        return Object.keys(cfg).length ? { values: maskConfig(cfg) } : { error: 'not found' };
      },
      'uci.set': (a) => u.set(String(a.config), String(a.section), (a.values ?? {}) as Record<string, UciValue>),
      'uci.add': (a) => ({ section: u.add(String(a.config), String(a.type), str(a.name), (a.values ?? {}) as Record<string, UciValue>) }),
      'uci.delete': (a) => u.delete(String(a.config), String(a.section), a.options ? list(a.options) : str(a.option) ? [str(a.option)!] : undefined),
      'uci.rename': (a) => u.rename(String(a.config), String(a.section), String(a.name)),
      'uci.changes': (a) => u.changes(str(a.config)),
      'uci.revert': (a) => u.revert(String(a.config)),
      'uci.apply': (a) => u.apply(!!a.rollback, Number(a.timeout ?? 30)),
      'uci.confirm': () => u.confirm(),
      'uci.rollback': () => u.rollback(),
      'log.read': (a) => ({ log: this.log.slice(-Number(a.lines ?? 500)) }),
      'luci.getTimezones': () => clone(timezones),
      'luci.getUnixtime': () => ({ result: Math.floor(now()) }),
      'luci.getLocaltime': () => ({ result: Math.floor(now()) }),
      'netui.traffic.connections': () => this.conntrack(),
      'luci.upnp.get_status': () => {
        if (!this.installed.upnp) throw new Status(UbusStatus.NOT_FOUND);
        const on = str(Object.values(u.committed('upnpd')).find((s) => s['.type'] === 'upnpd')?.enabled) === '1';
        return { rules: on ? clone(this.upnp) : [] };
      },
      'luci.upnp.delete_rule': (a) => {
        this.upnp = this.upnp.filter((r) => r.num !== String(a.token));
        return { result: true };
      },
      'luci.ddns.get_services_status': () => {
        if (!this.installed.ddns) throw new Status(UbusStatus.NOT_FOUND);
        const out: Record<string, unknown> = {};
        for (const s of Object.values(u.committed('ddns'))) {
          if (s['.type'] !== 'service') continue;
          const on = str(s.enabled) === '1';
          out[s['.name']] = on
            ? { ip: WAN.address, last_update: fmtDate(now() - 3 * 3600), next_update: 'Verify', next_check: fmtDate(now() + 600), pid: 4120 }
            : { ip: '', last_update: null, next_update: 'Disabled', next_check: null, pid: null };
        }
        return out;
      },
      'luci.ddns.get_ddns_state': () => ({ _version: '2.8.2', _enabled: true, _curr_dateformat: '%F %R', _services_list: 'duckdns.org' }),
      'luci.wireguard.getWgInstances': () => this.wg(),
      'luci.wireguard.generateKeyPair': () => ({ keys: { priv: randomKey(), pub: randomKey() } }),
      'luci.wireguard.generatePsk': () => ({ psk: randomKey() }),
      'mwan3.status': () => {
        if (!this.installed.multiwan) throw new Status(UbusStatus.NOT_FOUND);
        return clone(mwanFixture);
      },
      'file.exec': (a) => this.exec(String(a.command), list(a.params)),
      'netui.devices.list': () => ({ devices: this.aps.map((a) => ({ ...clone(a.device), release: `OpenWrt ${a.node.firmware.installed} ${BOARD.revision}` })) }),
      'netui.devices.discover': () => ({ devices: clone(this.pending) }),
      'netui.devices.adopt': (a) => {
        const p = this.pending.find((d) => d.ip === str(a.ip));
        if (!p) return { error: 'No access point answered at that address.' };
        if (!str(a.password)) return { error: 'Wrong password for the access point.' };
        this.pending = this.pending.filter((d) => d !== p);
        const device: ManagedDevice = {
          mac: p.mac,
          name: str(a.name) || 'Access point',
          model: p.model,
          board_name: AP_BOARD.board_name,
          ip: p.ip,
          online: true,
          hostname: 'OpenWrt',
          release: p.release,
          agent: p.agent,
          adopted_at: Math.floor(now()),
        };
        const ap: Ap = { device, uci: new UciStore({ wireless: apWireless(), network: apNetwork(false) }, () => true), node: this.apNode(() => ap) };
        this.aps.push(ap);
        return { device };
      },
      'netui.devices.forget': (a) => {
        const ap = this.aps.find((d) => d.device.mac === str(a.mac));
        this.aps = this.aps.filter((d) => d !== ap);
        if (ap) this.pending.push({ ip: ap.device.ip ?? '192.168.1.2', mac: ap.device.mac, hostname: 'OpenWrt', model: ap.device.model, release: ap.device.release, agent: ap.device.agent, adopted: false });
        return {};
      },
      'netui.devices.rename': (a) => {
        const ap = this.aps.find((d) => d.device.mac === str(a.mac));
        if (ap) ap.device.name = String(a.name);
        return {};
      },
      'netui.devices.sync': (a) => {
        const out: Record<string, unknown> = {};
        for (const ap of this.aps) if (!a.mac || ap.device.mac === a.mac) out[ap.device.mac] = ap.device.online ? { result: true, networks: this.wlans().length } : { error: 'The device did not answer' };
        return { devices: out };
      },
      'netui.devices.credentials': () => ({ username: 'netui_gw', password: 'demo-ap-password' }),
      'netui.devices.call': (a) => this.relay(a),
      'netui.firmware.status': () => this.firmwareStatus(this.gw),
      'netui.firmware.check': () => this.firmwareCheck(this.gw),
      'netui.firmware.upgrade': (a) => this.firmwareUpgrade(this.gw, str(a.version) ?? NEXT_VERSION),
      'netui.packages.status': () => this.packagesStatus(this.gw),
      'netui.packages.install': (a) => this.packagesChange(this.gw, 'install', a.addon as AddonKey),
      'netui.packages.remove': (a) => this.packagesChange(this.gw, 'remove', a.addon as AddonKey),
      'netui.speedtest.status': () => this.speedStatus(),
      'netui.speedtest.start': () => {
        if (this.speed.job && jobLog(this.speed.job).running) return { error: 'A test is already running.' };
        this.speed.job = timed({
          started: now(),
          steps: [[9, 'done']],
          exit: 0,
          done: () =>
            this.speed.history.unshift({
              at: Math.floor(now()),
              download: Math.floor(880e6 + Math.random() * 60e6),
              upload: Math.floor(38e6 + Math.random() * 5e6),
              ping: Number((8 + Math.random() * 4).toFixed(2)),
              jitter: Number((0.8 + Math.random()).toFixed(2)),
              server: 'Example City',
            }),
        });
        return {};
      },
      'netui.services.adblock': () => {
        if (!this.installed.adblock) return { installed: false };
        const on = str(Object.values(u.committed('adblock-fast')).find((s) => s['.type'] === 'adblock-fast')?.enabled) === '1';
        return { ...clone(on ? adblockOn : adblockOff), warnings: [], busy: now() < this.adblockBusyUntil };
      },
      'netui.services.adblock_apply': () => {
        this.adblockBusyUntil = now() + 4;
        return {};
      },
      'netui.services.portal': () => {
        if (!this.installed.portal) return { installed: false };
        const on = str(Object.values(u.committed('opennds')).find((s) => s['.type'] === 'opennds')?.enabled) === '1';
        return { installed: true, busy: false, running: on, clients: [] };
      },
      'netui.services.portal_apply': () => ({}),
      'netui.services.portal_auth': () => ({}),
      'netui.services.portal_deauth': () => ({}),
      // Any well-formed token connects: the demo has no tunnel service to ask.
      'netui.services.tunnel': () => {
        if (!this.installed.tunnel) return { installed: false };
        const s = u.committed('cloudflared').config;
        const token = str(s?.token) ?? '';
        const on = str(s?.enabled) === '1' && !!token;
        let tunnel: string | null = null;
        try {
          tunnel = token ? ((JSON.parse(atob(token)) as { t?: string }).t ?? null) : null;
        } catch {
          // shown without an ID
        }
        return {
          installed: true,
          section: !!s,
          enabled: str(s?.enabled) === '1',
          token: !!token,
          tunnel,
          config_file: false,
          running: on,
          connections: on ? 4 : null,
          connector: on ? '0d6f2b7e-5c1a-4e93-8b20-7f4a1c9e3d58' : null,
          locations: on ? ['ams01', 'ams03', 'fra02', 'fra07'] : [],
          error: null,
        };
      },
      'netui.tailscale.status': () => {
        if (!this.installed.tailscale) return { installed: false };
        const needsLogin = clone(tailscaleFixture.needsLogin) as unknown as Record<string, unknown>;
        return { installed: true, status: needsLogin, prefs: { AdvertiseRoutes: null, WantRunning: this.tailscale.up, LoggedOut: true }, error: null, loggingIn: false };
      },
      'netui.tailscale.login': () => ({ error: 'Signing in to a tailnet is not part of the demo.' }),
      'netui.tailscale.up': () => ({ error: 'Signing in to a tailnet is not part of the demo.' }),
      'netui.tailscale.down': () => ({}),
      'netui.tailscale.logout': () => ({}),
      'netui.tailscale.set': () => ({}),
      'netui.history.begin': (a) => this.history.begin(a),
      'netui.history.record': (a) => this.history.record(a),
      'netui.history.list': () => this.history.list(),
      'netui.history.get': (a) => this.history.get(a),
      'netui.users.list': () => ({ users: clone(this.users) }),
      'netui.users.add': (a) => {
        const username = String(a.username ?? '');
        if (this.users.some((x) => x.username === username)) return { error: 'That login already exists.' };
        this.users.push({ username, role: a.role === 'viewer' ? 'viewer' : 'admin' });
        return {};
      },
      'netui.users.remove': (a) => {
        const rest = this.users.filter((x) => x.username !== a.username);
        if (!rest.some((x) => x.role === 'admin')) return { error: 'netui needs at least one admin.' };
        this.users = rest;
        return {};
      },
      'netui.users.password': () => ({}),
      'netui.users.role': (a) => {
        const next = this.users.map((x) => (x.username === a.username ? { ...x, role: (a.role === 'viewer' ? 'viewer' : 'admin') as NetuiUser['role'] } : x));
        if (!next.some((x) => x.role === 'admin')) return { error: 'netui needs at least one admin.' };
        this.users = next;
        return {};
      },
      'netui.users.root': () => ({ password_set: true }),
      'netui.users.root_password': () => ({}),
    };
  }

  /** What https-dns-proxy's init script does to dnsmasq (dl-wrx36/plain/uci.get.dhcp.doh-active.json). */
  private dohService(on: boolean): void {
    const local = ['127.0.0.1#5053', '127.0.0.1#5054'];
    this.uci.patch('dhcp', (c) => {
      for (const s of Object.values(c)) {
        if (s['.type'] !== 'dnsmasq') continue;
        if (on) Object.assign(s, { noresolv: '1', doh_server: local, server: local });
        else for (const o of ['noresolv', 'doh_server', 'server']) delete s[o];
      }
    });
  }

  private exec(command: string, params: string[]) {
    switch (command) {
      case '/usr/sbin/nlbw':
        return this.nlbw(params);
      case '/bin/ping':
      case '/bin/traceroute':
      case '/usr/bin/nslookup':
        return this.diagnostic(command, params);
      case '/usr/bin/etherwake':
        if (!this.installed.wol) throw new Status(UbusStatus.NOT_FOUND);
        return ok();
      case '/sbin/sysupgrade':
        this.restart(60);
        return ok();
      case '/etc/init.d/https-dns-proxy':
        if (params[0] === 'start' || params[0] === 'stop') this.dohService(params[0] === 'start');
        return ok();
      case '/etc/init.d/sqm':
      case '/etc/init.d/ddns':
      case '/usr/bin/wifi_schedule.sh':
        return ok();
      default:
        throw new Status(UbusStatus.PERMISSION_DENIED);
    }
  }
}

const NEXT_VERSION = '25.12.7';

/** Calls a viewer login may not make (the netui-viewer ACL group). */
const WRITES = new Set([
  'uci.set',
  'uci.add',
  'uci.delete',
  'uci.rename',
  'uci.order',
  'uci.apply',
  'uci.confirm',
  'uci.rollback',
  'uci.revert',
  'system.reboot',
  'luci.upnp.delete_rule',
  'luci.wireguard.generateKeyPair',
  'luci.wireguard.generatePsk',
  'netui.devices.adopt',
  'netui.devices.forget',
  'netui.devices.call',
  'netui.devices.sync',
  'netui.devices.rename',
  'netui.devices.credentials',
  'netui.packages.install',
  'netui.packages.remove',
  'netui.history.begin',
  'netui.history.record',
  'netui.history.get',
  'netui.users.list',
  'netui.users.add',
  'netui.users.remove',
  'netui.users.password',
  'netui.users.role',
  'netui.users.root',
  'netui.users.root_password',
  'netui.firmware.check',
  'netui.firmware.upgrade',
  'netui.speedtest.start',
  'netui.services.adblock_apply',
  'netui.services.portal_apply',
  'netui.services.portal_auth',
  'netui.services.portal_deauth',
  'netui.tailscale.login',
  'netui.tailscale.up',
  'netui.tailscale.down',
  'netui.tailscale.logout',
  'netui.tailscale.set',
]);

const PACKAGE_NAMES: Record<AddonKey, string> = {
  adblock: 'adblock-fast',
  portal: 'opennds',
  multiwan: 'mwan3',
  usage: 'nlbwmon',
  sqm: 'sqm-scripts',
  upnp: 'miniupnpd-nftables',
  ddns: 'ddns-scripts',
  wireguard: 'wireguard-tools',
  schedule: 'wifischedule',
  steering: 'usteer',
  speedtest: 'librespeed-cli',
  firmware: 'owut',
  wol: 'etherwake',
  doh: 'https-dns-proxy',
  tailscale: 'tailscale',
  tunnel: 'cloudflared',
  mesh: 'wpad-mbedtls',
  https: 'luci-ssl',
};

/** Neighbouring networks: a handful, at the strengths and channels of a block of flats. */
function scan(band: Band) {
  const five = band === '5g';
  const template = (five ? scan5 : scan2).results[0]!;
  const names = five
    ? ['Neighbor-5G', 'Apartment 3B', 'flat12', 'HomeNet-5G', 'Hidden', 'Printer-Direct']
    : ['Neighbor', 'Apartment 3B', 'flat12', 'HomeNet', 'Hidden', 'Kitchen-Guest', 'Smart-Setup', 'Corner Cafe'];
  const channels = five ? [36, 44, 52, 100, 149, 157] : [1, 1, 6, 6, 11, 11, 3, 11];
  return {
    results: names.map((name, i) => {
      const channel = channels[i % channels.length]!;
      const r = clone(template) as typeof template & { ssid?: string | null };
      return {
        ...r,
        ssid: name === 'Hidden' ? null : name,
        bssid: `02:5e:00:${five ? '55' : '24'}:00:${(0x10 + i).toString(16)}`,
        band: five ? 5 : 2,
        channel,
        mhz: five ? 5000 + channel * 5 : 2407 + channel * 5,
        mode: 'Master',
        signal: -48 - Math.round(hash(i * 13 + (five ? 101 : 7)) * 40),
        encryption: i === 7 ? { enabled: false } : r.encryption,
        ...(r.ht_operation ? { ht_operation: { ...r.ht_operation, primary_channel: channel } } : {}),
        ...(r.vht_operation ? { vht_operation: { ...r.vht_operation, center_freq_1: five ? channel + 6 : channel } } : {}),
      };
    }),
  };
}

function freqs(info: { channel: number; band: string }) {
  const f = clone(info.band === '5 GHz' ? freq5 : freq2);
  for (const r of f.results) r.active = r.channel === info.channel;
  return f;
}

function maskBits(mask: string): number {
  return mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0);
}

function fmtDate(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

