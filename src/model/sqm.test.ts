import { describe, expect, it } from 'vitest';
import type { UciConfig, UciGet } from '../api/types';
import sqmJson from '../../test/fixtures/ubus/dl-wrx36/plain/uci.get.sqm.json';
import { normalizeSqm, sqmDraft, sqmOps, validateSqm } from './sqm';

const recorded: UciGet = sqmJson;
const cfg = (): UciConfig => structuredClone(recorded.values);

describe('sqm', () => {
  it('reads the factory queue in Mbps', () => {
    const q = normalizeSqm(cfg(), 'wan');
    expect(q).toEqual({ section: 'eth1', enabled: false, interface: 'eth1', download: 85000, upload: 10000 });
    expect(sqmDraft(q)).toEqual({ enabled: false, down: '85', up: '10' });
  });

  it('enabling points the queue at the WAN device', () => {
    const c = cfg();
    const q = normalizeSqm(c, 'wan');
    expect(sqmOps({ enabled: true, down: '450', up: '42.5' }, q, c, 'wan')).toEqual([
      { op: 'set', config: 'sqm', section: 'eth1', values: { enabled: '1', interface: 'wan', download: '450000', upload: '42500' } },
    ]);
  });

  it('disabling only flips enabled', () => {
    const c = cfg();
    c.eth1!.enabled = '1';
    expect(sqmOps({ enabled: false, down: '85', up: '10' }, normalizeSqm(c), c, 'wan')).toEqual([
      { op: 'set', config: 'sqm', section: 'eth1', values: { enabled: '0' } },
    ]);
  });

  it('adds a queue when the config has none', () => {
    expect(sqmOps({ enabled: true, down: '100', up: '20' }, undefined, {}, 'pppoe-wan')).toEqual([
      {
        op: 'add',
        config: 'sqm',
        type: 'queue',
        name: 'wan',
        values: { enabled: '1', interface: 'pppoe-wan', qdisc: 'cake', script: 'piece_of_cake.qos', download: '100000', upload: '20000', linklayer: 'none' },
      },
    ]);
  });

  it('validates limits only when enabled', () => {
    expect(validateSqm({ enabled: false, down: '', up: '' })).toEqual({});
    expect(Object.keys(validateSqm({ enabled: true, down: '0', up: 'abc' }))).toEqual(['down', 'up']);
  });
});
