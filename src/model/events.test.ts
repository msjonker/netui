import { describe, expect, it } from 'vitest';
import type { DhcpLeases, HostHints, IwinfoInfo, LogEntry, LogRead } from '../api/types';
import realLog from '../../test/fixtures/ubus/dl-wrx36/plain/log.read.json';
import syntheticLog from '../../test/fixtures/ubus/dl-wrx36/log.read.synthetic.json';
import wrxLeases from '../../test/fixtures/ubus/dl-wrx36/plain/luci-rpc.getDHCPLeases.json';
import wrxHints from '../../test/fixtures/ubus/dl-wrx36/plain/luci-rpc.getHostHints.json';
import wrxInfo0 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy0-ap0.json';
import wrxInfo1 from '../../test/fixtures/ubus/dl-wrx36/plain/iwinfo.info.phy1-ap0.json';
import { wrxFixtures } from '../../test/fixtures';
import { mergeClients } from './clients';
import {
  clockSkew,
  collapseRepeats,
  dayLabel,
  isListed,
  isNewClient,
  mergeLog,
  notableEvents,
  parseEvents,
  relativeTime,
  splitLine,
  trackMacs,
  unreadEvents,
  wifiIfnames,
  type EventContext,
  type NetEvent,
} from './events';
import { localSubnets } from './network';
import { normalizeWifi } from './wifi';

const real: LogRead = realLog;
const synthetic: LogRead = syntheticLog;
const leases: DhcpLeases = wrxLeases;
const hints: HostHints = wrxHints;
const info0: IwinfoInfo = wrxInfo0;
const info1: IwinfoInfo = wrxInfo1;

const wrx = wrxFixtures('plain');
const PC = '00:00:5e:00:53:01';
const PC_NAME = 'workstation';
const PHONE = '3a:7c:12:9e:44:01';

function context(extra: Partial<EventContext> = {}): EventContext {
  const subnets = localSubnets(wrx.uci.network(), wrx.uci.firewall(), wrx.ifaceDump());
  const clients = mergeClients({ leases, hints, dhcp: wrx.uci.dhcp(), subnets });
  // As recorded: iwinfo info on this build has no ssid, so the ifname is tied
  // to its SSID through the band (phy0 is 5 GHz, phy1 2.4 GHz).
  const live = [
    { ifname: 'phy0-ap0', info: info0 },
    { ifname: 'phy1-ap0', info: info1 },
  ];
  const wifi = normalizeWifi(wrx.uci.wireless(), live);
  return {
    clients,
    wifi: wifiIfnames(wifi, live),
    ports: { lan1: 'lan', lan2: 'lan', lan3: 'lan', lan4: 'lan', wan: 'wan' },
    ...extra,
  };
}

const byKind = (events: NetEvent[], kind: NetEvent['kind']) => events.filter((e) => e.kind === kind);
const entry = (id: number, msg: string, over: Partial<LogEntry> = {}): LogEntry => ({
  id,
  msg,
  priority: 29,
  source: 1,
  time: 1_000_000 + id,
  ...over,
});

describe('wifiIfnames', () => {
  it('maps ifnames by SSID when iwinfo reports it, else through the band', () => {
    const wireless = wrx.uci.wireless();
    const withSsid = [{ ifname: 'phy0-ap0', info: { ...info0, ssid: 'netui-test' } }];
    expect(wifiIfnames(normalizeWifi(wireless, withSsid), withSsid)).toEqual({
      'phy0-ap0': { ssid: 'netui-test', band: '5 GHz' },
    });
    expect(context().wifi).toEqual({
      'phy0-ap0': { ssid: 'netui-test', band: '5 GHz' },
      'phy1-ap0': { ssid: 'netui-test', band: '2.4 GHz' },
    });
  });
});

describe('splitLine', () => {
  it('separates kernel uptime stamps and syslog tags', () => {
    expect(splitLine(real.log.find((e) => e.id === 876)!)).toEqual({
      process: 'kernel',
      text: 'nss-dp 3a001600.dp4 lan1: PHY Link up speed: 1000',
      uptime: 614.882132,
    });
    expect(splitLine(real.log.find((e) => e.id === 885)!).process).toBe('dnsmasq-dhcp');
    expect(splitLine(entry(1, 'dispatcher.uc: luci: accepted login on / for root from 1.2.3.4'))).toEqual({
      process: 'dispatcher.uc',
      text: 'luci: accepted login on / for root from 1.2.3.4',
    });
    expect(splitLine(entry(1, '[    9.528420] procd: - early -', { source: 0 })).process).toBe('procd');
  });
});

describe('parseEvents on the recorded DL-WRX36 log', () => {
  const events = parseEvents(real.log, context());

  it('keeps every line, newest first', () => {
    expect(events).toHaveLength(real.log.length);
    expect(events[0]!.id).toBe(1038);
    expect(events.at(-1)!.id).toBe(839);
  });

  it('turns DHCPACK into an assignment with the client name', () => {
    const [ack] = byKind(events, 'dhcp-lease');
    expect(ack).toMatchObject({ category: 'dhcp', mac: PC, ip: '192.168.1.137', text: `Assigned 192.168.1.137 to ${PC_NAME}` });
    expect(ack!.parts[1]).toEqual({ mac: PC, label: PC_NAME });
    // DISCOVER/OFFER/REQUEST are noise: raw info lines, not listed.
    const discover = events.find((e) => e.line.includes('DHCPDISCOVER'))!;
    expect(discover.raw).toBe(true);
    expect(isListed(discover)).toBe(false);
  });

  it('reports ssh logins from a known client by name, flagging the blank password', () => {
    const logins = byKind(events, 'admin-login');
    expect(logins).toHaveLength(real.log.filter((e) => e.msg.includes('Auth succeeded')).length);
    expect(logins[0]).toMatchObject({
      category: 'admin',
      severity: 'warning',
      important: true,
      ip: '192.168.1.137',
      text: `Admin login from ${PC_NAME} (192.168.1.137) (SSH, no password set)`,
    });
  });

  it('names WiFi by SSID and band', () => {
    const up = byKind(events, 'wifi-up');
    expect(up.map((e) => e.text)).toContain('WiFi netui-test (5 GHz) is on');
    expect(up.map((e) => e.text)).toContain('WiFi netui-test (2.4 GHz) is on');
    expect(byKind(events, 'wifi-down')[0]!.text).toMatch(/turned off$/);
  });

  it('reports LAN and port changes as System events', () => {
    expect(byKind(events, 'network-up')[0]).toMatchObject({ category: 'system', text: 'Network LAN is up' });
    expect(byKind(events, 'port-up').map((e) => e.text)).toContain('Port lan1 connected');
    expect(byKind(events, 'port-down').map((e) => e.text)).toContain('Port lan1 disconnected');
    // Radio netdevs are not ports.
    expect(events.find((e) => e.line === "netifd: Network device 'phy0-ap0' link is up")!.raw).toBe(true);
    expect(byKind(events, 'firewall-reload')[0]!.text).toBe('Firewall reloaded (LAN came up)');
  });

  it('keeps unrecognized warnings and errors listed as raw System events', () => {
    const err = events.find((e) => e.line.includes('rmdir[ctrl_interface'))!;
    expect(err).toMatchObject({ raw: true, category: 'system', severity: 'error', level: 'daemon.err' });
    expect(err.text).toBe('hostapd: rmdir[ctrl_interface=/var/run/hostapd]: Permission denied');
    expect(isListed(err)).toBe(true);
    const kernel = events.find((e) => e.id === 841)!;
    expect(kernel).toMatchObject({ raw: true, severity: 'info', level: 'kern.info', process: 'kernel' });
    expect(kernel.text).toBe('br-lan: port 1(lan1) entered blocking state');
    expect(isListed(kernel)).toBe(false);
  });

  it('falls back to hostnames and MACs without a client list', () => {
    const bare = parseEvents(real.log);
    expect(byKind(bare, 'dhcp-lease')[0]!.text).toBe(`Assigned 192.168.1.137 to ${PC_NAME}`);
    expect(byKind(bare, 'admin-login')[0]!.text).toBe('Admin login from 192.168.1.137 (SSH, no password set)');
    expect(byKind(bare, 'wifi-up')[0]!.text).toBe('WiFi phy0-ap0 is on');
  });
});

describe('parseEvents on the synthetic supplement', () => {
  const events = parseEvents(synthetic.log, context());
  const text = (kind: NetEvent['kind']) => byKind(events, kind).map((e) => e.text);

  it('reports station connects with the DHCP hostname once leased', () => {
    // The phone has no lease in the recorded client list: its MAC stands in
    // on connect, the hostname from its own DHCPACK in the lease line.
    expect(text('client-connected')).toEqual([`${PHONE} connected to netui-test (5 GHz)`]);
    expect(text('client-disconnected')).toEqual([`${PHONE} disconnected from netui-test (5 GHz)`]);
    expect(text('dhcp-lease')).toEqual(['Assigned 192.168.1.142 to iPhone']);
    expect(text('dhcp-release')).toEqual([`${PHONE} released 192.168.1.142`]);
    expect(text('wrong-password')).toEqual(['9e:12:aa:30:5b:77 tried to join netui-test (2.4 GHz) with the wrong password']);
  });

  it('resolves a MAC to the client name when the client list has it', () => {
    const named = parseEvents(synthetic.log, {
      ...context(),
      clients: [{ mac: PHONE, name: 'iPhone', randomMac: true }],
    });
    expect(byKind(named, 'client-connected')[0]!.text).toBe('iPhone connected to netui-test (5 GHz)');
  });

  it('reports the internet going up and down as important', () => {
    expect(text('internet-up')).toEqual(['Internet connected (IPv6)', 'Internet connected']);
    expect(text('internet-down')).toEqual(['Internet connection lost (IPv6)', 'Internet connection lost']);
    expect(byKind(events, 'internet-down').every((e) => e.important && e.severity === 'warning')).toBe(true);
    expect(text('port-down')).toEqual(['WAN port disconnected']);
    expect(byKind(events, 'port-down')[0]!.category).toBe('internet');
  });

  it('honours a custom uplink interface', () => {
    const custom = parseEvents([entry(1, "netifd: Interface 'wwan' is now up")], { wanNetworks: new Set(['wwan']) });
    expect(custom[0]!.text).toBe('Internet connected (wwan)');
  });

  it('reports logins and failed logins over ssh and LuCI', () => {
    expect(text('admin-login-failed')).toEqual([
      `Failed admin login from ${PC_NAME} (192.168.1.137) (LuCI)`,
      `Failed admin login from ${PC_NAME} (192.168.1.137) (SSH, root)`,
    ]);
    expect(text('admin-login')).toEqual([
      `Admin login from ${PC_NAME} (192.168.1.137) (SSH)`,
      `Admin login from ${PC_NAME} (192.168.1.137) (SSH)`,
      `Admin login from ${PC_NAME} (192.168.1.137) (LuCI)`,
    ]);
  });

  it('leaves station detail lines raw and unlisted', () => {
    const detail = events.filter((e) => e.line.includes('IEEE 802.11'));
    expect(detail.every((e) => e.raw && !isListed(e))).toBe(true);
  });
});

describe('router lifecycle', () => {
  it('recognizes boot, init complete and reboot', () => {
    const ev = parseEvents([
      entry(1, '[    0.000000] Linux version 6.12.51 (runner@runner) (aarch64-openwrt-linux-musl-gcc)', { source: 0, priority: 5 }),
      entry(2, 'procd: - init complete -'),
      entry(3, '[ 9999.1] procd: - reboot -', { source: 0 }),
    ]);
    expect(ev.map((e) => [e.kind, e.text, e.important])).toEqual([
      ['router-restarting', 'Router is restarting', true],
      ['router-ready', 'Router finished starting up', false],
      ['router-started', 'Router started (Linux 6.12.51)', true],
    ]);
  });
});

describe('collapseRepeats', () => {
  it('folds adjacent identical events', () => {
    const ev = parseEvents(real.log, context()).filter(isListed);
    const rows = collapseRepeats(ev);
    expect(rows.length).toBeLessThan(ev.length);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(ev.length);
  });
});

describe('mergeLog', () => {
  const a = [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')];

  it('adds new lines by id and returns the same array when nothing is new', () => {
    const merged = mergeLog(a, [entry(2, 'b'), entry(3, 'c'), entry(4, 'd')]);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(mergeLog(merged, [entry(4, 'd')])).toBe(merged);
  });

  it('starts over when the router rebooted', () => {
    expect(mergeLog(a, [entry(0, 'boot', { time: 5 }), entry(1, 'x', { time: 6 })]).map((e) => e.msg)).toEqual([
      'boot',
      'x',
    ]);
    // Same ids, different lines: the log restarted and grew past the old ids.
    const again = mergeLog(a, [entry(3, 'other', { time: 1 }), entry(4, 'd')]);
    expect(again.map((e) => e.msg)).toEqual(['other', 'd']);
  });

  it('caps the history', () => {
    expect(mergeLog(a, [entry(4, 'd')], 2).map((e) => e.id)).toEqual([3, 4]);
  });
});

describe('clockSkew', () => {
  // The recorded router's clock said Oct 2025 while the real date was later.
  const info = { uptime: 1000, localtime: 1760313790 };
  const kernelLine = real.log.find((e) => e.id === 1027)!; // [  944.808999]

  it('derives the router clock from a kernel line and uptime', () => {
    const routerNow = kernelLine.time - 944.808999 * 1000 + 1000 * 1000;
    const browserNow = routerNow + 365 * 86400_000;
    expect(clockSkew(real.log, info, browserNow)).toBeCloseTo(365 * 86400_000, -1);
  });

  it('ignores small differences', () => {
    const routerNow = kernelLine.time - 944.808999 * 1000 + 1000 * 1000;
    expect(clockSkew(real.log, info, routerNow + 30_000)).toBe(0);
  });

  it('falls back to localtime, ignoring time zone sized gaps', () => {
    const noKernel = real.log.filter((e) => e.source !== 0);
    expect(clockSkew(noKernel, info, info.localtime * 1000 + 2 * 3600_000)).toBe(0);
    expect(clockSkew(noKernel, info, info.localtime * 1000 + 40 * 86400_000)).toBe(40 * 86400_000);
    expect(clockSkew(noKernel, undefined, 5)).toBe(0);
  });
});

describe('time labels', () => {
  const now = new Date(2026, 10, 13, 15, 0, 0).getTime();
  it('formats relative times and day headings', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86400_000, now)).toBe('2d ago');
    expect(dayLabel(now - 3600_000, now)).toBe('Today');
    expect(dayLabel(now - 86400_000, now)).toBe('Yesterday');
    expect(dayLabel(new Date(2025, 9, 12).getTime(), now)).toMatch(/2025/);
  });
});

describe('notifications', () => {
  const events = parseEvents([...real.log, ...synthetic.log], context());

  it('takes the first log seen as known, then flags MACs that join later', () => {
    const baseline = trackMacs(parseEvents(real.log, context()), null);
    expect(baseline).toEqual({ [PC]: 0 });
    const known = trackMacs(events, baseline);
    expect(known[PHONE]).toBe(1041); // its AP-STA-CONNECTED
    expect(trackMacs(events, known)).toBe(known);

    const fresh = events.filter((e) => isNewClient(e, known));
    expect(fresh.map((e) => e.kind)).toEqual(['client-connected']);
    // Its later DHCPACK is not a second "new device".
    expect(notableEvents(events, known).filter((e) => e.mac === PHONE)).toHaveLength(1);
  });

  it('counts notable events after the last one seen', () => {
    const notable = notableEvents(events, {});
    const seen = { id: 1050, time: synthetic.log.find((e) => e.id === 1050)!.time };
    const unread = unreadEvents(notable, events, seen);
    expect(unread.every((e) => e.id > 1050)).toBe(true);
    expect(unread.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['internet-down', 'admin-login', 'admin-login-failed']),
    );
    expect(unreadEvents(notable, events, null)).toEqual([]);
  });

  it('treats everything as unread after the log restarted', () => {
    const notable = notableEvents(events, {});
    expect(unreadEvents(notable, events, { id: 99_999, time: 1 })).toEqual(notable);
    expect(unreadEvents(notable, events, { id: 1050, time: 1 })).toEqual(notable);
  });
});
