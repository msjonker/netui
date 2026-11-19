import { useMemo, useState } from 'preact/hooks';
import { useUci } from '../api/queries';
import { useRootPassword } from '../api/users';
import { getSession } from '../api/ubus';
import { runChecks, type Check } from './health';

const IGNORED = 'netui.health.ignored';

function readIgnored(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(IGNORED) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The health checks over the router's current config, without findings the
 * user chose to ignore (kept in this browser). `checks` is undefined until
 * the firewall config has loaded; optional packages that fail to load (not
 * installed) are left out.
 */
export function useHealthChecks() {
  const admin = !getSession()?.readOnly;
  const firewall = useUci('firewall');
  const wireless = useUci('wireless');
  const system = useUci('system');
  const upnpd = useUci('upnpd');
  const sqm = useUci('sqm');
  const root = useRootPassword(admin);
  const [ignored, setIgnored] = useState(readIgnored);

  const all = useMemo<Check[] | undefined>(
    () =>
      firewall.data &&
      runChecks({
        firewall: firewall.data,
        wireless: wireless.data,
        system: system.data,
        upnpd: upnpd.data,
        sqm: sqm.data,
        rootPassword: admin ? root.data : undefined,
        protocol: location.protocol,
      }),
    [firewall.data, wireless.data, system.data, upnpd.data, sqm.data, root.data, admin],
  );

  const checks = useMemo(
    () => all?.map((c) => ({ ...c, findings: c.findings.filter((f) => !ignored.includes(f.id)) })),
    [all, ignored],
  );
  const ignoredFindings = useMemo(() => all?.flatMap((c) => c.findings).filter((f) => ignored.includes(f.id)) ?? [], [all, ignored]);

  const setIgnore = (id: string, on: boolean) => {
    const next = on ? [...new Set([...ignored, id])] : ignored.filter((x) => x !== id);
    localStorage.setItem(IGNORED, JSON.stringify(next));
    setIgnored(next);
  };

  return { checks, ignoredFindings, setIgnore, error: firewall.error, loading: firewall.isLoading || wireless.isLoading };
}
