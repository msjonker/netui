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
      <span class="pointer-events-none absolute left-12 z-30 hidden rounded-md bg-fg px-2 py-1 text-xs whitespace-nowrap text-bg opacity-0 shadow-pop transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 md:block">
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
      {/* A rail on the left; on phones a tab bar along the bottom. */}
      <nav
        aria-label="Main"
        class="fixed inset-x-0 bottom-0 z-30 flex h-14 shrink-0 items-center justify-around border-t border-line bg-rail px-1 md:static md:h-auto md:w-14 md:flex-col md:justify-start md:gap-1 md:border-t-0 md:border-r md:px-0 md:py-2.5"
      >
        <Link href="/" aria-label="netui home" class="mb-3 hidden md:block">
          <Logo />
        </Link>
        {NAV.map(({ href, label, icon: Icon, match }) => (
          <RailLink key={href} href={href} label={label} active={match(path)}>
            <Icon />
          </RailLink>
        ))}
        <div class="hidden flex-1 md:block" />
        <a
          href="/cgi-bin/luci/"
          target="_blank"
          rel="noopener"
          aria-label="Open LuCI"
          title="Open LuCI (advanced settings)"
          class="hidden size-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg md:flex"
        >
          <IconExternal />
        </a>
        <button
          type="button"
          onClick={onLogout}
          title={`Sign out ${username}`}
          class="hidden size-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg md:flex"
        >
          <IconLogout />
        </button>
      </nav>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 md:px-5">
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
          <details class="relative">
            <summary
              class="flex size-7 cursor-pointer list-none items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent uppercase [&::-webkit-details-marker]:hidden"
              title={`Signed in as ${username}${readOnly ? ' (read-only)' : ''}`}
              aria-label="Account"
            >
              {username.slice(0, 1)}
            </summary>
            <div class="absolute right-0 z-40 mt-2 w-52 rounded-lg border border-line bg-surface p-1 shadow-pop">
              <div class="px-3 py-2 text-xs text-muted">
                Signed in as <span class="font-medium text-fg">{username}</span>
                {readOnly && ' (read-only)'}
              </div>
              <a href="/cgi-bin/luci/" target="_blank" rel="noopener" class="flex h-8 items-center gap-2 rounded-md px-3 hover:bg-hover">
                <IconExternal size={14} /> Open LuCI
              </a>
              <button type="button" onClick={onLogout} class="flex h-8 w-full items-center gap-2 rounded-md px-3 text-left hover:bg-hover">
                <IconLogout size={14} /> Sign out
              </button>
            </div>
          </details>
        </header>
        {readOnly && (
          <div role="status" class="border-b border-line bg-warn-soft px-5 py-1.5 text-xs">
            Read-only access: you can look at everything, but changes are left to an admin.
          </div>
        )}
        {banner}
        <main class="min-h-0 flex-1 overflow-y-auto pb-14 md:pb-0">{children}</main>
      </div>
    </div>
  );
}
