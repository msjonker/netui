import { describe, expect, it } from 'vitest';
import type { UciGet } from '../api/types';
import recorded from '../../test/fixtures/ubus/bench-v2/gateway.uci.get.adblock-fast.json';
import { adblockDraft, adblockOps, readAdblock, validateAdblock, DEFAULT_LIST } from './adblock';

const cfg = () => structuredClone((recorded as UciGet).values);

describe('ad blocking', () => {
  it('reads the stock config: off, block lists with sizes, the required allow entry hidden', () => {
    const a = readAdblock(cfg());
    expect(a.enabled).toBe(false);
    expect(a.lists.length).toBeGreaterThan(10);
    expect(a.lists[0]).toMatchObject({ name: 'Hagezi - Pro', size: 3476485, enabled: false });
    expect(a.allowed).toEqual([]);
  });

  it('suggests the default list when none is chosen', () => {
    const c = cfg();
    const d = adblockDraft(readAdblock(c));
    expect(d.lists).toHaveLength(1);
    expect(c[d.lists[0]!]!.name).toBe(DEFAULT_LIST);
  });

  it('turns blocking on with the chosen lists and domains, keeping jsdelivr allowed', () => {
    const c = cfg();
    const d = { ...adblockDraft(readAdblock(c)), enabled: true, allowed: 'Example.com.\nshop.example.org', blocked: 'ads.example.net' };
    expect(validateAdblock(d)).toEqual({});
    const ops = adblockOps(d, c, false);
    expect(ops[0]).toEqual({
      op: 'set',
      config: 'adblock-fast',
      section: 'config',
      values: { enabled: '1', allowed_domain: ['cdn.jsdelivr.net', 'example.com', 'shop.example.org'], blocked_domain: ['ads.example.net'] },
    });
    expect(ops.filter((o) => o.op === 'set' && o.section !== 'config')).toEqual([
      { op: 'set', config: 'adblock-fast', section: d.lists[0], values: { enabled: '1' } },
    ]);
  });

  it('turns force DNS off when a network has content filtering', () => {
    const c = cfg();
    const ops = adblockOps({ ...adblockDraft(readAdblock(c)), enabled: true }, c, true);
    expect(ops[0]).toMatchObject({ values: { force_dns: '0' } });
  });

  it('rejects bad domains and an empty selection', () => {
    expect(validateAdblock({ enabled: true, lists: [], allowed: 'not a domain!', blocked: '' })).toMatchObject({
      lists: expect.any(String),
      allowed: expect.stringMatching(/not a domain name/),
    });
  });
});
