// Network-wide ad blocking with adblock-fast: dnsmasq answers "no such
// domain" for everything on the chosen block lists. Config as installed is
// recorded in test/fixtures/ubus/bench-v2/gateway.uci.get.adblock-fast.json.

import type { UciConfig } from '../api/types';
import { bool, diffSection, list, sectionsOfType, str, type UciOp } from '../api/uci';

/** Allowed by the stock config so lists hosted there can download; always kept. */
const REQUIRED_ALLOWED = ['cdn.jsdelivr.net'];
/** A good first choice: broad, maintained, a few MB. */
export const DEFAULT_LIST = 'Hagezi - Pro';

export interface AdblockList {
  section: string;
  name: string;
  /** Download size in bytes, as the package lists it. */
  size: number;
  enabled: boolean;
}

export interface Adblock {
  enabled: boolean;
  /** Block lists only (lists with action "allow" are left alone). */
  lists: AdblockList[];
  allowed: string[];
  blocked: string[];
}

export function readAdblock(cfg: UciConfig): Adblock {
  const c = cfg.config;
  return {
    enabled: bool(c?.enabled, false),
    lists: sectionsOfType(cfg, 'file_url')
      .filter((s) => (str(s.action) ?? 'block') === 'block')
      .map((s) => ({ section: s['.name'], name: str(s.name) ?? str(s.url) ?? s['.name'], size: Number(str(s.size) ?? 0), enabled: bool(s.enabled, false) })),
    allowed: list(c?.allowed_domain).filter((d) => !REQUIRED_ALLOWED.includes(d)),
    blocked: list(c?.blocked_domain),
  };
}

export interface AdblockDraft {
  enabled: boolean;
  /** Sections of the chosen lists. */
  lists: string[];
  /** One domain per line (or comma separated). */
  allowed: string;
  blocked: string;
}

export function adblockDraft(a: Adblock): AdblockDraft {
  const on = a.lists.filter((l) => l.enabled).map((l) => l.section);
  const fallback = a.lists.find((l) => l.name === DEFAULT_LIST)?.section ?? a.lists[0]?.section;
  return {
    enabled: a.enabled,
    lists: on.length ? on : fallback ? [fallback] : [],
    allowed: a.allowed.join('\n'),
    blocked: a.blocked.join('\n'),
  };
}

const domains = (v: string) => v.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function validateAdblock(d: AdblockDraft): Partial<Record<keyof AdblockDraft, string>> {
  const e: Partial<Record<keyof AdblockDraft, string>> = {};
  if (d.enabled && d.lists.length === 0) e.lists = 'Choose at least one list.';
  for (const key of ['allowed', 'blocked'] as const) {
    const bad = domains(d[key]).find((x) => !DOMAIN.test(x));
    if (bad) e[key] = `${bad} is not a domain name.`;
  }
  return e;
}

/**
 * `filtered`: some network uses Cloudflare's filtering DNS (Content
 * Filtering). adblock-fast's "force DNS" would redirect those devices' DNS to
 * the router and quietly drop that filter, so it is turned off then.
 */
export function adblockOps(d: AdblockDraft, cfg: UciConfig, filtered: boolean): UciOp[] {
  const c = cfg.config;
  const keep = list(c?.allowed_domain).filter((x) => REQUIRED_ALLOWED.includes(x));
  const ops = diffSection('adblock-fast', 'config', c, {
    enabled: d.enabled ? '1' : '0',
    ...(filtered ? { force_dns: '0' } : {}),
    allowed_domain: [...keep, ...domains(d.allowed).filter((x) => !keep.includes(x))],
    blocked_domain: domains(d.blocked),
  });
  for (const l of readAdblock(cfg).lists) {
    ops.push(...diffSection('adblock-fast', l.section, cfg[l.section], { enabled: d.lists.includes(l.section) ? '1' : '0' }));
  }
  return ops;
}
