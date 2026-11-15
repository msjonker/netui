import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { useCountryList, useInterfaces, useTimezones, useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { setRootPassword, useRootPassword } from '../../api/users';
import { deepEqual } from '../../lib/useDraft';
import { normalizeWan, validateWan, wanDraft, wanOps, type WanDraft } from '../../model/internet';
import { countryOptions } from '../../model/radio';
import {
  browserCountry,
  browserZone,
  setupWifiOps,
  validateRootPassword,
  validateSetupWifi,
  type SetupWifi,
} from '../../model/setup';
import { normalizeSystemSettings, normalizeTimezones, systemOps, validateSystem } from '../../model/system';
import { wifiQrPayload } from '../../model/wifi';
import { QrCode } from '../../components/QrCode';
import { Banner, Button, Card, Detail, Field, Page, Spinner } from '../../components/ui';

const STEPS = ['WiFi', 'Internet', 'Time and name', 'Router password', 'Review'] as const;
const PLAN = { returnTo: '/setup' };

function Text(p: {
  label: string;
  value: string;
  error?: string;
  hint?: string;
  type?: string;
  onInput: (v: string) => void;
}) {
  return (
    <Field label={p.label} stacked error={p.error} hint={p.hint}>
      {(id) => (
        <input
          id={id}
          class="input"
          type={p.type ?? 'text'}
          autocomplete={p.type === 'password' ? 'new-password' : 'off'}
          value={p.value}
          onInput={(e) => p.onInput(e.currentTarget.value)}
        />
      )}
    </Field>
  );
}

/** First-run setup: WiFi, internet, time zone and name, router password, in one apply. */
export function SetupPage() {
  const apply = useApply();
  const wireless = useUci('wireless');
  const network = useUci('network');
  const firewall = useUci('firewall');
  const system = useUci('system');
  const ifaces = useInterfaces();
  const zonesQ = useTimezones();
  const rootSet = useRootPassword();
  const firstRadio = useMemo(
    () => Object.values(wireless.data ?? {}).find((s) => s['.type'] === 'wifi-device')?.['.name'],
    [wireless.data],
  );
  const countries = useCountryList(firstRadio);
  const zones = useMemo(() => (zonesQ.data ? normalizeTimezones(zonesQ.data) : undefined), [zonesQ.data]);
  const wan = useMemo(
    () => (network.data ? normalizeWan(network.data, firewall.data) : undefined),
    [network.data, firewall.data],
  );
  const sys = useMemo(() => (system.data ? normalizeSystemSettings(system.data) : undefined), [system.data]);

  const [step, setStep] = useState(0);
  const [wifi, setWifi] = useState<SetupWifi>({
    ssid: '',
    password: '',
    country: browserCountry(navigator.languages ?? []),
  });
  const [wanD, setWanD] = useState<WanDraft>();
  const [time, setTime] = useState<{ zonename: string; hostname: string }>();
  const [pw, setPw] = useState({ a: '', b: '' });
  const [done, setDone] = useState<{ ssid: string; key: string; pwError?: string } | null>(null);

  // Start from what the router has, the browser's zone where it is still UTC.
  useEffect(() => {
    if (wan && !wanD) setWanD(wanDraft(wan));
  }, [wan, wanD]);
  useEffect(() => {
    if (sys && zones && !time) {
      const zone =
        sys.zonename === 'UTC'
          ? (browserZone(zones, Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC')
          : sys.zonename;
      setTime({ zonename: zone, hostname: sys.hostname });
    }
  }, [sys, zones, time]);

  if (done) {
    return (
      <Page title="Setup">
        <Card class="mx-auto max-w-lg">
          <div class="flex flex-col items-center gap-3 py-4 text-center">
            <h2 class="text-[15px] font-semibold">Your WiFi “{done.ssid}” is ready</h2>
            <p class="text-muted">Scan this with a phone camera to join it.</p>
            <QrCode
              value={wifiQrPayload({ ssid: done.ssid, security: 'sae-mixed', key: done.key, hidden: false })}
              label={`Join ${done.ssid}`}
            />
            {done.pwError && (
              <Banner tone="bad" role="alert">
                The router password was not set: {done.pwError}. Set it under Settings → System.
              </Banner>
            )}
            <Link href="/" class="text-accent hover:underline">
              Go to the Dashboard
            </Link>
          </div>
        </Card>
      </Page>
    );
  }

  if (!wireless.data || !network.data || !system.data || !sys || !wanD || !time || !zones || rootSet.isPending) {
    return (
      <Page title="Set up your router">
        <Spinner />
      </Page>
    );
  }

  const wifiErr = validateSetupWifi(wifi);
  const wanErr = wan ? validateWan(wanD, wan) : {};
  const timeErr = validateSystem({ ...sys, ...time }, zones);
  const pwRequired = rootSet.data === false;
  // Recommended, not required: some people only use ssh keys.
  const pwErr = !pw.a && !pw.b ? undefined : validateRootPassword(pw.a, pw.b);
  const stepErrors = [
    wifiErr,
    wanErr,
    { zonename: timeErr.zonename, hostname: timeErr.hostname },
    pwErr ? { pw: pwErr } : {},
    {},
  ];
  const stepOk = Object.values(stepErrors[step]!).every((e) => !e);
  const wanChanged = !!wan && !deepEqual(wanD, wanDraft(wan));
  const live = ifaces.data?.interface.find((i) => i.interface === wan?.section);
  const online = !!live?.up && !!live.route?.some((r) => r.target === '0.0.0.0' && r.mask === 0);

  const finish = () => {
    const ops = [
      ...setupWifiOps(wifi, wireless.data!),
      ...(wan && wanChanged ? wanOps(wanD, wan, network.data!) : []),
      ...systemOps({ ...sys, ...time }, system.data!, zones),
    ];
    const result = { ssid: wifi.ssid.trim(), key: wifi.password };
    void apply.start(ops, {
      ...PLAN,
      disruptive: wanChanged,
      onConfirmed: () => {
        if (!pw.a) return setDone(result);
        void setRootPassword(pw.a).then(
          () => setDone(result),
          (e: unknown) => setDone({ ...result, pwError: e instanceof Error ? e.message : String(e) }),
        );
      },
    });
  };

  return (
    <Page title="Set up your router" subtitle={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
      <Card class="max-w-xl">
        <ol class="mb-4 flex gap-1" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              class={`h-1 flex-1 rounded ${i <= step ? 'bg-accent' : 'bg-line'}`}
              aria-current={i === step ? 'step' : undefined}
              title={s}
            />
          ))}
        </ol>

        {step === 0 && (
          <div class="space-y-3">
            <p class="text-muted">Your WiFi is off. Give it a name and a password: every radio will broadcast it.</p>
            <Text
              label="WiFi name"
              value={wifi.ssid}
              error={wifi.ssid ? wifiErr.ssid : undefined}
              onInput={(ssid) => setWifi({ ...wifi, ssid })}
            />
            <Text
              label="WiFi password"
              type="password"
              value={wifi.password}
              hint="At least 8 characters. Devices use it to join; WPA2 and WPA3 both work."
              error={wifi.password ? wifiErr.password : undefined}
              onInput={(password) => setWifi({ ...wifi, password })}
            />
            <Field
              label="Country"
              stacked
              hint="Decides which channels and power the radios may use."
              error={wifiErr.country}
            >
              {(id) => (
                <select
                  id={id}
                  class="input"
                  value={wifi.country}
                  onChange={(e) => setWifi({ ...wifi, country: e.currentTarget.value })}
                >
                  <option value="">Choose…</option>
                  {countryOptions(countries.data, wifi.country)
                    .filter((c) => c.value !== '00')
                    .map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          </div>
        )}

        {step === 1 && (
          <div class="space-y-3">
            {!wan ? (
              <p class="text-muted">This router has no internet connection set up; netui leaves that to LuCI.</p>
            ) : (
              <>
                <p class={online ? 'text-ok' : 'text-muted'}>
                  {online
                    ? `The router is online (${live?.['ipv4-address']?.[0]?.address ?? 'connected'}). Most connections need nothing else.`
                    : 'The router is not online yet. Check the cable to your modem, or choose your connection type.'}
                </p>
                <Field
                  label="Connection type"
                  stacked
                  hint="Your provider tells you if it is PPPoE or a fixed address."
                >
                  {(id) => (
                    <select
                      id={id}
                      class="input"
                      value={wanD.proto}
                      onChange={(e) => setWanD({ ...wanD, proto: e.currentTarget.value })}
                    >
                      {!['dhcp', 'pppoe', 'static'].includes(wanD.proto) && (
                        <option value={wanD.proto}>{wanD.proto}</option>
                      )}
                      <option value="dhcp">Automatic (DHCP)</option>
                      <option value="pppoe">PPPoE (user name and password)</option>
                      <option value="static">Fixed address</option>
                    </select>
                  )}
                </Field>
                {wanD.proto === 'pppoe' && (
                  <>
                    <Text
                      label="User name"
                      value={wanD.username}
                      error={wanErr.username}
                      onInput={(username) => setWanD({ ...wanD, username })}
                    />
                    <Text
                      label="Password"
                      type="password"
                      value={wanD.password}
                      error={wanErr.password}
                      onInput={(password) => setWanD({ ...wanD, password })}
                    />
                  </>
                )}
                {wanD.proto === 'static' && (
                  <>
                    <Text
                      label="IP address"
                      value={wanD.address}
                      error={wanErr.address}
                      onInput={(address) => setWanD({ ...wanD, address: address.trim() })}
                    />
                    <Text
                      label="Prefix"
                      value={wanD.prefix}
                      error={wanErr.prefix}
                      hint="24 for 255.255.255.0"
                      onInput={(prefix) => setWanD({ ...wanD, prefix: prefix.trim() })}
                    />
                    <Text
                      label="Gateway"
                      value={wanD.gateway}
                      error={wanErr.gateway}
                      onInput={(gateway) => setWanD({ ...wanD, gateway: gateway.trim() })}
                    />
                    <Text
                      label="DNS servers"
                      value={wanD.dns}
                      error={wanErr.dns}
                      onInput={(dns) => setWanD({ ...wanD, dns })}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div class="space-y-3">
            <Field label="Time zone" stacked error={timeErr.zonename}>
              {(id) => (
                <select
                  id={id}
                  class="input"
                  value={time.zonename}
                  onChange={(e) => setTime({ ...time, zonename: e.currentTarget.value })}
                >
                  {zones.map((z) => (
                    <option key={z.name} value={z.name}>
                      {z.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Text
              label="Router name"
              value={time.hostname}
              hint="How it shows up on your network, e.g. home-router."
              error={timeErr.hostname}
              onInput={(hostname) => setTime({ ...time, hostname: hostname.trim() })}
            />
          </div>
        )}

        {step === 3 && (
          <div class="space-y-3">
            <p class="text-muted">
              {pwRequired
                ? 'The router has no password yet: anyone on your network could sign in to it with ssh. Setting one is strongly recommended; netui keeps its own sign-in.'
                : 'The router already has a password. Fill this in only to change it.'}
            </p>
            <Text label="Router password" type="password" value={pw.a} onInput={(a) => setPw({ ...pw, a })} />
            <Text
              label="Again"
              type="password"
              value={pw.b}
              error={pw.b ? pwErr : undefined}
              onInput={(b) => setPw({ ...pw, b })}
            />
          </div>
        )}

        {step === 4 && (
          <div class="space-y-3">
            <Detail
              rows={[
                ['WiFi', `${wifi.ssid.trim()} (WPA2/WPA3), every radio`],
                ['Country', wifi.country],
                [
                  'Internet',
                  wanChanged
                    ? `Change to ${wanD.proto === 'pppoe' ? 'PPPoE' : wanD.proto === 'static' ? 'a fixed address' : 'automatic'}`
                    : 'Unchanged',
                ],
                ['Time zone', time.zonename],
                ['Router name', time.hostname],
                ['Router password', pw.a ? 'Set' : pwRequired ? 'Still none' : 'Unchanged'],
              ]}
            />
            <p class="text-xs text-muted">
              Next you see every change before it is made. If the router cannot be reached afterwards, it undoes them on
              its own.
            </p>
          </div>
        )}

        <div class="mt-5 flex justify-between gap-2">
          {step > 0 ? (
            <Button onClick={() => setStep(step - 1)}>Back</Button>
          ) : (
            <Link href="/" class="self-center text-muted hover:underline">
              Cancel
            </Link>
          )}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={!stepOk} onClick={() => setStep(step + 1)}>
              Next
            </Button>
          ) : (
            <Button variant="primary" disabled={apply.busy} onClick={finish}>
              Apply
            </Button>
          )}
        </div>
      </Card>
    </Page>
  );
}
