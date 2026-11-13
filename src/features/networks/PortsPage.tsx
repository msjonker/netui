import { useMemo, useState } from "preact/hooks";
import type { UciConfig } from "../../api/types";
import { useApply } from "../../api/useApply";
import { useNetworks, useSwitch } from "../../model/hooks";
import {
  currentPlan,
  inUse,
  sameProfile,
  switchOps,
  vlanOf,
  type PortProfile,
  type Switch,
  type SwitchPort,
} from "../../model/ports";
import { useDraft } from "../../lib/useDraft";
import { Drawer } from "../../components/overlay";
import { IconEthernet, IconExternal } from "../../components/icons";
import {
  Banner,
  Button,
  Card,
  Detail,
  Dot,
  Empty,
  Field,
  FormSection,
  LoadError,
  Page,
  Pill,
  Segmented,
  Spinner,
  cx,
} from "../../components/ui";
import { vlanColor, vlanLabel } from "./vlanStyle";

const LUCI_DEVICES = "/cgi-bin/luci/admin/network/network";

function speedLabel(p: SwitchPort): string {
  if (!p.carrier) return "No link";
  if (!p.speed) return "Up";
  return `${p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`}${p.duplex === "half" ? " half" : ""}`;
}

function NetworkChip({
  sw,
  vid,
  muted,
}: {
  sw: Switch;
  vid: number;
  muted?: boolean;
}) {
  return (
    <span
      class={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        muted && "text-muted",
      )}
    >
      <span
        class="inline-block size-2 shrink-0 rounded-sm"
        style={{ background: vlanColor(sw, vid) }}
        aria-hidden="true"
      />
      {vlanLabel(sw, vid)}
    </span>
  );
}

function taggedSummary(sw: Switch, p: PortProfile) {
  const others = sw.vlans.filter((v) => v.vid !== p.native);
  if (p.tagged.length === 0) return <span class="text-faint">None</span>;
  if (others.length > 1 && p.tagged.length === others.length)
    return <span>All ({p.tagged.length})</span>;
  return (
    <span class="inline-flex flex-wrap gap-x-3 gap-y-1">
      {p.tagged.map((vid) => (
        <NetworkChip key={vid} sw={sw} vid={vid} muted />
      ))}
    </span>
  );
}

/** Front panel: one tile per port, colored by its native network. */
function PortPanel({
  sw,
  selected,
  onSelect,
}: {
  sw: Switch;
  selected: string | null;
  onSelect: (p: string) => void;
}) {
  return (
    <ul class="flex flex-wrap gap-2" aria-label="Port panel">
      {sw.ports.map((p) => {
        const native = p.profile.native;
        return (
          <li key={p.name}>
            <button
              type="button"
              aria-label={`Port ${p.name}`}
              aria-pressed={p.name === selected}
              onClick={() => onSelect(p.name)}
              class={cx(
                "flex w-[72px] flex-col overflow-hidden rounded-md border text-[11px] transition-colors",
                p.name === selected
                  ? "border-accent ring-2 ring-accent-soft"
                  : "border-line hover:border-line-strong",
              )}
            >
              <span
                class={cx(
                  "flex h-14 flex-col items-center justify-center gap-0.5",
                  p.carrier
                    ? p.role === "wan"
                      ? "bg-accent-soft text-accent"
                      : "bg-ok-soft text-ok"
                    : "bg-subtle text-faint",
                )}
              >
                <IconEthernet size={18} />
                <span class="font-medium">
                  {p.role === "wan" ? "WAN" : p.name}
                </span>
              </span>
              <span
                class="h-1.5"
                style={{
                  background:
                    p.role === "lan" && native !== undefined
                      ? vlanColor(sw, native)
                      : "transparent",
                }}
              />
              <span class="flex h-1 gap-px">
                {p.profile.tagged.map((vid) => (
                  <span
                    key={vid}
                    class="flex-1"
                    style={{ background: vlanColor(sw, vid) }}
                  />
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type TagMode = "all" | "none" | "custom";

interface PortDraft {
  /** VLAN ID as a string, '' for none. */
  native: string;
  mode: TagMode;
  tagged: number[];
  untagged: number[];
}

function toDraft(sw: Switch, p: PortProfile): PortDraft {
  const others = sw.vlans.filter((v) => v.vid !== p.native).map((v) => v.vid);
  const mode: TagMode =
    p.tagged.length === 0
      ? "none"
      : others.length > 0 && others.every((v) => p.tagged.includes(v))
        ? "all"
        : "custom";
  return {
    native: p.native === undefined ? "" : String(p.native),
    mode,
    tagged: p.tagged,
    untagged: p.untagged ?? [],
  };
}

function fromDraft(sw: Switch, d: PortDraft): PortProfile {
  const native = d.native === "" ? undefined : Number(d.native);
  const others = sw.vlans.map((v) => v.vid).filter((v) => v !== native);
  const tagged =
    d.mode === "all"
      ? others
      : d.mode === "none"
        ? []
        : d.tagged.filter((v) => v !== native);
  const untagged = d.untagged.filter(
    (v) => v !== native && !tagged.includes(v),
  );
  const p: PortProfile = { tagged: [...tagged].sort((a, b) => a - b) };
  if (native !== undefined) p.native = native;
  if (untagged.length) p.untagged = untagged;
  return p;
}

function PortForm({
  port,
  sw,
  network,
  mgmt,
  onClose,
}: {
  port: SwitchPort;
  sw: Switch;
  network: UciConfig;
  /** VLAN of the network this page was loaded from, if it is on the bridge. */
  mgmt?: { vid: number; name: string };
  onClose: () => void;
}) {
  const apply = useApply();
  const source = useMemo(() => toDraft(sw, port.profile), [sw, port]);
  const { draft, dirty, stale, reset, update } = useDraft(source);
  if (!draft) return null;

  const readOnly = port.role === "wan" || !!sw.unsupported;
  const next = fromDraft(sw, draft);
  const changed = !sameProfile(next, port.profile);
  const others = sw.vlans.filter((v) => String(v.vid) !== draft.native);
  const plan = currentPlan(sw);
  plan.profiles[port.name] = next;
  const losesMgmt =
    mgmt !== undefined &&
    port.profile.native === mgmt.vid &&
    next.native !== mgmt.vid;
  const noMgmtPort =
    mgmt !== undefined &&
    !Object.values(plan.profiles).some((p) => p.native === mgmt.vid);

  const submit = () => {
    void apply.start(switchOps(sw, plan, network), {
      disruptive: true,
      returnTo: "/settings/ports",
      onConfirmed: onClose,
    });
  };

  return (
    <Drawer
      title={port.role === "wan" ? `${port.name} (WAN)` : port.name}
      subtitle={speedLabel(port)}
      icon={<IconEthernet size={20} />}
      onClose={onClose}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={dirty ? reset : onClose} disabled={apply.busy}>
              {dirty ? "Reset" : "Close"}
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={!changed || apply.busy}
            >
              Apply Changes
            </Button>
          </>
        )
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
              The port setup was changed on the router while you were editing.
            </Banner>
          </div>
        )}
        <div class="py-2">
          <Detail
            rows={[
              [
                "Link",
                <span class="inline-flex items-center gap-1.5">
                  <Dot tone={port.carrier ? "ok" : "neutral"} />{" "}
                  {speedLabel(port)}
                </span>,
              ],
              [
                "Bridge",
                port.role === "lan"
                  ? sw.bridge
                  : port.role === "wan"
                    ? "Internet uplink"
                    : "Not in use",
              ],
            ]}
          />
        </div>

        {port.role === "wan" ? (
          <p class="pb-4 text-muted">
            This port carries the internet connection. Change it under Internet
            or in LuCI.
          </p>
        ) : sw.unsupported ? (
          <p class="pb-4 text-muted">
            This router's switch layout is edited in LuCI.
          </p>
        ) : (
          <>
            {port.irregular && (
              <div class="pb-2">
                <Banner tone="warn" role="status">
                  This port's VLAN setup was made outside netui and is shown in
                  its nearest form. Applying a change rewrites it in this form.
                </Banner>
              </div>
            )}
            <FormSection title="Native network">
              <Field
                label="Untagged traffic"
                stacked
                hint="Devices plugged into this port join this network."
              >
                {(id) => (
                  <select
                    id={id}
                    class="input"
                    value={draft.native}
                    onChange={(e) => update({ native: e.currentTarget.value })}
                  >
                    {sw.vlans.map((v) => (
                      <option key={v.vid} value={String(v.vid)}>
                        {vlanLabel(sw, v.vid)}
                      </option>
                    ))}
                    <option value="">None</option>
                  </select>
                )}
              </Field>
              {losesMgmt && (
                <div class="pb-2">
                  <Banner tone="warn" role="status">
                    You reached this page over {mgmt!.name}. If this computer is
                    plugged into {port.name}, it loses access; the router then
                    reverts on its own after 30 seconds.
                  </Banner>
                </div>
              )}
              {noMgmtPort && !losesMgmt && (
                <div class="pb-2">
                  <Banner tone="warn" role="status">
                    No port will carry {mgmt!.name} untagged.
                  </Banner>
                </div>
              )}
            </FormSection>

            <FormSection title="Tagged VLANs">
              {sw.vlans.length < 2 && draft.native !== "" ? (
                <p class="py-2 text-muted">
                  There is only one network on this bridge. Create a VLAN
                  network under Networks to carry more than one network over
                  this port.
                </p>
              ) : (
                <>
                  <div class="py-2">
                    <Segmented
                      label="Tagged VLANs"
                      value={draft.mode}
                      onChange={(mode) =>
                        update((d) => ({
                          ...d,
                          mode,
                          tagged:
                            mode === "custom"
                              ? fromDraft(sw, d).tagged
                              : d.tagged,
                        }))
                      }
                      options={[
                        { value: "all", label: "Allow All" },
                        { value: "none", label: "Block All" },
                        { value: "custom", label: "Custom" },
                      ]}
                    />
                  </div>
                  <p class="pb-2 text-xs text-muted">
                    {draft.mode === "all"
                      ? "Every other network, tagged. For access points, switches and servers that speak 802.1Q."
                      : draft.mode === "none"
                        ? "Only the native network."
                        : "Only the networks checked below, tagged."}
                  </p>
                  {draft.mode === "custom" && (
                    <ul class="pb-2">
                      {others.map((v) => (
                        <li key={v.vid}>
                          <label class="flex h-8 cursor-pointer items-center gap-2.5">
                            <input
                              type="checkbox"
                              class="size-4 accent-[var(--accent)]"
                              checked={draft.tagged.includes(v.vid)}
                              onChange={(e) => {
                                const on = e.currentTarget.checked;
                                update((d) => ({
                                  ...d,
                                  tagged: on
                                    ? [...d.tagged, v.vid].sort((a, b) => a - b)
                                    : d.tagged.filter((t) => t !== v.vid),
                                }));
                              }}
                            />
                            <NetworkChip sw={sw} vid={v.vid} />
                          </label>
                        </li>
                      ))}
                      {others.length === 0 && (
                        <li class="py-2 text-muted">No other networks.</li>
                      )}
                    </ul>
                  )}
                </>
              )}
              {draft.untagged.length > 0 && (
                <div class="pb-2">
                  <Banner
                    tone="warn"
                    role="status"
                    actions={
                      <Button onClick={() => update({ untagged: [] })}>
                        Remove
                      </Button>
                    }
                  >
                    Also sends{" "}
                    {draft.untagged.map((v) => vlanLabel(sw, v)).join(", ")}{" "}
                    untagged, without being its native network. netui keeps this
                    as it is unless you remove it.
                  </Banner>
                </div>
              )}
            </FormSection>
            {!inUse(next) && (
              <div class="py-3">
                <Banner tone="accent" role="status">
                  This port will carry no network and is taken out of{" "}
                  {sw.bridge}.
                </Banner>
              </div>
            )}
            {changed && (
              <p class="py-3 text-xs text-muted">
                Port changes restart the bridge, so devices on every port lose
                their connection for a few seconds.
              </p>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

const UNSUPPORTED: Record<NonNullable<Switch["unsupported"]>, string> = {
  swconfig:
    "This router has an older switch chip (swconfig). Its VLANs are set up in LuCI.",
  "no-bridge":
    "This router has no LAN bridge, so there are no port settings to change here.",
  custom:
    "The LAN bridge has interfaces netui cannot place on a VLAN (made in LuCI or by hand). Port settings are shown read-only; change them in LuCI.",
};

export function PortsPage() {
  const { sw, network, error } = useSwitch();
  const { networks } = useNetworks();
  const [selected, setSelected] = useState<string | null>(null);
  const port = sw?.ports.find((p) => p.name === selected);

  const mgmt = useMemo(() => {
    const n = networks?.find((x) => x.address === location.hostname);
    const v = n && sw ? vlanOf(sw, n.id) : undefined;
    return n && v ? { vid: v.vid, name: vlanLabel(sw!, v.vid) } : undefined;
  }, [networks, sw]);

  return (
    <Page
      title="Ports"
      subtitle="What each port carries: one native network plus any tagged VLANs"
      actions={
        <a
          href={LUCI_DEVICES}
          target="_blank"
          rel="noreferrer"
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 font-medium hover:bg-hover"
        >
          Devices in LuCI <IconExternal size={14} />
        </a>
      }
    >
      <LoadError error={error} />
      {sw?.unsupported && (
        <div class="mb-4">
          <Banner tone="warn" role="status">
            {UNSUPPORTED[sw.unsupported]}
          </Banner>
        </div>
      )}
      {!sw ? (
        <div class="flex justify-center py-10">
          <Spinner />
        </div>
      ) : sw.ports.length === 0 ? (
        <Card>
          <Empty>No ethernet ports found.</Empty>
        </Card>
      ) : (
        <div class="space-y-4">
          <Card
            title={sw.bridge || "Ports"}
            actions={
              <span class="text-muted">
                {sw.vlanFiltering
                  ? `VLAN filtering · ${sw.vlans.length} VLANs`
                  : "Plain bridge, no VLANs"}
              </span>
            }
          >
            <PortPanel
              sw={sw}
              selected={selected}
              onSelect={(p) => setSelected(p === selected ? null : p)}
            />
            {sw.vlans.length > 0 && (
              <div class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {sw.vlans.map((v) => (
                  <NetworkChip key={v.vid} sw={sw} vid={v.vid} />
                ))}
              </div>
            )}
          </Card>
          <Card flush>
            <div class="overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Link</th>
                    <th>Native network</th>
                    <th>Tagged VLANs</th>
                  </tr>
                </thead>
                <tbody>
                  {sw.ports.map((p) => (
                    <tr
                      key={p.name}
                      data-clickable
                      aria-selected={p.name === selected}
                      onClick={() =>
                        setSelected(p.name === selected ? null : p.name)
                      }
                    >
                      <td class="font-medium">
                        <span class="inline-flex items-center gap-2">
                          <IconEthernet size={16} class="text-muted" /> {p.name}
                          {p.irregular && <Pill tone="warn">Custom</Pill>}
                        </span>
                      </td>
                      <td>
                        <span class="inline-flex items-center gap-1.5">
                          <Dot tone={p.carrier ? "ok" : "neutral"} />{" "}
                          {speedLabel(p)}
                        </span>
                      </td>
                      <td>
                        {p.role === "wan" ? (
                          <Pill tone="accent">Internet</Pill>
                        ) : p.role === "unused" ? (
                          <span class="text-faint">Not in use</span>
                        ) : p.profile.native !== undefined ? (
                          <NetworkChip sw={sw} vid={p.profile.native} />
                        ) : (
                          <span class="text-faint">None</span>
                        )}
                      </td>
                      <td>
                        {p.role === "lan" ? (
                          taggedSummary(sw, p.profile)
                        ) : (
                          <span class="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
      {port && sw && network.data && (
        <PortForm
          key={port.name}
          port={port}
          sw={sw}
          network={network.data}
          mgmt={mgmt}
          onClose={() => setSelected(null)}
        />
      )}
    </Page>
  );
}
