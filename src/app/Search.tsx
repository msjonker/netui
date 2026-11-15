import { Fragment, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { displayName } from '../model/clients';
import { useClients, useNetworks, useSwitch, useWifiModel } from '../model/hooks';
import { networkLabel } from '../model/network';
import { IconClients, IconEthernet, IconNetwork, IconSearch, IconSettings, IconWifi } from '../components/icons';
import { cx } from '../components/ui';

// Global search (Cmd/Ctrl+K): clients, networks, SSIDs, ports and pages in a
// native <dialog> command palette. Data hooks mount only while it is open.

export type SearchGroup = 'Clients' | 'Networks' | 'WiFi' | 'Ports' | 'Pages';

export interface SearchItem {
  group: SearchGroup;
  label: string;
  detail?: string;
  href: string;
  /** Extra text that matches but is not the label (IP, MAC, ...). */
  keywords?: string[];
}

// [label, path under /settings or absolute, keywords]
const PAGE_LIST: [string, string, string][] = [
  ['Dashboard', '/', 'home overview'],
  ['Client Devices', '/clients', 'devices'],
  ['Topology', '/topology', 'map tree'],
  ['Devices', '/devices', 'access points adopt mesh'],
  ['Insights', '/insights', 'traffic rf statistics'],
  ['System Log', '/logs', 'events syslog'],
  ['WiFi', 'wifi', 'wireless ssid radio'],
  ['Networks', 'networks', 'lan dhcp subnet'],
  ['Ports', 'ports', 'vlan switch ethernet'],
  ['Internet', 'internet', 'wan upnp ddns sqm'],
  ['Firewall & Security', 'security', 'port forward block rules'],
  ['VPN', 'vpn', 'wireguard'],
  ['Routing & DNS', 'routing', 'routes dns'],
  ['System', 'system', 'reboot hostname time firmware'],
  ['Set up your router', '/setup', 'wizard first run'],
  ['Diagnostics', 'diagnostics', 'ping traceroute dns lookup troubleshoot connection check'],
];

export const PAGES: SearchItem[] = PAGE_LIST.map(([label, path, kw]) =>
  path.startsWith('/')
    ? { group: 'Pages', label, href: path, keywords: [kw] }
    : { group: 'Pages', label, detail: 'Settings', href: `/settings/${path}`, keywords: [kw] },
);

const GROUP_ORDER: SearchGroup[] = ['Clients', 'Networks', 'WiFi', 'Ports', 'Pages'];
const PER_GROUP = 6;

/**
 * Items matching every word of `query`, best first within each group: label
 * prefix, then label substring, then keyword match. An empty query lists pages.
 */
export function searchItems(items: SearchItem[], query: string): SearchItem[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.filter((i) => i.group === 'Pages');
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    const hay = [label, item.detail ?? '', ...(item.keywords ?? [])].join(' ').toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const q = words.join(' ');
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    scored.push({ item, score });
  }
  return GROUP_ORDER.flatMap((g) =>
    scored
      .filter((s) => s.item.group === g)
      .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
      .slice(0, PER_GROUP)
      .map((s) => s.item),
  );
}

/** A MAC in the forms people paste: colons, dashes, bare hex. */
function macForms(mac: string): string[] {
  return [mac, mac.replace(/:/g, ''), mac.replace(/:/g, '-')];
}

function useSearchItems(): SearchItem[] {
  const { clients } = useClients();
  const { networks } = useNetworks();
  const { model: wifi } = useWifiModel();
  const { sw } = useSwitch();
  return useMemo(
    () => [
      ...clients.map(
        (c): SearchItem => ({
          group: 'Clients',
          label: displayName(c),
          detail: [c.ip, c.wireless ? c.wireless.ssid ?? 'WiFi' : 'Wired'].filter(Boolean).join(' · '),
          href: `/clients/${c.mac}`,
          keywords: [...macForms(c.mac), c.ip ?? '', ...(c.otherAddresses ?? []).map((o) => o.ip), c.reservation?.name ?? ''],
        }),
      ),
      ...(networks ?? []).map(
        (n): SearchItem => ({
          group: 'Networks',
          label: networkLabel(n.id),
          detail: n.address ? `${n.address}/${n.prefix}` : n.proto,
          href: '/settings/networks',
          keywords: [n.id, n.device ?? ''],
        }),
      ),
      ...(wifi?.wlans ?? []).map(
        (w): SearchItem => ({
          group: 'WiFi',
          label: w.ssid,
          detail: w.members.map((m) => m.bandLabel).join(' · '),
          href: '/settings/wifi',
          keywords: ['wifi', 'ssid'],
        }),
      ),
      ...(sw?.ports ?? []).map(
        (p): SearchItem => ({
          group: 'Ports',
          label: p.role === 'wan' ? `WAN (${p.name})` : p.name,
          detail: p.carrier ? `${p.speed ? `${p.speed} Mbps` : 'Link up'}` : 'No link',
          href: '/settings/ports',
          keywords: ['port', p.name],
        }),
      ),
      ...PAGES,
    ],
    [clients, networks, wifi, sw],
  );
}

const ICON: Record<SearchGroup, (p: { size?: number }) => JSX.Element> = {
  Clients: IconClients,
  Networks: IconNetwork,
  WiFi: IconWifi,
  Ports: IconEthernet,
  Pages: IconSettings,
};

function Palette({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const items = useSearchItems();
  const results = useMemo(() => searchItems(items, query), [items, query]);

  useEffect(() => {
    const d = ref.current!;
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
    } else d.setAttribute('open', '');
    input.current?.focus();
    return () => {
      if (typeof d.close === 'function' && d.open) d.close();
    };
  }, []);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const go = (item: SearchItem | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.href);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === 'Escape') {
      // jsdom and older browsers without a cancel event.
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup: SearchGroup | undefined;
  return (
    <dialog
      ref={ref}
      aria-label="Search"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      class="mx-auto mt-[12vh] mb-auto w-[calc(100%-2rem)] max-w-xl rounded-xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <div class="flex items-center gap-2 border-b border-line px-4">
        <IconSearch size={16} class="text-faint" />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Search netui"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={results[active] ? `search-${active}` : undefined}
          placeholder="Search clients, networks, WiFi, ports, settings…"
          class="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <kbd class="rounded border border-line px-1.5 text-[11px] text-faint">Esc</kbd>
      </div>
      <ul id="search-results" role="listbox" aria-label="Results" class="max-h-[50vh] overflow-y-auto py-1">
        {results.length === 0 && <li class="px-4 py-6 text-center text-muted">No matches for “{query}”.</li>}
        {results.map((r, i) => {
          const Icon = ICON[r.group];
          const header = r.group !== lastGroup;
          lastGroup = r.group;
          return (
            <Fragment key={`${r.group}:${r.href}:${r.label}`}>
              {header && (
                <li role="presentation" class="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
                  {r.group}
                </li>
              )}
              <li
                id={`search-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => go(r)}
                class={cx(
                  'mx-1 flex h-9 cursor-pointer items-center gap-3 rounded-md px-3',
                  i === active ? 'bg-accent-soft text-accent' : 'text-fg',
                )}
              >
                <span class={i === active ? 'text-accent' : 'text-muted'}>
                  <Icon size={16} />
                </span>
                <span class="min-w-0 flex-1 truncate">{r.label}</span>
                {r.detail && <span class="truncate text-xs text-muted">{r.detail}</span>}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </dialog>
  );
}

/** Top-bar search button plus the global Cmd/Ctrl+K shortcut. */
export function Search() {
  const [open, setOpen] = useState(false);
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        aria-keyshortcuts="Control+K Meta+K"
        class="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2.5 text-muted hover:border-line-strong hover:text-fg"
      >
        <IconSearch size={14} />
        <span class="hidden w-40 text-left md:inline">Search</span>
        <kbd class="hidden rounded border border-line bg-surface px-1 text-[11px] text-faint md:inline">
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      {open && <Palette onClose={() => setOpen(false)} />}
    </>
  );
}
