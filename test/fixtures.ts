// Typed access to recorded ubus responses. The casts are the point where a
// recording is asserted to match api/types.ts; tsc checks structural
// compatibility of the JSON against the declared type.

import type {
  BoardJson,
  DeviceStatusMap,
  DhcpLeases,
  HostHints,
  InterfaceDump,
  SystemBoard,
  SystemInfo,
  UciGet,
} from '../src/api/types';
import ifaceDump from './fixtures/ubus/dev-container/network.interface.dump.json';
import deviceStatus from './fixtures/ubus/dev-container/network.device.status.json';
import systemInfo from './fixtures/ubus/dev-container/system.info.json';
import systemBoard from './fixtures/ubus/dev-container/system.board.json';
import leases from './fixtures/ubus/dev-container/luci-rpc.getDHCPLeases.json';
import hints from './fixtures/ubus/dev-container/luci-rpc.getHostHints.json';
import board from './fixtures/ubus/dev-container/luci-rpc.getBoardJSON.json';
import uciNetwork from './fixtures/ubus/dev-container/uci.get.network.json';
import uciDhcp from './fixtures/ubus/dev-container/uci.get.dhcp.json';
import uciFirewall from './fixtures/ubus/dev-container/uci.get.firewall.json';

// Plain assignments, not casts: tsc fails here if a recording stops matching
// its type. (`load` is the one tuple JSON cannot express.)
const checked: {
  ifaceDump: InterfaceDump;
  deviceStatus: DeviceStatusMap;
  systemInfo: Omit<SystemInfo, 'load'> & { load: number[] };
  systemBoard: SystemBoard;
  leases: DhcpLeases;
  hints: HostHints;
  board: BoardJson;
  uci: Record<'network' | 'dhcp' | 'firewall', UciGet>;
} = {
  ifaceDump,
  deviceStatus,
  systemInfo,
  systemBoard,
  leases,
  hints,
  board,
  uci: { network: uciNetwork, dhcp: uciDhcp, firewall: uciFirewall },
};

const clone = <T,>(v: unknown): T => structuredClone(v) as T;

export const fixtures = {
  ifaceDump: () => clone<InterfaceDump>(checked.ifaceDump),
  deviceStatus: () => clone<DeviceStatusMap>(checked.deviceStatus),
  systemInfo: () => clone<SystemInfo>(checked.systemInfo),
  systemBoard: () => clone<SystemBoard>(checked.systemBoard),
  leases: () => clone<DhcpLeases>(checked.leases),
  hints: () => clone<HostHints>(checked.hints),
  board: () => clone<BoardJson>(checked.board),
  uci: {
    network: () => clone<UciGet>(checked.uci.network).values,
    dhcp: () => clone<UciGet>(checked.uci.dhcp).values,
    firewall: () => clone<UciGet>(checked.uci.firewall).values,
  },
};

// Recordings from the test VM (dev/vm), one directory per scenario:
//   plain: br-lan with eth0, eth2-eth4, no VLAN filtering (a fresh install)
//   vlan:  VLAN 1 (lan) native on eth0/eth2/eth3; VLAN 20 (iot) tagged on
//          eth2, bare "eth3" (untagged, not PVID) and bare "eth4" (sole VLAN)
import vmPlainNetwork from './fixtures/ubus/vm/plain/uci.get.network.json';
import vmPlainDhcp from './fixtures/ubus/vm/plain/uci.get.dhcp.json';
import vmPlainFirewall from './fixtures/ubus/vm/plain/uci.get.firewall.json';
import vmPlainDevices from './fixtures/ubus/vm/plain/network.device.status.json';
import vmPlainIfaces from './fixtures/ubus/vm/plain/network.interface.dump.json';
import vmPlainBoard from './fixtures/ubus/vm/plain/luci-rpc.getBoardJSON.json';
import vmVlanNetwork from './fixtures/ubus/vm/vlan/uci.get.network.json';
import vmVlanDhcp from './fixtures/ubus/vm/vlan/uci.get.dhcp.json';
import vmVlanFirewall from './fixtures/ubus/vm/vlan/uci.get.firewall.json';
import vmVlanDevices from './fixtures/ubus/vm/vlan/network.device.status.json';
import vmVlanIfaces from './fixtures/ubus/vm/vlan/network.interface.dump.json';
import vmVlanBoard from './fixtures/ubus/vm/vlan/luci-rpc.getBoardJSON.json';

interface VmScenario {
  uci: Record<'network' | 'dhcp' | 'firewall', UciGet>;
  deviceStatus: DeviceStatusMap;
  ifaceDump: InterfaceDump;
  board: BoardJson;
}

const vm: Record<'plain' | 'vlan', VmScenario> = {
  plain: {
    uci: { network: vmPlainNetwork, dhcp: vmPlainDhcp, firewall: vmPlainFirewall },
    deviceStatus: vmPlainDevices,
    ifaceDump: vmPlainIfaces,
    board: vmPlainBoard,
  },
  vlan: {
    uci: { network: vmVlanNetwork, dhcp: vmVlanDhcp, firewall: vmVlanFirewall },
    deviceStatus: vmVlanDevices,
    ifaceDump: vmVlanIfaces,
    board: vmVlanBoard,
  },
};

export type VmScenarioName = keyof typeof vm;

export const vmFixtures = (name: VmScenarioName) => ({
  uci: {
    network: () => clone<UciGet>(vm[name].uci.network).values,
    dhcp: () => clone<UciGet>(vm[name].uci.dhcp).values,
    firewall: () => clone<UciGet>(vm[name].uci.firewall).values,
  },
  deviceStatus: () => clone<DeviceStatusMap>(vm[name].deviceStatus),
  ifaceDump: () => clone<InterfaceDump>(vm[name].ifaceDump),
  board: () => clone<BoardJson>(vm[name].board),
});

// Dynalink DL-WRX36 (real hardware, DSA, OpenWrt SNAPSHOT), radios disabled as shipped:
//   plain: factory config, lan1-lan4 in br-lan, wan on its own port
//   vlan:  isolated "iot" network on VLAN 10 tagged on lan1-lan4, created through netui
import wrxPlainNetwork from './fixtures/ubus/dl-wrx36/plain/uci.get.network.json';
import wrxPlainWireless from './fixtures/ubus/dl-wrx36/plain/uci.get.wireless.json';
import wrxPlainDhcp from './fixtures/ubus/dl-wrx36/plain/uci.get.dhcp.json';
import wrxPlainFirewall from './fixtures/ubus/dl-wrx36/plain/uci.get.firewall.json';
import wrxPlainDevices from './fixtures/ubus/dl-wrx36/plain/network.device.status.json';
import wrxPlainIfaces from './fixtures/ubus/dl-wrx36/plain/network.interface.dump.json';
import wrxPlainBoard from './fixtures/ubus/dl-wrx36/plain/luci-rpc.getBoardJSON.json';
import wrxPlainSystemInfo from './fixtures/ubus/dl-wrx36/plain/system.info.json';
import wrxPlainSystemBoard from './fixtures/ubus/dl-wrx36/plain/system.board.json';
import wrxVlanNetwork from './fixtures/ubus/dl-wrx36/vlan/uci.get.network.json';
import wrxVlanWireless from './fixtures/ubus/dl-wrx36/vlan/uci.get.wireless.json';
import wrxVlanDhcp from './fixtures/ubus/dl-wrx36/vlan/uci.get.dhcp.json';
import wrxVlanFirewall from './fixtures/ubus/dl-wrx36/vlan/uci.get.firewall.json';
import wrxVlanDevices from './fixtures/ubus/dl-wrx36/vlan/network.device.status.json';
import wrxVlanIfaces from './fixtures/ubus/dl-wrx36/vlan/network.interface.dump.json';
import wrxVlanBoard from './fixtures/ubus/dl-wrx36/vlan/luci-rpc.getBoardJSON.json';
import wrxVlanSystemInfo from './fixtures/ubus/dl-wrx36/vlan/system.info.json';
import wrxVlanSystemBoard from './fixtures/ubus/dl-wrx36/vlan/system.board.json';

interface WrxScenario {
  uci: Record<'network' | 'wireless' | 'dhcp' | 'firewall', UciGet>;
  deviceStatus: DeviceStatusMap;
  ifaceDump: InterfaceDump;
  board: BoardJson;
  systemInfo: Omit<SystemInfo, 'load'> & { load: number[] };
  systemBoard: SystemBoard;
}

const wrx: Record<'plain' | 'vlan', WrxScenario> = {
  plain: {
    uci: { network: wrxPlainNetwork, wireless: wrxPlainWireless, dhcp: wrxPlainDhcp, firewall: wrxPlainFirewall },
    deviceStatus: wrxPlainDevices,
    ifaceDump: wrxPlainIfaces,
    board: wrxPlainBoard,
    systemInfo: wrxPlainSystemInfo,
    systemBoard: wrxPlainSystemBoard,
  },
  vlan: {
    uci: { network: wrxVlanNetwork, wireless: wrxVlanWireless, dhcp: wrxVlanDhcp, firewall: wrxVlanFirewall },
    deviceStatus: wrxVlanDevices,
    ifaceDump: wrxVlanIfaces,
    board: wrxVlanBoard,
    systemInfo: wrxVlanSystemInfo,
    systemBoard: wrxVlanSystemBoard,
  },
};

export const wrxFixtures = (name: keyof typeof wrx) => ({
  uci: {
    network: () => clone<UciGet>(wrx[name].uci.network).values,
    wireless: () => clone<UciGet>(wrx[name].uci.wireless).values,
    dhcp: () => clone<UciGet>(wrx[name].uci.dhcp).values,
    firewall: () => clone<UciGet>(wrx[name].uci.firewall).values,
  },
  deviceStatus: () => clone<DeviceStatusMap>(wrx[name].deviceStatus),
  ifaceDump: () => clone<InterfaceDump>(wrx[name].ifaceDump),
  board: () => clone<BoardJson>(wrx[name].board),
  systemInfo: () => clone<SystemInfo>(wrx[name].systemInfo),
  systemBoard: () => clone<SystemBoard>(wrx[name].systemBoard),
});
