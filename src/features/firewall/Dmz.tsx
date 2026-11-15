import { useMemo, useState } from 'preact/hooks';
import type { UciConfig } from '../../api/types';
import { useApply } from '../../api/useApply';
import { dmzOps, normalizeDmz } from '../../model/firewall';
import { Banner, Button, Card, Field, Pill } from '../../components/ui';
import { PLAN, type Host } from './shared';

/**
 * DMZ: incoming connections no port forward or router service uses go to one
 * device. `zoneFor` finds the firewall zone of the device's network.
 */
export function DmzCard({ fw, hosts, zoneFor }: { fw: UciConfig; hosts: Host[]; zoneFor: (ip: string) => string | undefined }) {
  const apply = useApply();
  const dmz = useMemo(() => normalizeDmz(fw), [fw]);
  const [ip, setIp] = useState(dmz?.destIp ?? '');
  const host = hosts.find((h) => h.ip === ip);
  const choices = dmz && !hosts.some((h) => h.ip === dmz.destIp) ? [{ ip: dmz.destIp, name: dmz.destIp, fixed: true }, ...hosts] : hosts;
  const set = (to: string | null) =>
    void apply.start(dmzOps(fw, to ? { destIp: to, destZone: zoneFor(to) ?? 'lan' } : null), PLAN);

  return (
    <Card
      title={
        <span class="inline-flex items-center gap-2">
          DMZ {dmz && <Pill tone="warn">On</Pill>}
        </span>
      }
      actions={
        dmz && (
          <Button onClick={() => set(null)} disabled={apply.busy}>
            Turn Off
          </Button>
        )
      }
    >
      <p class="text-muted">
        Send every incoming connection that no port forward or router service uses to one device, for example a game
        console that needs open ports. That device is fully exposed to the internet.
      </p>
      {dmz?.stale && (
        <div class="mt-3">
          <Banner tone="warn" role="status" actions={<Button onClick={() => set(dmz.destIp)} disabled={apply.busy}>Update</Button>}>
            Port forwards or router services changed since the DMZ was set up. Update it so it leaves their ports alone.
          </Banner>
        </div>
      )}
      <div class="mt-3 flex flex-wrap items-end gap-3">
        <div class="min-w-64 flex-1">
          <Field label="Device" stacked hint={host && !host.fixed ? 'Give this device a fixed IP address (Client Devices → Settings), or the DMZ may end up pointing at another device.' : undefined}>
            {(id) => (
              <select id={id} class="input" value={ip} onChange={(e) => setIp(e.currentTarget.value)}>
                <option value="">Choose a device…</option>
                {choices.map((h) => (
                  <option key={h.ip} value={h.ip}>
                    {h.name === h.ip ? h.ip : `${h.name} (${h.ip})`}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Button variant="primary" onClick={() => set(ip)} disabled={apply.busy || !ip || ip === dmz?.destIp}>
          {dmz ? 'Apply Changes' : 'Turn On'}
        </Button>
      </div>
    </Card>
  );
}
