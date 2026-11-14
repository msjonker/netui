import type { ComponentChildren } from 'preact';
import { Link, useLocation } from 'wouter-preact';
import { useDevices, useInterfaces, useSystemBoard } from '../api/queries';
import { getSession } from '../api/ubus';
import { findUplink, uplinkOnline } from '../model/network';
import {
  IconAccessPoint,
  IconClients,
  IconDashboard,
  IconExternal,
  IconInsights,
  IconLog,
  IconLogout,
  IconSettings,
  IconTopology,
  Logo,
} from '../components/icons';
import { Dot, cx } from '../components/ui';
import { Notifications } from './Notifications';
import { Search } from './Search';

const NAV = [
  { href: '/', label: 'Dashboard', icon: IconDashboard, match: (p: string) => p === '/' },
  { href: '/topology', label: 'Topology', icon: IconTopology, match: (p: string) => p.startsWith('/topology') },
  { href: '/devices', label: 'Devices', icon: IconAccessPoint, match: (p: string) => p.startsWith('/devices') },
  { href: '/clients', label: 'Client Devices', icon: IconClients, match: (p: string) => p.startsWith('/clients') },
  { href: '/insights', label: 'Insights', icon: IconInsights, match: (p: string) => p.startsWith('/insights') },
  { href: '/logs', label: 'System Log', icon: IconLog, match: (p: string) => p.startsWith('/logs') },
  { href: '/settings', label: 'Settings', icon: IconSettings, match: (p: string) => p.startsWith('/settings') },
];

function RailLink({ href, label, active, children }: { href: string; label: string; active: boolean; children: ComponentChildren }) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      class={cx(
        'group relative flex size-10 items-center justify-center rounded-lg transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
      <span class="pointer-events-none absolute left-12 z-30 rounded-md bg-fg px-2 py-1 text-xs whitespace-nowrap text-bg opacity-0 shadow-pop transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {label}
      </span>
    </Link>
  );
}

function InternetStatus() {
  const q = useInterfaces();
  const devices = useDevices(10_000);
  const up = q.data ? findUplink(q.data) : undefined;
  if (!q.data) return null;
  const online = uplinkOnline(up, devices.data);
  return (
    <span class="hidden items-center gap-1.5 text-xs text-muted sm:inline-flex">
      <Dot tone={online ? 'ok' : 'bad'} />
      {online ? 'Internet' : 'Offline'}
    </span>
  );
}

export function Shell({
  username,
  onLogout,
  banner,
  children,
}: {
  username: string;
  onLogout: () => void;
  banner?: ComponentChildren;
  children: ComponentChildren;
}) {
  const [path] = useLocation();
  const board = useSystemBoard();
  const readOnly = !!getSession()?.readOnly;

  return (
    <div class="flex h-screen overflow-hidden">
      <nav aria-label="Main" class="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-rail py-2.5">
        <Link href="/" aria-label="netui home" class="mb-3">
          <Logo />
        </Link>
        {NAV.map(({ href, label, icon: Icon, match }) => (
          <RailLink key={href} href={href} label={label} active={match(path)}>
            <Icon />
          </RailLink>
        ))}
        <div class="flex-1" />
        <a
          href="/cgi-bin/luci/"
          target="_blank"
          rel="noopener"
          aria-label="Open LuCI"
          title="Open LuCI (advanced settings)"
          class="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <IconExternal />
        </a>
        <button
          type="button"
          onClick={onLogout}
          title={`Sign out ${username}`}
          class="flex size-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <IconLogout />
        </button>
      </nav>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
          <span class="font-semibold">Network</span>
          {board.data && (
            <span class="truncate text-muted">
              {board.data.hostname}
              <span class="ml-2 hidden text-xs text-faint md:inline">
                {board.data.model} · OpenWrt {board.data.release.version}
              </span>
            </span>
          )}
          <div class="flex-1" />
          <Search />
          <InternetStatus />
          <Notifications />
          <span
            class="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent uppercase"
            title={`Signed in as ${username}${readOnly ? ' (read-only)' : ''}`}
          >
            {username.slice(0, 1)}
          </span>
        </header>
        {readOnly && (
          <div role="status" class="border-b border-line bg-warn-soft px-5 py-1.5 text-xs">
            Read-only access: you can look at everything, but changes are left to an admin.
          </div>
        )}
        {banner}
        <main class="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
