import { useMemo, useState } from 'preact/hooks';
import { useDevices, useInterfaces, useUci } from '../../api/queries';
import { runTool, type Tool } from '../../api/diagnostics';
import { checkSteps, isTarget, parseLookup, parsePing, type CheckInput, type StepState } from '../../model/diagnostics';
import { normalizeWan } from '../../model/internet';
import { Button, Card, Dot, Field, Page, Spinner } from '../../components/ui';

const TONE: Record<StepState, 'ok' | 'warn' | 'bad' | 'neutral'> = { ok: 'ok', warn: 'warn', fail: 'bad', skip: 'neutral' };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One click from the cable to name lookup, with advice for the first thing that fails. */
function ConnectionCheck() {
  const network = useUci('network');
  const firewall = useUci('firewall');
  const ifaces = useInterfaces();
  const devices = useDevices(false);
  const [input, setInput] = useState<CheckInput | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    const wan = network.data && normalizeWan(network.data, firewall.data);
    const live = ifaces.data?.interface.find((i) => i.interface === wan?.section);
    const gateway = live?.route?.find((r) => r.target === '0.0.0.0' && r.mask === 0)?.nexthop;
    let state: CheckInput = {
      carrier: wan && wan.proto !== 'pppoe' ? devices.data?.[wan.port]?.carrier : undefined,
      address: live?.up ? live['ipv4-address']?.[0]?.address : undefined,
      gateway,
    };
    const show = (more: Partial<CheckInput>) => setInput((state = { ...state, ...more }));
    setError(undefined);
    setRunning(true);
    show({});
    try {
      if (state.carrier !== false && state.address) {
        if (gateway) show({ gatewayPing: parsePing(await runTool('ping', gateway, 3)) });
        let target = '1.1.1.1';
        let p = parsePing(await runTool('ping', target, 3));
        if (!p.received) p = parsePing(await runTool('ping', (target = '9.9.9.9'), 3));
        show({ internetPing: p, internetTarget: target });
        show({ lookup: parseLookup(await runTool('nslookup', 'openwrt.org')) });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setRunning(false);
    }
  };

  const steps = input && checkSteps(input);
  const failed = steps?.find((s) => s.state === 'fail');
  return (
    <Card
      title="Connection check"
      actions={
        <Button variant="primary" onClick={run} disabled={running || !network.data || !ifaces.data}>
          {input ? 'Run Again' : 'Run Check'}
        </Button>
      }
    >
      {!steps ? (
        <p class="text-muted">Checks the cable, the address from your provider, the internet and name lookup, in that order.</p>
      ) : (
        <ol class="space-y-2.5">
          {steps.map((s) => (
            <li key={s.id} class="flex gap-3">
              <span class="mt-1">{running && s.state === 'skip' && !failed ? <Spinner class="size-3" /> : <Dot tone={TONE[s.state]} />}</span>
              <div class="min-w-0">
                <p class={s.state === 'skip' ? 'text-muted' : 'font-medium'}>{s.label}</p>
                {s.detail && <p class={s.state === 'ok' ? 'font-mono text-xs text-muted' : 'text-xs text-muted'}>{s.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {!running && steps && !failed && !error && (
        <p class="mt-3 text-xs text-ok" role="status">
          The router’s internet connection works. If one device has trouble, open it under Client Devices.
        </p>
      )}
      {error && (
        <p class="mt-3 text-xs text-bad" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

const TOOLS: { value: Tool; label: string }[] = [
  { value: 'ping', label: 'Ping' },
  { value: 'traceroute', label: 'Traceroute' },
  { value: 'nslookup', label: 'DNS lookup' },
];

/** Ping, traceroute and DNS lookup from the router itself. */
function Tools() {
  const [tool, setTool] = useState<Tool>('ping');
  const [target, setTarget] = useState('openwrt.org');
  const [out, setOut] = useState<{ text: string; failed: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const valid = isTarget(target);
  const summary = useMemo(() => {
    if (!out || tool !== 'ping') return undefined;
    const p = parsePing({ code: 0, stdout: out.text });
    return p.sent ? `${p.received} of ${p.sent} answered${p.avgMs != null ? `, ${p.avgMs.toFixed(1)} ms on average` : ''}` : undefined;
  }, [out, tool]);

  const run = async (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    setRunning(true);
    setOut(null);
    try {
      const r = await runTool(tool, target);
      setOut({ text: [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || `Exited with ${r.code}`, failed: !!r.code });
    } catch (err) {
      setOut({ text: message(err), failed: true });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card title="Tools">
      <form class="flex flex-wrap items-end gap-3" onSubmit={run}>
        <div class="w-40">
          <Field label="Tool" stacked>
            {(id) => (
              <select id={id} class="input" value={tool} onChange={(e) => setTool(e.currentTarget.value as Tool)}>
                {TOOLS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div class="min-w-56 flex-1">
          <Field label="Host name or IP address" stacked error={target && !valid ? 'A host name like example.com or an IP address.' : undefined}>
            {(id) => <input id={id} class="input font-mono" value={target} onInput={(e) => setTarget(e.currentTarget.value.trim())} />}
          </Field>
        </div>
        <Button variant="primary" type="submit" disabled={running || !valid}>
          Run
        </Button>
      </form>
      {running && (
        <p class="mt-3 inline-flex items-center gap-2 text-muted">
          <Spinner /> {tool === 'traceroute' ? 'Tracing the route (up to 20 s)…' : 'Running…'}
        </p>
      )}
      {summary && <p class="mt-3 font-medium">{summary}</p>}
      {out && (
        <pre class={`mt-3 max-h-96 overflow-auto rounded-md bg-bg p-3 font-mono text-xs ${out.failed ? 'text-bad' : ''}`}>{out.text}</pre>
      )}
    </Card>
  );
}

export function DiagnosticsPage() {
  return (
    <Page title="Diagnostics" subtitle="Check the internet connection and test reachability from the router">
      <div class="grid max-w-4xl grid-cols-1 gap-4">
        <ConnectionCheck />
        <Tools />
      </div>
    </Page>
  );
}
