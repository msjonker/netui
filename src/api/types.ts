// Response types for the ubus calls netui makes, typed against recordings in
// test/fixtures/ubus/ (OpenWrt 25.12.5). Only fields the UI reads are listed;
// everything else is left out rather than guessed. Optional marks fields seen
// missing in at least one recording.

// --- network.interface dump -------------------------------------------------

export interface IfaceAddress {
  address: string;
  mask: number;
}

export interface IfaceRoute {
  target: string;
  mask: number;
  nexthop: string;
  source?: string;
}

export interface InterfaceStatus {
  interface: string;
  up: boolean;
  pending?: boolean;
  available?: boolean;
  proto: string;
  device?: string;
  l3_device?: string;
  uptime?: number;
  'ipv4-address'?: IfaceAddress[];
  'ipv6-address'?: IfaceAddress[];
  'dns-server'?: string[];
  route?: IfaceRoute[];
}

export interface InterfaceDump {
  interface: InterfaceStatus[];
}

// --- network.device status --------------------------------------------------

export interface DeviceStatistics {
  rx_bytes: number;
  tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
  rx_errors: number;
  tx_errors: number;
  rx_dropped: number;
  tx_dropped: number;
}

export interface DeviceStatus {
  /** "Network device", "bridge", ... */
  type: string;
  /** "ethernet", "bridge", "wlan"; absent for lo. */
  devtype?: string;
  up: boolean;
  present?: boolean;
  carrier: boolean;
  /** e.g. "1000F", "100H", "-1" when unknown. */
  speed?: string;
  macaddr?: string;
  mtu?: number;
  'bridge-members'?: string[];
  /** Bridges only. Many more attributes are reported; this is the one read. */
  'bridge-attributes'?: { vlan_filtering: boolean };
  /**
   * Bridges with VLAN filtering. Port tokens are "eth0:*" (untagged, PVID),
   * "eth2:t" (tagged), "eth3" (untagged, no PVID). No "u" here, unlike UCI.
   */
  'bridge-vlans'?: BridgeVlanStatus[];
  statistics: DeviceStatistics;
}

export interface BridgeVlanStatus {
  id: number;
  local?: boolean;
  ports: string[];
}

export type DeviceStatusMap = Record<string, DeviceStatus>;

// --- system -----------------------------------------------------------------

export interface SystemInfo {
  localtime: number;
  uptime: number;
  /** 1/5/15 minute load averages, scaled by 65536. */
  load: [number, number, number];
  memory: {
    total: number;
    free: number;
    available?: number;
    shared: number;
    buffered: number;
    cached?: number;
  };
  root?: { total: number; free: number; used: number; avail: number };
}

export interface SystemBoard {
  hostname: string;
  model: string;
  board_name: string;
  kernel: string;
  system: string;
  release: {
    distribution: string;
    version: string;
    revision: string;
    target: string;
    description: string;
  };
}

// --- luci-rpc ---------------------------------------------------------------

/**
 * /etc/board.json as generated at first boot: the factory port layout. The VM
 * recording only has `device` per role; DSA boards list their user ports as
 * `ports` instead (e.g. lan: { ports: ["lan1", ...] }), so both are optional.
 */
export interface BoardJson {
  model?: { id: string; name: string };
  network?: Record<string, { device?: string; ports?: string[]; protocol?: string }>;
  /** Present on swconfig boards. */
  switch?: Record<string, unknown>;
}

/** One swconfig switch in board.json (test/fixtures/ubus/ap/tl-wdr4300/board.json). */
export interface BoardSwitch {
  enable?: boolean;
  reset?: boolean;
  /** The CPU port has `device` (eth0); front ports have a role ("lan", "wan") and lan ports an index. */
  ports: { num: number; device?: string; need_tag?: boolean; want_untag?: boolean; role?: string; index?: number }[];
  roles?: { role: string; ports: string; device: string }[];
}

/** netui.agent ports on an access point (netui-agent 0.4+). */
export interface AgentPorts {
  network: NonNullable<BoardJson['network']>;
  switch: Record<string, BoardSwitch> | null;
  /** Live state of the swconfig switch's ports, and the port where it learned the gateway's MAC. */
  switch_state: {
    name: string;
    ports: { num: number; up: boolean; speed: number | null; duplex?: 'full' | 'half' }[];
    uplink: number | null;
  } | null;
  /** The bridge port behind which the gateway's MAC was learned: a port, a VLAN device or the mesh. */
  uplink: string | null;
}

export interface DhcpLease {
  /** Seconds remaining; false for static leases on some releases. */
  expires: number | false;
  hostname?: string;
  /** Uppercase, as dnsmasq reports it. Normalize before comparing. */
  macaddr: string;
  ipaddr: string;
}

export interface DhcpLeases {
  dhcp_leases: DhcpLease[];
  dhcp6_leases: unknown[];
}

export interface HostHint {
  name?: string;
  ipaddrs: string[];
  ip6addrs: string[];
}

/** Keyed by uppercase MAC. */
export type HostHints = Record<string, HostHint>;

// --- iwinfo -----------------------------------------------------------------

export interface IwinfoDevices {
  devices: string[];
}

/**
 * `hostapd.<ifname> get_status`, the fields netui reads
 * (dl-wrx36/plain/hostapd.phy0-ap0.get_status.json). The object only exists
 * while hostapd runs that access point.
 */
export interface HostapdStatus {
  /** "ENABLED" once beaconing; "DFS" during the channel availability check. */
  status: string;
  ssid?: string;
  bssid?: string;
  phy?: string;
  channel?: number;
  freq?: number;
}

export interface IwinfoInfo {
  phy: string;
  ssid?: string;
  bssid?: string;
  /** "Master", "Client", ... */
  mode?: string;
  channel?: number;
  frequency?: number;
  /** "2.4 GHz", "5 GHz", ... absent on older releases. */
  band?: string;
  txpower?: number;
  signal?: number;
  noise?: number;
  quality?: number;
  quality_max?: number;
  bitrate?: number;
  country?: string;
  htmode?: string;
  hwmodes?: string[];
  encryption?: { enabled: boolean; description?: string };
}

export interface AssocRate {
  rate: number;
  mcs?: number;
  '40mhz'?: boolean;
  short_gi?: boolean;
}

export interface AssocStation {
  mac: string;
  signal: number;
  signal_avg?: number;
  noise: number;
  inactive: number;
  connected_time?: number;
  rx: AssocRate & { packets: number; bytes?: number };
  tx: AssocRate & { packets: number; bytes?: number };
}

export interface AssocList {
  results: AssocStation[];
}

// --- uci --------------------------------------------------------------------

/** UCI options are strings or lists of strings. */
export type UciValue = string | string[];

export interface UciSection {
  '.anonymous': boolean;
  '.index': number;
  '.name': string;
  '.type': string;
  [option: string]: UciValue | boolean | number;
}

export type UciConfig = Record<string, UciSection>;

export interface UciGet {
  values: UciConfig;
}

/**
 * One staged change as reported by `uci changes`:
 *   ["set", section, option, value] / ["set", section, type] for a new named section
 *   ["add", section, type]
 *   ["remove", section] / ["remove", section, option]
 *   ["list-add", section, option, value] / ["list-del", ...]
 *   ["rename", section, option?, name] / ["order", section, index]
 */
export type UciChange = [op: string, section: string, ...rest: string[]];

export interface UciChangesAll {
  changes: Record<string, UciChange[]>;
}

// --- Internet / SQM / UPnP / DDNS -------------------------------------------

/** One active port map from `luci.upnp get_status` (/usr/share/rpcd/ucode/luci.upnp). */
export interface UpnpRule {
  /** Row number; the token for `luci.upnp delete_rule`. */
  num: string;
  proto: string;
  extport: number;
  intaddr: string;
  intport: number;
  descr: string;
  /** Seconds left on the lease, when the lease file has it. */
  expires?: number;
  host_hint?: string;
}

export interface UpnpStatus {
  rules: UpnpRule[];
}

/** One service from `luci.ddns get_services_status`, keyed by section name. */
export interface DdnsServiceStatus {
  ip: string | null;
  last_update: string | null;
  /** A formatted date, or "Stopped", "Disabled", "Verify", "Run once". */
  next_update: string | null;
  next_check: string | null;
  pid: number | null;
}

export type DdnsServicesStatus = Record<string, DdnsServiceStatus>;

// --- Routing / DNS / System -------------------------------------------------

/** `luci getTimezones`: zone name (with spaces, as LuCI stores it) -> POSIX TZ string. */
export type LuciTimezones = Record<string, { tzstring: string }>;

/** `luci getUnixtime` (luci-base 26.x, bench-v2/gateway.luci.getUnixtime.json) or the older `luci getLocaltime`: the router's clock, Unix seconds. */
export interface LuciLocaltime {
  result: number;
}

// --- WiFi -------------------------------------------------------------------
// Recorded on the DL-WRX36 (test/fixtures/ubus/dl-wrx36/plain/iwinfo.*). The
// iwinfo calls accept a wifi-device section name ("radio0") as device, which
// works while the radio has no interface up; survey needs a live netdev.

/** Extra `iwinfo info` fields, merged into IwinfoInfo above. */
export interface IwinfoInfo {
  /** Widths the phy supports, e.g. ["HT20", ..., "HE160"]. */
  htmodes?: string[];
}

export interface IwinfoFreq {
  /** 2, 5, 6 (GHz). */
  band: number;
  channel: number;
  mhz: number;
  active: boolean;
  /**
   * Not reliable on rpcd-mod-iwinfo 2025.10 / SNAPSHOT: `flags` and
   * `restricted` change between identical calls. Not read.
   */
  restricted?: boolean;
  flags?: string[];
}

export interface IwinfoFreqList {
  results: IwinfoFreq[];
}

export interface IwinfoTxPower {
  dbm: number;
  mw: number;
  active: boolean;
}

export interface IwinfoTxPowerList {
  results: IwinfoTxPower[];
}

export interface IwinfoCountry {
  code: string;
  country: string;
  iso3166: string;
  active: boolean;
}

export interface IwinfoCountryList {
  results: IwinfoCountry[];
}

/** One channel's counters. Times are cumulative ms; noise is an unsigned byte (146 = -110 dBm). */
export interface IwinfoSurveyEntry {
  mhz: number;
  noise: number;
  active_time: number;
  busy_time: number;
  busy_time_ext?: number;
  rx_time?: number;
  tx_time?: number;
}

export interface IwinfoSurvey {
  results: IwinfoSurveyEntry[];
}

// --- VPN (luci.wireguard, /usr/share/rpcd/ucode/luci.wireguard) -------------
// generateKeyPair/generatePsk recorded in test/fixtures/ubus/dl-wrx36/plain/.
// getWgInstances was recorded empty ({}); the populated shape below is typed
// from the ucode source, which splits `wg show all dump` lines, so every
// number arrives as a string ("0" handshake = never, "off" keepalive/fwmark).

export interface WgKeyPair {
  keys: { priv: string; pub: string };
}

export interface WgPsk {
  psk: string;
}

export interface WgPeerStatus {
  /** The peer section's `description`; absent when it has none. */
  name?: string | null;
  public_key: string;
  /** "203.0.113.7:51234", "[2001:db8::1]:51234" or "(none)". */
  endpoint: string;
  /** Only filled once the peer has an endpoint (a quirk of the ucode). */
  allowed_ips: string[];
  /** Unix seconds as a string; "0" when never. */
  latest_handshake: string;
  /** Bytes received from the peer. */
  transfer_rx: string;
  /** Bytes sent to the peer. */
  transfer_tx: string;
  /** Seconds or "off". */
  persistent_keepalive: string;
}

export interface WgInstance {
  name: string;
  public_key: string;
  listen_port: string;
  fwmark: string;
  peers: WgPeerStatus[];
}

/** Keyed by netdev name, which for proto wireguard is the interface name. */
export type WgInstances = Record<string, WgInstance>;

// --- Events / Topology ------------------------------------------------------

/**
 * One line from `log read` (logd's ring buffer), as recorded in
 * test/fixtures/ubus/dl-wrx36/plain/log.read.json. `priority` is the syslog
 * facility * 8 + severity; `source` 0 is the kernel, 1 syslog. `time` is ms
 * since the epoch by the router's clock, which may be wrong (no NTP); `id`
 * increases per line and restarts at boot.
 */
export interface LogEntry {
  id: number;
  msg: string;
  priority: number;
  source: number;
  time: number;
}

export interface LogRead {
  log: LogEntry[];
}

// --- Clients / Insights -----------------------------------------------------
// Recorded on the DL-WRX36 (test/fixtures/ubus/dl-wrx36/plain/).

/**
 * One `luci getConntrackList` entry. luci.sys parses /proc/net/nf_conntrack:
 * src/dst/ports are the ORIGINAL direction only (the reply tuple, and with it
 * any NAT translation, is dropped), and bytes/packets are the sum of both
 * directions (needs nf_conntrack_acct=1). TIME_WAIT entries are skipped.
 */
export interface ConntrackEntry {
  /** "ipv4" | "ipv6" */
  layer3: string;
  /** "tcp", "udp", "icmp", ... */
  layer4: string;
  src: string;
  dst: string;
  /** Absent for ICMP. */
  sport?: number;
  dport?: number;
  bytes: number;
  packets: number;
  timeout: number;
  zone?: string;
}

export interface ConntrackList {
  result: ConntrackEntry[];
}

/** `iwinfo scan` result. Widths are iwinfo's encoding; see model/rf.ts. */
export interface IwinfoScanEntry {
  /** 2, 5, 6 (GHz). */
  band: number;
  bssid: string;
  channel: number;
  mhz: number;
  /** "Master", "Mesh Point", "Ad-Hoc", ... */
  mode: string;
  /** null for a hidden SSID. */
  ssid?: string | null;
  signal: number;
  quality?: number;
  quality_max?: number;
  encryption?: { enabled: boolean; authentication?: string[]; ciphers?: string[]; wpa?: number[] };
  ht_operation?: { channel_width: number; primary_channel: number; secondary_channel_offset: string };
  vht_operation?: { channel_width: number; center_freq_1: number; center_freq_2: number };
}

export interface IwinfoScan {
  results: IwinfoScanEntry[];
}

/** Extra `network.interface dump` field: IPv6 prefixes handed to this interface. */
export interface InterfaceStatus {
  'ipv6-prefix-assignment'?: { address: string; mask: number; 'local-address'?: IfaceAddress }[];
}

// ---------------------------------------------------------------------------
// --- Devices: netui.devices on the gateway (test/fixtures/ubus/bench-v2)

/** An access point adopted by this gateway. */
export interface ManagedDevice {
  mac: string;
  name: string;
  model?: string;
  board_name?: string;
  /** Current address (DHCP lease by MAC), else the last one seen. */
  ip?: string;
  online: boolean;
  hostname?: string;
  release?: string;
  /** netui-agent version, only while online. */
  agent?: string;
  /** Unix seconds. */
  adopted_at?: number;
}

/** An access point running netui-agent that no gateway here has adopted. */
export interface PendingDevice {
  ip: string;
  mac: string;
  hostname?: string;
  model?: string;
  release?: string;
  agent?: string;
  /** Adopted by some other gateway. */
  adopted: boolean;
}

export interface ManagedDeviceList {
  devices: ManagedDevice[];
}

export interface PendingDeviceList {
  devices: PendingDevice[];
}

/** netui.devices methods report failures as data, not as a ubus status. */
export interface DevicePluginError {
  error?: string;
}

export interface AdoptResult extends DevicePluginError {
  device?: ManagedDevice;
}

/** A call relayed to an access point: its ubus status and data, or a transport error. */
export interface RelayResult<T> extends DevicePluginError {
  status?: number;
  data?: T;
  code?: number;
  ip?: string;
}

export interface SyncOutcome extends DevicePluginError {
  result?: boolean;
  /** WiFi networks mirrored onto the device. */
  networks?: number;
  /** SSIDs whose network this access point does not carry. */
  skipped?: string[];
  /** Why the gateway's networks could not be carried to it (set by syncDevices, not the plugin). */
  networkError?: string;
}

export interface SyncResult {
  devices: Record<string, SyncOutcome>;
}

export interface DeviceCredentials extends DevicePluginError {
  username?: string;
  password?: string;
}

// --- netui.firmware ---------------------------------------------------------
// The firmware plugin on the gateway and, through netui.devices call, on
// access points. Recorded in test/fixtures/ubus/bench-v2/netui.firmware.*.

/** The current or last owut run. `log` is the tail of owut's output. */
export interface FirmwareJob {
  action: 'check' | 'upgrade';
  version: string | null;
  started: number;
  running: boolean;
  exit: number | null;
  log: string;
}

export interface FirmwareStatus extends DevicePluginError {
  /** owut is installed. */
  available: boolean;
  /** DISTRIB_RELEASE, e.g. "25.12.6". */
  installed?: string;
  job: FirmwareJob | null;
  /** From the last check: each release branch and its newest version. */
  branches: { current: string; latest: Record<string, string> } | null;
}

export interface FirmwareStarted extends DevicePluginError {
  result?: boolean;
}

// --- netui.speedtest --------------------------------------------------------
// The gateway's speed test plugin (bench-v2/netui.speedtest.status.*).

/** One finished run. Speeds in bit/s, latency in ms, `at` in Unix seconds. */
export interface SpeedTestResult {
  at: number;
  download: number;
  upload: number;
  ping: number;
  jitter: number;
  server?: string;
}

export interface SpeedTestStatus {
  available: boolean;
  tool: 'librespeed' | 'speedtestcpp' | null;
  running: boolean;
  started: number | null;
  /** Why the last run failed, until the next one starts. */
  error: string | null;
  /** Newest first. */
  history: SpeedTestResult[];
}

// --- nlbwmon (usage history) ------------------------------------------------

/** `file exec` result: rpcd leaves out stdout/stderr when they are empty. */
export interface FileExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** `nlbw -c json -g mac,layer7` (bench-v2/gateway.nlbw.json.mac-layer7.json). */
export interface NlbwTable {
  columns: string[];
  data: (string | number | null)[][];
}

// --- mwan3 ------------------------------------------------------------------
// `mwan3 status` (bench-v2/gateway.mwan3.status.json).

export interface MwanTrackIp {
  ip: string;
  status: string;
  latency: number;
  packetloss: number;
}

export interface MwanInterfaceStatus {
  /** online, offline, connecting, disconnecting, disabled, unknown. */
  status: string;
  enabled: boolean;
  running?: boolean;
  up?: boolean;
  uptime?: number;
  tracking?: string;
  track_ip?: MwanTrackIp[];
}

export interface MwanStatus {
  interfaces: Record<string, MwanInterfaceStatus>;
  policies?: { ipv4?: Record<string, { interface: string; percent: number }[]> };
}

// --- netui.services ---------------------------------------------------------

/** `netui.services adblock` (bench-v2/netui.services.adblock.*): adblock-fast's procd data. */
export interface AdblockStatus {
  installed: boolean;
  /** netui's last apply (download and start, or stop) is still running. */
  busy?: boolean;
  /** statusSuccess, statusDownloading, statusError, ...; null when stopped. */
  status?: string | null;
  message?: string | null;
  /** Domains blocked now. */
  entries?: number | null;
  errors?: { code: string; info?: string }[];
  warnings?: { code: string; info?: string }[];
  version?: string | null;
}

/** One device openNDS knows, from `ndsctl json` (bench-v2/gateway.ndsctl.json.*). Times in Unix seconds, data in kB. */
export interface PortalClient {
  mac: string;
  ip?: string;
  /** Preauthenticated (sees the portal) or Authenticated (signed in). */
  state: string;
  session_start: number | null;
  session_end: number | null;
  last_active: number | null;
  download: number | null;
  upload: number | null;
}

/** `netui.services portal` (bench-v2/netui.services.portal.*). */
export interface PortalStatus {
  installed: boolean;
  busy?: boolean;
  running?: boolean;
  clients?: PortalClient[];
}

/**
 * `netui.services tunnel` (dl-wrx36/plain/netui.services.tunnel.json,
 * cloudflared 2026.10.6): Cloudflare Tunnel's state. Never the token itself.
 */
export interface TunnelStatus {
  installed: boolean;
  /** cloudflared's `config` section exists. */
  section?: boolean;
  enabled?: boolean;
  /** A token is set. */
  token?: boolean;
  /** The tunnel's ID, from the token. */
  tunnel?: string | null;
  /** Enabled without a token: runs from a config.yml set up outside netui. */
  config_file?: boolean;
  running?: boolean;
  /** Connections to the edge (the metrics server's /ready); null when not running. */
  connections?: number | null;
  connector?: string | null;
  /** Edge locations of the registered connections, e.g. "ams01". */
  locations?: string[];
  /** The last error cloudflared logged since it started. */
  error?: string | null;
}

// --- netui.users -------------------------------------------------------------

export type NetuiRole = 'admin' | 'viewer';

/** `netui.users list`: rpcd logins with netui's groups; never their hashes. */
export interface NetuiUser {
  username: string;
  role: NetuiRole;
}

// --- netui.tailscale -------------------------------------------------------
// Recorded in test/fixtures/ubus/dl-wrx36/plain/tailscale.status.json
// (tailscale 1.104.1). Only the fields netui reads are typed.

export interface TailscalePeerRaw {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[] | null;
  Online?: boolean;
  ExitNode?: boolean;
}

export interface TailscaleStatusRaw {
  Version?: string;
  /** NoState, NeedsLogin, NeedsMachineAuth, Stopped, Starting, Running. */
  BackendState?: string;
  AuthURL?: string;
  TailscaleIPs?: string[] | null;
  Self?: TailscalePeerRaw;
  Health?: string[] | null;
  CurrentTailnet?: { Name?: string } | null;
  Peer?: Record<string, TailscalePeerRaw> | null;
}

export interface TailscalePrefsRaw {
  AdvertiseRoutes?: string[] | null;
  WantRunning?: boolean;
  LoggedOut?: boolean;
}

export interface TailscaleStatus {
  installed: boolean;
  status?: TailscaleStatusRaw | null;
  prefs?: TailscalePrefsRaw | null;
  error?: string | null;
  loggingIn?: boolean;
}

// --- netui.packages ---------------------------------------------------------
// Optional packages ("add-ons") netui installs from a fixed list
// (bench-v2/netui.packages.status.*).

export type AddonKey =
  | 'adblock'
  | 'portal'
  | 'multiwan'
  | 'usage'
  | 'sqm'
  | 'upnp'
  | 'ddns'
  | 'wireguard'
  | 'schedule'
  | 'steering'
  | 'speedtest'
  | 'firmware'
  | 'wol'
  | 'doh'
  | 'tailscale'
  | 'tunnel'
  | 'mesh';

export interface PackagesJob {
  action: 'install' | 'remove';
  addon: AddonKey;
  packages: string[];
  started: number;
  running: boolean;
  exit: number | null;
  log: string;
}

export interface PackagesStatus {
  manager: 'apk' | 'opkg' | null;
  /** Free storage in KiB. */
  free: number | null;
  addons: Partial<Record<AddonKey, { installed: boolean }>>;
  job: PackagesJob | null;
}

// netui.history (openwrt/files/usr/share/rpcd/ucode/netui-history), recorded
// in test/fixtures/ubus/dl-wrx36/plain/netui.history.*.json.

export interface HistoryEntry {
  id: number;
  /** Epoch seconds. */
  time: number;
  packages: string[];
  /** Who applied it (netui login); absent for outside changes. */
  user?: string;
  /** The netui page it was applied from. */
  page?: string;
  /** Changed by something other than netui (LuCI, ssh, a service), noticed later. */
  outside?: boolean;
}

export interface HistoryList {
  entries: HistoryEntry[];
  /** Packages whose committed config differs from the last recorded state. */
  changed: string[];
}

export interface HistoryDetail {
  id: number;
  time: number;
  /** null: the package did not exist (or its state was pruned). */
  before: Record<string, UciConfig | null>;
  after: Record<string, UciConfig | null>;
}
