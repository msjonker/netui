import type { AddonKey, PackagesJob } from '../api/types';

// What each add-on is for, in the words the install dialog and the Add-ons
// list use. Sizes are the storage each needs once installed (measured with
// `apk add --simulate` on 25.12), so the dialog can say so before asking the
// router, which checks the real free space itself.

export interface AddonInfo {
  label: string;
  description: string;
  /** Storage needed, MB. */
  mb: number;
  /** Something the user should know before installing. */
  note?: string;
}

export const ADDONS: Record<AddonKey, AddonInfo> = {
  adblock: { label: 'Ad blocking', description: 'Blocks ads and trackers for every device on the network.', mb: 1 },
  portal: { label: 'Guest portal', description: 'A sign-in page for a guest network. Installed switched off.', mb: 0.6 },
  multiwan: { label: 'Multi-WAN', description: 'A second internet connection for failover or load balancing.', mb: 1.7 },
  usage: { label: 'Usage history', description: 'Monthly usage per device and per application.', mb: 0.1 },
  sqm: { label: 'Smart Queues', description: 'Keeps calls and games smooth while the connection is busy.', mb: 1.3 },
  upnp: { label: 'UPnP', description: 'Lets game consoles and apps open the ports they need.', mb: 0.2 },
  ddns: { label: 'Dynamic DNS', description: 'A name for your home address when your provider changes it.', mb: 0.1 },
  wireguard: {
    label: 'WireGuard VPN',
    description: 'A VPN server to reach home, and the router as a VPN client.',
    mb: 0.5,
    note: 'Restart the router afterwards so it can use the new VPN type.',
  },
  schedule: { label: 'WiFi schedules', description: 'Turns WiFi off and on at set times.', mb: 0.1 },
  steering: { label: 'Client steering', description: 'Moves devices to the best band and the nearest access point.', mb: 0.1 },
  speedtest: {
    label: 'Speed test',
    description: 'Measures the internet speed from the router.',
    mb: 8.1,
    note: 'Routers with little storage get a smaller version (2.8 MB).',
  },
  firmware: { label: 'Firmware updates', description: 'Updates the firmware from netui, keeping settings and add-ons.', mb: 0.2 },
  wol: { label: 'Wake-on-LAN', description: 'Wakes a sleeping computer from its client panel.', mb: 0.1 },
  doh: { label: 'DNS over HTTPS', description: 'Encrypts the router’s DNS lookups. Installed switched off.', mb: 1 },
  tailscale: { label: 'Tailscale', description: 'Remote access that works even behind carrier-grade NAT.', mb: 26, note: 'Needs a Tailscale account.' },
  mesh: {
    label: 'Full WiFi package (mesh)',
    description: 'Replaces the basic WiFi software with the full one, which wireless mesh needs.',
    mb: 0.7,
    note: 'WiFi restarts once: devices drop off for about a minute and reconnect.',
  },
};

/** The step a job is on: its last log line, without apk's progress noise. */
export function jobStep(job: PackagesJob): string {
  const lines = job.log
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\(\d+\/\d+\)|^Executing|^OK:|^\*/.test(l));
  return lines.at(-1) ?? 'Starting';
}

/** Why a job failed, in a sentence. */
export function jobError(job: PackagesJob): string {
  const space = /Not enough space[^\n]*/.exec(job.log)?.[0];
  if (space) return space;
  const lines = job.log.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /^ERROR|error|fail|unable|not found/i.test(l)).at(-1);
  if (/Refreshing the package lists$/.test(lines.at(-1) ?? '') || /fetch|network|resolve|DNS|timed out/i.test(err ?? '')) {
    return 'Could not download the package list. Check that the router is online.';
  }
  return err ?? lines.at(-1) ?? `The package manager stopped with code ${job.exit}.`;
}
