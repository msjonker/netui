// Health check: a look over the router's settings for things that are
// risky or quietly not working, each with what to do about it. Everything
// here is read from config netui already loads; nothing is probed. A
// finding's fix is a list of UCI ops that goes through the usual review and
// apply/rollback flow.

import type { UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';
import { networkLabel } from './network';
import { cellOps, policyMatrix, ROUTER, wanInputRules, zoneList } from './policy';
import { normalizeLimits } from './speedLimit';
import { securityOf } from './wifi';
import { normalizeDmz } from './firewall';

export type Severity = 'risk' | 'warn' | 'info';

export interface Finding {
  /** Stable per finding, e.g. "wifi-open:Cafe". */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix?: { label: string; ops: UciOp[] };
  /** Where to change it by hand, when there is no one-click fix. */
  link?: { href: string; label: string };
}

export interface Check {
  id: string;
  /** What was checked, shown with a tick when it passed. */
  label: string;
  findings: Finding[];
}

export interface HealthInput {
  firewall: UciConfig;
  wireless?: UciConfig;
  system?: UciConfig;
  /** Optional packages: undefined when not installed. */
  upnpd?: UciConfig;
  sqm?: UciConfig;
  /** Whether root has a password; undefined when unknown (viewer login). */
  rootPassword?: boolean;
  /** location.protocol of the page. */
  protocol: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { risk: 0, warn: 1, info: 2 };

// Services that should never answer from the internet: remote shells, the
// router's web pages, DNS (open resolvers get abused), file sharing.
const SENSITIVE_PORTS: Record<number, string> = {
  22: 'ssh',
  23: 'telnet',
  53: 'DNS',
  80: 'the web interface',
  443: 'the web interface',
  139: 'file sharing',
  445: 'file sharing',
  8080: 'a web page',
  8443: 'a web page',
};

/** Passphrases that are common enough to be tried first. */
const COMMON_KEYS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  '11111111',
  '00000000',
  'password',
  'password1',
  'qwertyui',
  'qwerty123',
  'iloveyou',
  'abcd1234',
  'abcdefgh',
  'internet',
  'welcome1',
  'letmein1',
  'changeme',
  'openwrt1',
]);

const MIN_KEY = 12;

function portsIn(spec: string): [number, number][] {
  return spec
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => {
      const [a, b] = p.split(/[-:]/).map(Number);
      return [a!, b ?? a!] as [number, number];
    })
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}


// ---------------------------------------------------------------------------
// Firewall

function internetOpen(fw: UciConfig): Check {
  const findings: Finding[] = [];
  for (const z of zoneList(fw).filter((z) => z.internet)) {
    const s = fw[z.section]!;
    if ((str(s.input) ?? '').toUpperCase() === 'ACCEPT') {
      findings.push({
        id: `wan-input:${z.name}`,
        severity: 'risk',
        title: 'The router accepts connections from the internet',
        detail: `The ${z.name} zone's input policy is Accept, so every service on the router (sign-in pages, ssh, DNS) answers anyone on the internet.`,
        fix: { label: 'Block', ops: diffSection('firewall', z.section, s, { input: 'REJECT' }) },
      });
    }
    if ((str(s.forward) ?? '').toUpperCase() === 'ACCEPT') {
      findings.push({
        id: `wan-forward:${z.name}`,
        severity: 'risk',
        title: 'Traffic from the internet can reach your devices',
        detail: `The ${z.name} zone's forward policy is Accept: connections from the internet are passed on to devices without a port forward.`,
        fix: { label: 'Block', ops: diffSection('firewall', z.section, s, { forward: 'REJECT' }) },
      });
    }
  }
  return { id: 'wan-zone', label: 'The router and your devices are closed to the internet', findings };
}

function internetServices(fw: UciConfig): Check {
  const findings: Finding[] = [];
  for (const r of wanInputRules(fw)) {
    const s = fw[r.section]!;
    if (!r.enabled || (str(s.target) ?? '').toUpperCase() !== 'ACCEPT') continue;
    const protos = r.proto.split(' ');
    if (!protos.some((p) => p === 'tcp' || p === 'udp' || p === 'all')) continue;
    // No port on a tcp/udp rule means every port.
    const ranges = r.ports ? portsIn(r.ports) : [[1, 65535] as [number, number]];
    const hits = Object.entries(SENSITIVE_PORTS)
      .filter(([p]) => ranges.some(([a, b]) => a <= +p && +p <= b))
      .map(([, what]) => what);
    if (!hits.length) continue;
    const what = [...new Set(hits)];
    findings.push({
      id: `wan-rule:${r.section}`,
      severity: 'risk',
      title: `The internet can reach ${what.join(' and ')} on the router`,
      detail: `The rule "${r.name}" opens ${r.ports ? `port ${r.ports}` : 'every port'} to the internet. For remote access, a VPN is safer.`,
      fix: { label: 'Turn Rule Off', ops: [{ op: 'set', config: 'firewall', section: r.section, values: { enabled: '0' } }] },
    });
  }
  return { id: 'wan-services', label: 'No sign-in, ssh or DNS service is open to the internet', findings };
}

const looksGuest = (name: string, networks: string[]) => /guest/i.test(name) || networks.some((n) => /guest/i.test(n));

function guestIsolation(fw: UciConfig): Check {
  const findings: Finding[] = [];
  const zones = zoneList(fw);
  const guests = zones.filter((z) => !z.internet && looksGuest(z.name, z.networks));
  if (!guests.length) return { id: 'guest', label: 'Guest networks are kept apart', findings };
  const m = policyMatrix(fw);
  for (const g of guests) {
    const label = networkLabel(g.networks[0] ?? g.name);
    for (const other of zones.filter((z) => !z.internet && z.name !== g.name)) {
      const c = m.cell(g.name, other.name);
      if (c.verdict !== 'allow') continue;
      const ops = cellOps(c, 'block', fw);
      findings.push({
        id: `guest-zone:${g.name}>${other.name}`,
        severity: 'warn',
        title: `${label} can reach ${networkLabel(other.networks[0] ?? other.name)}`,
        detail: `Devices on ${label} can open connections to devices on ${networkLabel(other.networks[0] ?? other.name)}.`,
        ...(ops.length
          ? { fix: { label: 'Block', ops } }
          : { link: { href: '/settings/security', label: 'Firewall' } }),
      });
    }
    const r = m.cell(g.name, ROUTER);
    if (r.verdict === 'allow' && !r.locked) {
      findings.push({
        id: `guest-router:${g.name}`,
        severity: 'warn',
        title: `${label} can reach the router's settings`,
        detail: `Devices on ${label} can open the router's sign-in pages and ssh. Blocking keeps DHCP and DNS working.`,
        fix: { label: 'Block', ops: cellOps(r, 'block', fw) },
      });
    }
  }
  return { id: 'guest', label: 'Guest networks are kept apart', findings };
}

function dmz(fw: UciConfig): Check {
  const findings: Finding[] = [];
  const d = normalizeDmz(fw);
  if (d) {
    findings.push({
      id: 'dmz',
      severity: 'info',
      title: `${d.destIp || 'One device'} is exposed to the internet (DMZ)`,
      detail: 'Every port the router does not use is forwarded to it. Keep that device up to date, or use port forwards instead.',
      link: { href: '/settings/security', label: 'Firewall' },
    });
  }
  return { id: 'dmz', label: 'No device is fully exposed to the internet', findings };
}

// ---------------------------------------------------------------------------
// WiFi

function wifiSecurity(wireless: UciConfig): Check[] {
  const open: Finding[] = [];
  const weak: Finding[] = [];
  const keys: Finding[] = [];
  const wps: Finding[] = [];
  // One finding per SSID, however many bands carry it.
  const seen = new Set<string>();
  for (const s of sectionsOfType(wireless, 'wifi-iface')) {
    // wifi-iface and wifi-device use `disabled`, not `enabled`.
    const radio = wireless[str(s.device) ?? ''];
    if ((str(s.mode) ?? 'ap') !== 'ap' || bool(s.disabled, false) || !radio || bool(radio.disabled, false)) continue;
    const ssid = str(s.ssid) ?? s['.name'];
    const enc = str(s.encryption) ?? 'none';
    const security = securityOf(enc);
    const [base, ...ciphers] = enc.split('+');
    const sameSsid = sectionsOfType(wireless, 'wifi-iface').filter((x) => str(x.ssid) === str(s.ssid) && (str(x.mode) ?? 'ap') === 'ap');
    const key = ssid;
    if (wps.every((f) => f.id !== `wps:${key}`) && bool(s.wps_pushbutton, false)) {
      wps.push({
        id: `wps:${key}`,
        severity: 'warn',
        title: `WPS is on for ${ssid}`,
        detail: 'Push-button setup lets a device join without the password while the button is active, and some devices implement it badly.',
        fix: {
          label: 'Turn Off',
          ops: sameSsid.filter((x) => bool(x.wps_pushbutton, false)).map((x) => ({ op: 'unset' as const, config: 'wireless' as const, section: x['.name'], options: ['wps_pushbutton'] })),
        },
      });
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (security === 'none') {
      open.push({
        id: `wifi-open:${key}`,
        severity: 'warn',
        title: `${ssid} has no password`,
        detail: 'Anyone nearby can join it and see unencrypted traffic. Enhanced Open encrypts without a password if every device supports it.',
        link: { href: '/settings/wifi', label: 'WiFi' },
      });
      continue;
    }
    if (base === 'wep-open' || base === 'wep-shared' || base === 'wep' || base === 'psk' || ciphers.includes('tkip') || base === 'psk-mixed') {
      const wep = base!.startsWith('wep');
      const psk2 = ['psk2', 'ccmp'].join('+');
      weak.push({
        id: `wifi-weak:${key}`,
        severity: wep ? 'risk' : 'warn',
        title: wep ? `${ssid} uses WEP` : `${ssid} still allows WPA (TKIP)`,
        detail: wep
          ? 'WEP can be broken in minutes. Use WPA2 or WPA3; devices too old for WPA2 should go on a network of their own.'
          : 'The original WPA and its TKIP cipher are broken and slow every device down to old speeds. WPA2 works with everything made in the last 15 years.',
        ...(wep
          ? { link: { href: '/settings/wifi', label: 'WiFi' } }
          : { fix: { label: 'Use WPA2', ops: sameSsid.map((x) => ({ op: 'set' as const, config: 'wireless' as const, section: x['.name'], values: { encryption: psk2 } })) } }),
      });
    }
    const k = str(s.key) ?? '';
    if (security !== 'owe' && security !== 'other' && k && (k.length < MIN_KEY || COMMON_KEYS.has(k.toLowerCase()))) {
      keys.push({
        id: `wifi-key:${key}`,
        severity: COMMON_KEYS.has(k.toLowerCase()) ? 'risk' : 'warn',
        title: COMMON_KEYS.has(k.toLowerCase()) ? `${ssid}'s password is a common one` : `${ssid}'s password is short`,
        detail: `Passwords are guessed offline from a captured join, at millions a second. Use ${MIN_KEY} or more characters, e.g. four random words.`,
        link: { href: '/settings/wifi', label: 'WiFi' },
      });
    }
  }
  return [
    { id: 'wifi-open', label: 'Every WiFi network has a password', findings: open },
    { id: 'wifi-weak', label: 'WiFi uses current encryption (WPA2 or WPA3)', findings: weak },
    { id: 'wifi-key', label: 'WiFi passwords are long and not common ones', findings: keys },
    { id: 'wps', label: 'WPS push-button setup is off', findings: wps },
  ];
}

// ---------------------------------------------------------------------------
// Services and system

function upnp(cfg: UciConfig | undefined): Check {
  const findings: Finding[] = [];
  const s = cfg && sectionsOfType(cfg, 'upnpd')[0];
  if (s && bool(s.enabled, false) && !bool(s.secure_mode, true)) {
    findings.push({
      id: 'upnp-secure',
      severity: 'warn',
      title: 'UPnP lets a device open ports for other devices',
      detail: 'With secure mode off, any device (or malware on it) can forward ports from the internet to any address on your network.',
      fix: { label: 'Turn On Secure Mode', ops: diffSection('upnpd', s['.name'], s, { secure_mode: '1' }) },
    });
  }
  return { id: 'upnp', label: 'Automatic port forwarding (UPnP) only opens ports for the device asking', findings };
}

function offload(fw: UciConfig, sqm: UciConfig | undefined): Check {
  const findings: Finding[] = [];
  const d = sectionsOfType(fw, 'defaults')[0];
  if (d && bool(d.flow_offloading, false) && bool(d.flow_offloading_hw, false)) {
    const shaping = !!sqm && sectionsOfType(sqm, 'queue').some((q) => bool(q.enabled, false));
    const limits = normalizeLimits(fw).some((l) => l.enabled && (l.download || l.upload));
    const what = [shaping && 'Smart Queues', limits && 'speed limits'].filter(Boolean) as string[];
    if (what.length) {
      findings.push({
        id: 'hw-offload',
        severity: 'warn',
        title: `Hardware offloading bypasses ${what.join(' and ')}`,
        detail: 'Connections the hardware handles skip the queue and the limits, so they have no effect on them. Software offloading keeps most of the speed.',
        fix: { label: 'Use Software Offloading', ops: diffSection('firewall', d['.name'], d, { flow_offloading_hw: '0' }) },
      });
    }
  }
  return { id: 'offload', label: 'Traffic shaping is not bypassed by hardware offloading', findings };
}

function time(system: UciConfig | undefined): Check {
  const findings: Finding[] = [];
  const ntp = system && sectionsOfType(system, 'timeserver')[0];
  if (system && (!ntp || !bool(ntp.enabled, true) || !list(ntp.server).length)) {
    findings.push({
      id: 'ntp',
      severity: 'warn',
      title: 'The router does not set its clock',
      detail: 'Without time servers the clock drifts and starts from the firmware date after a power cut: schedules, logs and certificate checks go wrong.',
      ...(ntp && list(ntp.server).length
        ? { fix: { label: 'Turn On', ops: [{ op: 'unset' as const, config: 'system' as const, section: ntp['.name'], options: ['enabled'] }] } }
        : { link: { href: '/settings/system', label: 'System' } }),
    });
  }
  return { id: 'ntp', label: 'The clock is kept right from time servers', findings };
}

function access(input: HealthInput): Check {
  const findings: Finding[] = [];
  if (input.rootPassword === false) {
    findings.push({
      id: 'root-password',
      severity: 'risk',
      title: 'The router has no root password',
      detail: 'Anyone on your network can sign in with ssh, or to the advanced web interface, and change anything.',
      link: { href: '/settings/system', label: 'Set a Password' },
    });
  }
  if (input.protocol === 'http:') {
    findings.push({
      id: 'http',
      severity: 'info',
      title: 'netui is open over plain HTTP',
      detail: 'Your sign-in travels unencrypted on the local network. Serving the router over HTTPS (uhttpd with a certificate) keeps it private.',
    });
  }
  return { id: 'access', label: 'Signing in to the router is protected', findings };
}

// ---------------------------------------------------------------------------

export function runChecks(input: HealthInput): Check[] {
  const { firewall: fw } = input;
  const checks: Check[] = [
    access(input),
    internetOpen(fw),
    internetServices(fw),
    ...(input.wireless ? wifiSecurity(input.wireless) : []),
    guestIsolation(fw),
    upnp(input.upnpd),
    dmz(fw),
    offload(fw, input.sqm),
    time(input.system),
  ];
  for (const c of checks) c.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return checks;
}

export function allFindings(checks: Check[]): Finding[] {
  return checks.flatMap((c) => c.findings).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Counts of findings worth acting on (info is not counted). */
export function summary(checks: Check[]): { risk: number; warn: number; info: number; passed: number } {
  const f = checks.flatMap((c) => c.findings);
  return {
    risk: f.filter((x) => x.severity === 'risk').length,
    warn: f.filter((x) => x.severity === 'warn').length,
    info: f.filter((x) => x.severity === 'info').length,
    passed: checks.filter((c) => !c.findings.length).length,
  };
}
