import type { ComponentChildren } from 'preact';
import { Link, useLocation } from 'wouter-preact';
import {
  IconEthernet,
  IconCheckCircle,
  IconExternal,
  IconHistory,
  IconGlobe,
  IconNetwork,
  IconPulse,
  IconRoute,
  IconShield,
  IconSystem,
  IconVpn,
  IconWifi,
} from '../components/icons';
import { cx } from '../components/ui';

const SECTIONS = [
  { href: '/settings/wifi', label: 'WiFi', icon: IconWifi },
  { href: '/settings/networks', label: 'Networks', icon: IconNetwork },
  { href: '/settings/ports', label: 'Ports', icon: IconEthernet },
  { href: '/settings/internet', label: 'Internet', icon: IconGlobe },
  { href: '/settings/security', label: 'Firewall & Security', icon: IconShield },
  { href: '/settings/vpn', label: 'VPN', icon: IconVpn },
  { href: '/settings/routing', label: 'Routing & DNS', icon: IconRoute },
  { href: '/settings/system', label: 'System', icon: IconSystem },
  { href: '/settings/diagnostics', label: 'Diagnostics', icon: IconPulse },
  { href: '/settings/health', label: 'Health Check', icon: IconCheckCircle },
  { href: '/settings/history', label: 'Change History', icon: IconHistory },
];

// Out of scope for v1: link to the matching LuCI page instead.
const LUCI = [
  { href: '/cgi-bin/luci/admin/network/network', label: 'Interfaces & Devices' },
  { href: '/cgi-bin/luci/admin/network/firewall', label: 'Traffic Rules' },
  { href: '/cgi-bin/luci/admin/system/flash', label: 'Backup & Firmware' },
  { href: '/cgi-bin/luci/admin/network/mwan3', label: 'Multi-WAN' },
  { href: '/cgi-bin/luci/', label: 'Everything else' },
];

export function SettingsLayout({ children }: { children: ComponentChildren }) {
  const [path] = useLocation();
  return (
    <div class="flex min-h-full">
      <nav aria-label="Settings" class="hidden w-56 shrink-0 border-r border-line bg-surface px-3 py-4 md:block">
        <h2 class="px-2 pb-2 text-base font-semibold">Settings</h2>
        <ul class="space-y-0.5">
          {SECTIONS.map(({ href, label, icon: Icon }) => {
            const active = path.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  class={cx(
                    'flex h-8 items-center gap-2.5 rounded-md px-2 transition-colors',
                    active ? 'bg-accent-soft font-medium text-accent' : 'text-fg hover:bg-hover',
                  )}
                >
                  <Icon size={18} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
        <h3 class="mt-6 px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Advanced (LuCI)</h3>
        <ul class="space-y-0.5">
          {LUCI.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                target="_blank"
                rel="noopener"
                class="flex h-8 items-center justify-between gap-2 rounded-md px-2 text-muted hover:bg-hover hover:text-fg"
              >
                {l.label}
                <IconExternal size={14} />
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div class="min-w-0 flex-1">
        {/* Small screens: horizontal section switcher. */}
        <div class="flex gap-1 overflow-x-auto border-b border-line bg-surface px-4 py-2 md:hidden">
          {SECTIONS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              class={cx(
                'h-7 rounded-md px-2.5 leading-7 whitespace-nowrap',
                path.startsWith(href) ? 'bg-accent-soft text-accent' : 'text-muted',
              )}
            >
              {label}
            </Link>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
