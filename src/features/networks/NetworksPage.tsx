import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { UciConfig } from "../../api/types";
import type { UciOp } from "../../api/uci";
import { useApply } from "../../api/useApply";
import { useUci } from "../../api/queries";
import { useNetworks, useSwitch } from "../../model/hooks";
import { inUse, validateVid, vlanOf, type Switch } from "../../model/ports";
import {
  createNetworkOps,
  deleteBlocker,
  deleteNetworkOps,
  newNetworkDraft,
  renumberOps,
  validateNewNetwork,
  type NewNetworkDraft,
} from "../../model/vlans";
import { vlanColor } from "./vlanStyle";
import { GuestPortalCard } from "./GuestPortal";
import {
  attachedSubnets,
  moveDraft,
  networkExtras,
  networkExtrasOps,
  networkLabel,
  networkDraft,
  networkOps,
  validateExtras,
  type NetworkExtras,
  reservationsIn,
  validateNetwork,
  type Network,
  type NetworkDraft,
  type Subnet,
} from "../../model/network";
import {
  hostAt,
  hostOffset,
  isIPv4,
  inSubnet,
  networkAddress,
} from "../../lib/ip";
import { isMac, normalizeMac } from "../../lib/mac";
import { formatDuration } from "../../lib/format";
import { useDraft } from "../../lib/useDraft";
import { Drawer } from "../../components/overlay";
import {
  IconExternal,
  IconNetwork,
  IconPlus,
  IconTrash,
} from "../../components/icons";
import {
  Banner,
  Button,
  Card,
  Dot,
  Empty,
  Field,
  FormSection,
  LoadError,
  Page,
  Pill,
  Segmented,
  Spinner,
  ToggleRow,
} from "../../components/ui";

interface NewHost {
  mac: string;
  name: string;
  ip: string;
}

interface Draft extends NetworkDraft {
  /** dhcp host sections to delete. */
  removed: string[];
  added: NewHost[];
  /** VLAN ID, '' when the network is not on its own VLAN. */
  vid: string;
  /** DHCP DNS/domain, IPv6 and IGMP snooping. */
  extras: NetworkExtras;
}

const PREFIXES = [16, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

const LEASES = [
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "12h", label: "12 hours" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "1 week" },
];

function VlanCell({ sw, id }: { sw: Switch | undefined; id: string }) {
  const v = sw && vlanOf(sw, id);
  if (!sw || !v) return <span class="text-faint">—</span>;
  return (
    <span class="inline-flex items-center gap-1.5 font-mono text-xs">
      <span
        class="inline-block size-2 rounded-sm"
        style={{ background: vlanColor(sw, v.vid) }}
        aria-hidden="true"
      />
      {sw.vlanFiltering ? v.vid : "Untagged"}
    </span>
  );
}

function poolSize(n: Network): string {
  if (!n.dhcp?.enabled || !n.address || n.prefix === undefined)
    return "DHCP off";
  const first = hostAt(n.address, n.prefix, n.dhcp.start);
  const last = hostAt(n.address, n.prefix, n.dhcp.start + n.dhcp.limit - 1);
  return `${first} – ${last?.split(".").pop()}`;
}

/** Gateway address and DHCP pool, shared by the create and edit drawers. */
function AddressFields({
  draft,
  errors,
  onChange,
  note,
}: {
  draft: NetworkDraft;
  errors: Partial<Record<keyof NetworkDraft, string>>;
  onChange: (patch: Partial<NetworkDraft>) => void;
  /** Shown under the subnet, e.g. what an address change does. */
  note?: ComponentChildren;
}) {
  const net =
    !errors.address && !errors.prefix
      ? networkAddress(draft.address, draft.prefix)
      : null;
  const rangeHint = (() => {
    if (!net) return undefined;
    const s = hostOffset(draft.rangeStart, net, draft.prefix);
    const e = hostOffset(draft.rangeEnd, net, draft.prefix);
    return s !== null && e !== null && e >= s
      ? `${e - s + 1} addresses`
      : undefined;
  })();
  return (
    <>
      <FormSection title="Gateway">
        <Field label="Router IP" stacked error={errors.address}>
          {(id) => (
            <input
              id={id}
              class="input font-mono"
              value={draft.address}
              onInput={(e) =>
                onChange(
                  moveDraft(draft, e.currentTarget.value.trim(), draft.prefix),
                )
              }
            />
          )}
        </Field>
        <Field
          label="Subnet"
          stacked
          error={errors.prefix}
          hint={net ? `${net}/${draft.prefix}` : undefined}
        >
          {(id) => (
            <select
              id={id}
              class="input"
              value={draft.prefix}
              onChange={(e) =>
                onChange(
                  moveDraft(
                    draft,
                    draft.address,
                    Number(e.currentTarget.value),
                  ),
                )
              }
            >
              {[...new Set([...PREFIXES, draft.prefix])]
                .sort((a, b) => a - b)
                .map((p) => (
                  <option key={p} value={p}>
                    /{p} ({(2 ** (32 - p) - 2).toLocaleString()} hosts)
                  </option>
                ))}
            </select>
          )}
        </Field>
        {note && <div class="pb-2">{note}</div>}
      </FormSection>

      <FormSection title="DHCP">
        <ToggleRow
          label="DHCP server"
          hint="Hand out addresses to devices on this network."
          checked={draft.dhcpEnabled}
          onChange={(dhcpEnabled) => onChange({ dhcpEnabled })}
        />
        {draft.dhcpEnabled && (
          <>
            <div class="grid grid-cols-2 gap-3">
              <Field label="Range start" stacked error={errors.rangeStart}>
                {(id) => (
                  <input
                    id={id}
                    class="input font-mono"
                    value={draft.rangeStart}
                    onInput={(e) =>
                      onChange({ rangeStart: e.currentTarget.value.trim() })
                    }
                  />
                )}
              </Field>
              <Field
                label="Range end"
                stacked
                error={errors.rangeEnd}
                hint={rangeHint}
              >
                {(id) => (
                  <input
                    id={id}
                    class="input font-mono"
                    value={draft.rangeEnd}
                    onInput={(e) =>
                      onChange({ rangeEnd: e.currentTarget.value.trim() })
                    }
                  />
                )}
              </Field>
            </div>
            <Field label="Lease time" stacked error={errors.leasetime}>
              {(id) => (
                <select
                  id={id}
                  class="input"
                  value={draft.leasetime}
                  onChange={(e) =>
                    onChange({ leasetime: e.currentTarget.value })
                  }
                >
                  {!LEASES.some((l) => l.value === draft.leasetime) && (
                    <option value={draft.leasetime}>{draft.leasetime}</option>
                  )}
                  {LEASES.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </>
        )}
      </FormSection>
    </>
  );
}

const IP6_SIZES = ["64", "63", "62", "60", "56", "48"];

const ODHCPD_MODES = [
  { value: "server", label: "Server" },
  { value: "", label: "Disabled" },
];

function ModeSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label} stacked>
      {(id) => (
        <select
          id={id}
          class="input"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          {!ODHCPD_MODES.some((m) => m.value === value) && (
            <option value={value}>{value}</option>
          )}
          {ODHCPD_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** DNS and domain handed out by DHCP, IPv6 and IGMP snooping. */
function ExtrasFields({
  x,
  before,
  errors,
  dhcpEnabled,
  onChange,
}: {
  x: NetworkExtras;
  before: NetworkExtras;
  errors: ReturnType<typeof validateExtras>;
  dhcpEnabled: boolean;
  onChange: (patch: Partial<NetworkExtras>) => void;
}) {
  const modes: { value: NetworkExtras["dnsMode"]; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ];
  if (before.dnsMode === "custom") modes.push({ value: "custom", label: "Custom" });
  return (
    <>
      {dhcpEnabled && (
        <FormSection title="DHCP DNS">
          <div class="flex items-center justify-between gap-3 py-2">
            <span class="text-muted">DNS server</span>
            <Segmented
              label="DNS server"
              value={x.dnsMode}
              onChange={(dnsMode) => onChange({ dnsMode })}
              options={modes}
            />
          </div>
          {x.dnsMode === "auto" && (
            <p class="pb-2 text-xs text-muted">
              Devices use the router for DNS.
            </p>
          )}
          {x.dnsMode === "custom" && (
            <p class="pb-2 text-xs text-muted">
              Set outside netui:{" "}
              <span class="font-mono">{x.dnsRaw.join(" ")}</span>. Choose Auto
              or Manual to replace it.
            </p>
          )}
          {x.dnsMode === "manual" && (
            <div class="grid grid-cols-2 gap-3">
              <Field label="DNS server 1" stacked error={errors.dns1}>
                {(id) => (
                  <input
                    id={id}
                    class="input font-mono"
                    placeholder="1.1.1.1"
                    value={x.dns1}
                    onInput={(e) => onChange({ dns1: e.currentTarget.value.trim() })}
                  />
                )}
              </Field>
              <Field label="DNS server 2" stacked error={errors.dns2}>
                {(id) => (
                  <input
                    id={id}
                    class="input font-mono"
                    placeholder="Optional"
                    value={x.dns2}
                    onInput={(e) => onChange({ dns2: e.currentTarget.value.trim() })}
                  />
                )}
              </Field>
            </div>
          )}
          <Field
            label="Domain name"
            stacked
            error={errors.domain}
            hint="Optional. Overrides the router's local domain for this network."
          >
            {(id) => (
              <input
                id={id}
                class="input"
                value={x.domain}
                onInput={(e) => onChange({ domain: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
        </FormSection>
      )}
      <FormSection title="IPv6">
        <div class="flex items-center justify-between gap-3 py-2">
          <span class="text-muted">Interface type</span>
          <Segmented
            label="IPv6 interface type"
            value={x.ipv6}
            onChange={(ipv6) =>
              onChange(
                ipv6 === "pd" && before.ipv6 === "none"
                  ? { ipv6, ra: "server", dhcpv6: "server", slaac: true }
                  : { ipv6 },
              )
            }
            options={[
              { value: "none", label: "None" },
              { value: "pd", label: "Prefix Delegation" },
            ]}
          />
        </div>
        {x.ipv6 === "pd" && (
          <>
            <Field
              label="Prefix size"
              stacked
              error={errors.ip6assign}
              hint="Carved from the ISP's delegated prefix and the router's ULA prefix."
            >
              {(id) => (
                <select
                  id={id}
                  class="input"
                  value={x.ip6assign}
                  onChange={(e) => onChange({ ip6assign: e.currentTarget.value })}
                >
                  {[...new Set([...IP6_SIZES, x.ip6assign])].map((p) => (
                    <option key={p} value={p}>
                      /{p}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {dhcpEnabled ? (
              <>
                <div class="grid grid-cols-2 gap-3">
                  <ModeSelect
                    label="Router advertisements"
                    value={x.ra}
                    onChange={(ra) => onChange({ ra })}
                  />
                  <ModeSelect
                    label="DHCPv6"
                    value={x.dhcpv6}
                    onChange={(dhcpv6) => onChange({ dhcpv6 })}
                  />
                </div>
                <ToggleRow
                  label="SLAAC"
                  hint="Let devices pick their own addresses from the advertised prefix."
                  checked={x.slaac}
                  onChange={(slaac) => onChange({ slaac })}
                />
              </>
            ) : (
              <p class="pb-2 text-xs text-muted">
                Turn on the DHCP server to advertise IPv6 on this network.
              </p>
            )}
          </>
        )}
      </FormSection>
      {x.igmp !== undefined && (
        <FormSection title="Multicast">
          <ToggleRow
            label="IGMP snooping"
            hint={`Forward multicast only to ports that asked for it. Applies to the whole ${x.bridge} bridge.`}
            checked={x.igmp}
            onChange={(igmp) => onChange({ igmp })}
          />
        </FormSection>
      )}
    </>
  );
}

function NetworkForm({
  n,
  others,
  network,
  dhcp,
  firewall,
  wireless,
  sw,
  onClose,
}: {
  n: Network;
  others: Subnet[];
  network: UciConfig;
  dhcp: UciConfig;
  firewall: UciConfig | undefined;
  wireless: UciConfig | undefined;
  sw: Switch | undefined;
  onClose: () => void;
}) {
  const apply = useApply();
  // Only a VLAN with its own bridge-vlan section can be renumbered; the
  // implicit VLAN 1 of a plain bridge has nothing to rename.
  const vlan =
    sw && !sw.unsupported && sw.vlanFiltering ? vlanOf(sw, n.id) : undefined;
  const source = useMemo<Draft>(
    () => ({
      ...networkDraft(n),
      removed: [],
      added: [],
      vid: vlan?.section ? String(vlan.vid) : "",
      extras: networkExtras(n, network, dhcp),
    }),
    [n, vlan, network, dhcp],
  );
  const { draft, dirty, stale, reset, update } = useDraft(source);
  const [newHost, setNewHost] = useState<NewHost>({
    mac: "",
    name: "",
    ip: "",
  });
  if (!draft) return null;

  const viaThis = location.hostname === n.address;
  const vidChanged = !!vlan?.section && draft.vid !== String(vlan.vid);
  const errors: Partial<Record<keyof Draft, string>> = validateNetwork(
    draft,
    others,
  );
  if (vidChanged) {
    const e = validateVid(
      draft.vid,
      sw!.vlans.map((v) => v.vid).filter((v) => v !== vlan!.vid),
    );
    if (e) errors.vid = e;
  }
  const blocker =
    sw && firewall
      ? deleteBlocker(n.id, { sw, firewall, wireless, viaThis })
      : "Still loading.";
  const subnetValid = !errors.address && !errors.prefix;
  const net = subnetValid ? networkAddress(draft.address, draft.prefix)! : null;
  const reservations = reservationsIn(
    dhcp,
    n.address ?? "0.0.0.0",
    n.prefix ?? 32,
  );
  const addressChanged =
    draft.address !== n.address || draft.prefix !== n.prefix;
  const stranded = net
    ? reservations.filter(
        (r) =>
          !draft.removed.includes(r.section) &&
          !inSubnet(r.ip, net, draft.prefix),
      )
    : [];
  const extraErrors = n.proto === "static" ? validateExtras(draft.extras) : {};
  const firstError =
    Object.values(errors)[0] ?? Object.values(extraErrors)[0] ?? null;
  const v6Changed =
    draft.extras.ipv6 !== source.extras.ipv6 ||
    draft.extras.ip6assign !== source.extras.ip6assign ||
    draft.extras.igmp !== source.extras.igmp;

  const hostError = (() => {
    if (!newHost.mac && !newHost.ip && !newHost.name) return null;
    if (!isMac(newHost.mac))
      return "Enter a MAC address like aa:bb:cc:dd:ee:ff.";
    if (!net || !isIPv4(newHost.ip) || !inSubnet(newHost.ip, net, draft.prefix))
      return `IP must be inside ${net}/${draft.prefix}.`;
    if (newHost.ip === draft.address)
      return "That is the router's own address.";
    const used = [
      ...reservations.filter((r) => !draft.removed.includes(r.section)),
      ...draft.added,
    ];
    if (used.some((r) => r.ip === newHost.ip))
      return `${newHost.ip} is already reserved.`;
    if (
      newHost.name &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(newHost.name)
    )
      return "Name: letters, digits and hyphens only.";
    return null;
  })();

  const submit = () => {
    const ops: UciOp[] = [
      ...networkOps(draft, n, network, dhcp),
      ...draft.removed.map((section): UciOp => ({
        op: "delete",
        config: "dhcp",
        section,
      })),
      ...draft.added.map((h): UciOp => ({
        op: "add",
        config: "dhcp",
        type: "host",
        values: {
          mac: [normalizeMac(h.mac)!.toUpperCase()],
          ip: h.ip,
          ...(h.name ? { name: h.name } : {}),
        },
      })),
    ];
    if (vidChanged)
      ops.push(...renumberOps(sw!, vlan!.vid, Number(draft.vid), network));
    if (n.proto === "static")
      ops.push(
        ...networkExtrasOps(
          draft.extras,
          source.extras,
          n,
          network,
          dhcp,
          // networkOps creates a pool named after the network when needed.
          n.dhcp?.section ?? (draft.dhcpEnabled ? n.id : undefined),
        ),
      );
    // If this page was loaded from the address being changed, follow it.
    void apply.start(ops, {
      disruptive: addressChanged || vidChanged || v6Changed,
      newAddress: addressChanged && viaThis ? draft.address : undefined,
      returnTo: "/settings/networks",
      onConfirmed: onClose,
    });
  };

  return (
    <Drawer
      title={networkLabel(n.id)}
      subtitle={n.address ? `${n.address}/${n.prefix}` : n.proto}
      icon={<IconNetwork size={20} />}
      onClose={onClose}
      footer={
        <>
          {n.id !== "lan" && (
            <Button
              variant="danger"
              class="mr-auto"
              title={blocker ?? undefined}
              disabled={!!blocker || apply.busy}
              onClick={() =>
                void apply.start(
                  deleteNetworkOps(n.id, {
                    sw: sw!,
                    network,
                    dhcp,
                    firewall: firewall!,
                  }),
                  {
                    disruptive: !!vlan,
                    returnTo: "/settings/networks",
                  },
                )
              }
            >
              <IconTrash size={14} /> Delete
            </Button>
          )}
          <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
            {dirty ? "Reset" : "Close"}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!dirty || !!firstError || apply.busy}
          >
            Apply Changes
          </Button>
        </>
      }
    >
      <div class="px-5">
        {stale && (
          <div class="mt-4">
            <Banner
              tone="warn"
              role="status"
              actions={<Button onClick={reset}>Load latest</Button>}
            >
              This network was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        {vlan?.section && (
          <FormSection title="VLAN">
            <Field
              label="VLAN ID"
              stacked
              error={errors.vid}
              hint="Ports and WiFi carrying this network follow the new ID."
            >
              {(id) => (
                <input
                  id={id}
                  class="input font-mono"
                  inputMode="numeric"
                  value={draft.vid}
                  onInput={(e) => update({ vid: e.currentTarget.value.trim() })}
                />
              )}
            </Field>
            {vidChanged && !errors.vid && (
              <div class="pb-2">
                <Banner tone="warn" role="status">
                  Switches and access points that tag this network as VLAN{" "}
                  {vlan.vid} must be changed too, or their devices lose this
                  network.
                </Banner>
              </div>
            )}
          </FormSection>
        )}
        {n.proto !== "static" ? (
          <p class="py-4 text-muted">
            This network uses <b>{n.proto}</b> addressing. Edit it in{" "}
            <a
              class="text-accent hover:underline"
              href="/cgi-bin/luci/admin/network/network"
              target="_blank"
              rel="noreferrer"
            >
              LuCI
            </a>
            .
          </p>
        ) : (
          <>
            <AddressFields
              draft={draft}
              errors={errors}
              onChange={(patch) => update(patch)}
              note={
                addressChanged &&
                !errors.address && (
                  <Banner tone="warn" role="status">
                    Devices on this network get new addresses when their leases
                    renew.
                    {location.hostname === n.address
                      ? ` This page will move to ${draft.address} and confirm from there.`
                      : ""}{" "}
                    If the router is not reachable afterwards it reverts in 30
                    seconds.
                  </Banner>
                )
              }
            />
            <ExtrasFields
              x={draft.extras}
              before={source.extras}
              errors={extraErrors}
              dhcpEnabled={draft.dhcpEnabled}
              onChange={(patch) =>
                update((d) => ({ ...d, extras: { ...d.extras, ...patch } }))
              }
            />
          </>
        )}

        <FormSection title="Fixed IP addresses">
          {stranded.length > 0 && (
            <div class="py-2">
              <Banner tone="warn" role="status">
                {stranded.map((r) => r.name ?? r.ip).join(", ")}{" "}
                {stranded.length === 1 ? "is" : "are"} outside the new subnet
                and will not get {stranded.length === 1 ? "its" : "their"} fixed
                address. Remove or re-add them.
              </Banner>
            </div>
          )}
          <ul class="divide-y divide-line">
            {reservations.map((r) => {
              const gone = draft.removed.includes(r.section);
              return (
                <li key={r.section} class="flex h-10 items-center gap-3">
                  <span
                    class={
                      gone
                        ? "min-w-0 flex-1 truncate text-faint line-through"
                        : "min-w-0 flex-1 truncate"
                    }
                  >
                    {r.name ?? <span class="text-muted">Unnamed</span>}
                  </span>
                  <span class="font-mono text-xs text-muted">{r.ip}</span>
                  <span class="hidden font-mono text-xs text-faint sm:inline">
                    {r.macs[0]?.toLowerCase()}
                  </span>
                  <button
                    type="button"
                    aria-label={
                      gone
                        ? `Keep ${r.name ?? r.ip}`
                        : `Remove ${r.name ?? r.ip}`
                    }
                    class="rounded p-1 text-muted hover:bg-hover hover:text-bad"
                    onClick={() =>
                      update((d) => ({
                        ...d,
                        removed: gone
                          ? d.removed.filter((s) => s !== r.section)
                          : [...d.removed, r.section],
                      }))
                    }
                  >
                    {gone ? (
                      <span class="text-xs text-accent">Undo</span>
                    ) : (
                      <IconTrash size={15} />
                    )}
                  </button>
                </li>
              );
            })}
            {draft.added.map((h, i) => (
              <li key={`new-${i}`} class="flex h-10 items-center gap-3">
                <span class="min-w-0 flex-1 truncate">
                  {h.name || <span class="text-muted">Unnamed</span>}{" "}
                  <Pill tone="accent">New</Pill>
                </span>
                <span class="font-mono text-xs text-muted">{h.ip}</span>
                <button
                  type="button"
                  aria-label={`Remove ${h.name || h.ip}`}
                  class="rounded p-1 text-muted hover:bg-hover hover:text-bad"
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      added: d.added.filter((_, j) => j !== i),
                    }))
                  }
                >
                  <IconTrash size={15} />
                </button>
              </li>
            ))}
            {reservations.length === 0 && draft.added.length === 0 && (
              <li class="py-2 text-muted">None.</li>
            )}
          </ul>
          <div class="mt-3 grid grid-cols-[1fr_1fr] gap-2">
            <input
              aria-label="MAC address"
              placeholder="MAC address"
              class="input font-mono"
              value={newHost.mac}
              onInput={(e) =>
                setNewHost({ ...newHost, mac: e.currentTarget.value.trim() })
              }
            />
            <input
              aria-label="Fixed IP"
              placeholder={
                net
                  ? (hostAt(draft.address, draft.prefix, 50) ?? "IP address")
                  : "IP address"
              }
              class="input font-mono"
              value={newHost.ip}
              onInput={(e) =>
                setNewHost({ ...newHost, ip: e.currentTarget.value.trim() })
              }
            />
            <input
              aria-label="Name"
              placeholder="Name (optional)"
              class="input"
              value={newHost.name}
              onInput={(e) =>
                setNewHost({ ...newHost, name: e.currentTarget.value.trim() })
              }
            />
            <Button
              disabled={!newHost.mac || !newHost.ip || !!hostError}
              onClick={() => {
                update((d) => ({ ...d, added: [...d.added, newHost] }));
                setNewHost({ mac: "", name: "", ip: "" });
              }}
            >
              <IconPlus size={14} /> Add
            </Button>
          </div>
          {hostError && newHost.mac && newHost.ip && (
            <p class="mt-1 text-xs text-bad">{hostError}</p>
          )}
          <p class="mt-2 pb-2 text-xs text-muted">
            You can also set a fixed IP from a device's panel under Client
            Devices.
          </p>
        </FormSection>
      </div>
    </Drawer>
  );
}

function CreateNetworkForm({
  sw,
  others,
  network,
  dhcp,
  firewall,
  onClose,
}: {
  sw: Switch;
  others: Subnet[];
  network: UciConfig;
  dhcp: UciConfig;
  firewall: UciConfig;
  onClose: () => void;
}) {
  const apply = useApply();
  const [draft, setDraft] = useState<NewNetworkDraft>(() =>
    newNetworkDraft(sw, others),
  );
  const [touched, setTouched] = useState(false);
  const update = (patch: Partial<NewNetworkDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const errors = validateNewNetwork(draft, {
    sw,
    network,
    dhcp,
    firewall,
    others,
  });
  const firstError = Object.values(errors)[0] ?? null;
  const ports = sw.ports.filter(
    (p) => p.role === "lan" && inUse(p.profile),
  ).length;

  const submit = () =>
    void apply.start(createNetworkOps(draft, { sw, network, firewall }), {
      disruptive: true,
      returnTo: "/settings/networks",
      onConfirmed: onClose,
    });

  return (
    <Drawer
      title="Create New Network"
      subtitle={`VLAN on ${sw.bridge}`}
      icon={<IconNetwork size={20} />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={apply.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!!firstError || apply.busy}
          >
            Create Network
          </Button>
        </>
      }
    >
      <div class="px-5">
        <FormSection title="Network">
          <Field
            label="Name"
            stacked
            error={touched || draft.name ? errors.name : undefined}
            hint="Lowercase, e.g. iot or guest. Also names its firewall zone."
          >
            {(id) => (
              <input
                id={id}
                class="input"
                placeholder="iot"
                value={draft.name}
                onBlur={() => setTouched(true)}
                onInput={(e) => update({ name: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
          <Field label="VLAN ID" stacked error={errors.vid}>
            {(id) => (
              <input
                id={id}
                class="input font-mono"
                inputMode="numeric"
                value={draft.vid}
                onInput={(e) => update({ vid: e.currentTarget.value.trim() })}
              />
            )}
          </Field>
          <div class="py-2">
            <Segmented
              label="Access"
              value={draft.isolation}
              onChange={(isolation) => update({ isolation })}
              options={[
                { value: "trusted", label: "Trusted" },
                { value: "isolated", label: "Isolated" },
              ]}
            />
          </div>
          <p class="pb-2 text-xs text-muted">
            {draft.isolation === "trusted"
              ? "Joins the LAN firewall zone: reaches the router, the LAN and the internet."
              : "Its own firewall zone: internet only. Devices get DHCP and DNS from the router but cannot reach it or other networks."}
          </p>
        </FormSection>
        <AddressFields draft={draft} errors={errors} onChange={update} />
        <FormSection title="Ports">
          <ToggleRow
            label="Tag on all ports"
            hint={
              ports
                ? `Carry this network tagged on the ${ports} port${ports === 1 ? "" : "s"} in ${sw.bridge}. Devices that do not tag VLANs ignore it.`
                : `No ports carry ${sw.bridge} yet.`
            }
            checked={draft.allPorts}
            onChange={(allPorts) => update({ allPorts })}
          />
          <p class="pb-3 text-xs text-muted">
            To give the network its own port, set that port's native network
            under Ports after creating it.
            {!sw.vlanFiltering &&
              ` This turns on VLAN filtering on ${sw.bridge}; the LAN stays untagged on every port as VLAN 1.`}{" "}
            The bridge restarts, so wired devices lose their connection for a
            few seconds.
          </p>
        </FormSection>
      </div>
    </Drawer>
  );
}

export function NetworksPage() {
  const { networks, subnets, network, dhcp, firewall, ifaces, error } =
    useNetworks();
  const { sw } = useSwitch();
  const wireless = useUci("wireless");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = networks?.find((n) => n.id === selected);
  const canCreate =
    !!sw && !sw.unsupported && !!network.data && !!dhcp.data && !!firewall.data;

  return (
    <Page
      title="Networks"
      subtitle="Local networks, their gateway address and DHCP"
      actions={
        canCreate ? (
          <Button
            variant="primary"
            onClick={() => {
              setSelected(null);
              setCreating(true);
            }}
          >
            <IconPlus size={14} /> Create New Network
          </Button>
        ) : (
          sw && (
            <a
              href="/cgi-bin/luci/admin/network/network"
              target="_blank"
              rel="noreferrer"
              class="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 font-medium hover:bg-hover"
            >
              New network in LuCI <IconExternal size={14} />
            </a>
          )
        )
      }
    >
      <LoadError error={error} />
      <Card flush>
        {!networks ? (
          <div class="flex justify-center py-10">
            <Spinner />
          </div>
        ) : networks.length === 0 ? (
          <Empty>No local networks.</Empty>
        ) : (
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>VLAN</th>
                  <th>Router IP</th>
                  <th>Subnet</th>
                  <th>DHCP range</th>
                  <th>Lease</th>
                  <th>Interface</th>
                </tr>
              </thead>
              <tbody>
                {networks.map((n) => (
                  <tr
                    key={n.id}
                    data-clickable
                    aria-selected={n.id === selected}
                    onClick={() => {
                      setCreating(false);
                      setSelected(n.id === selected ? null : n.id);
                    }}
                  >
                    <td class="font-medium">
                      <span class="inline-flex items-center gap-2">
                        <IconNetwork size={16} class="text-muted" />{" "}
                        {networkLabel(n.id)}
                      </span>
                    </td>
                    <td>
                      <span class="inline-flex items-center gap-1.5">
                        <Dot tone={n.up ? "ok" : "neutral"} />{" "}
                        {n.up
                          ? `Up ${n.uptime ? formatDuration(n.uptime) : ""}`
                          : "Down"}
                      </span>
                    </td>
                    <td>
                      <VlanCell sw={sw} id={n.id} />
                    </td>
                    <td class="font-mono text-xs">{n.address ?? "—"}</td>
                    <td class="font-mono text-xs text-muted">
                      {n.address && n.prefix !== undefined
                        ? `${networkAddress(n.address, n.prefix)}/${n.prefix}`
                        : "—"}
                    </td>
                    <td class="font-mono text-xs">{poolSize(n)}</td>
                    <td class="text-muted">
                      {n.dhcp?.enabled ? n.dhcp.leasetime : "—"}
                    </td>
                    <td class="font-mono text-xs text-muted">
                      {n.device ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {networks && networks.length > 0 && (
        <div class="mt-4">
          <GuestPortalCard networks={networks} />
        </div>
      )}
      {current && network.data && dhcp.data && (
        <NetworkForm
          key={current.id}
          n={current}
          others={attachedSubnets(subnets, ifaces.data).filter(
            (s) => s.network !== current.id,
          )}
          network={network.data}
          dhcp={dhcp.data}
          firewall={firewall.data}
          wireless={wireless.data}
          sw={sw}
          onClose={() => setSelected(null)}
        />
      )}
      {creating && canCreate && (
        <CreateNetworkForm
          sw={sw}
          others={attachedSubnets(subnets, ifaces.data)}
          network={network.data!}
          dhcp={dhcp.data!}
          firewall={firewall.data!}
          onClose={() => setCreating(false)}
        />
      )}
    </Page>
  );
}
