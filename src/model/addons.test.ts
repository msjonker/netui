import { describe, expect, it } from 'vitest';
import type { PackagesStatus } from '../api/types';
import { ADDONS, fits, jobError, jobStep } from './addons';
import installing from '../../test/fixtures/ubus/bench-v2/netui.packages.status.installing.json';
import installed from '../../test/fixtures/ubus/bench-v2/netui.packages.status.installed.json';
import noSpace from '../../test/fixtures/ubus/bench-v2/netui.packages.status.no-space.json';

const job = (s: unknown) => (s as PackagesStatus).job!;

describe('jobStep', () => {
  it('is the last step the router printed', () => {
    expect(jobStep(job(installing))).toBe('Refreshing the package lists');
    expect(jobStep(job(installed))).toBe('Done');
  });

  it('skips the package manager progress lines', () => {
    const j = job(installed);
    expect(jobStep({ ...j, log: j.log.replace('Done\n', '') })).toBe('Installing etherwake');
    expect(jobStep({ ...j, log: '' })).toBe('Starting');
  });
});

describe('jobError', () => {
  it('passes on the space check', () => {
    expect(jobError(job(noSpace))).toBe('Not enough space: needs about 3 MB, 1 MB free.');
  });

  it('says the router is offline when the package lists do not download', () => {
    const j = { ...job(noSpace), exit: 1, log: 'Refreshing the package lists\n' };
    expect(jobError(j)).toMatch(/Check that the router is online/);
  });

  it('shows the package manager error', () => {
    const j = { ...job(noSpace), exit: 1, log: 'Refreshing the package lists\nInstalling foo\nERROR: unable to select packages:\n' };
    expect(jobError(j)).toBe('ERROR: unable to select packages:');
  });
});

describe('fits', () => {
  it('needs the add-on plus 1 MB to spare, as the router does', () => {
    expect(fits(ADDONS.tunnel, 26 * 1024)).toBe(true);
    expect(fits(ADDONS.tunnel, 25.9 * 1024)).toBe(false);
    expect(fits(ADDONS.wol, 1.2 * 1024)).toBe(true);
  });

  it('counts the smaller version of an add-on that has one', () => {
    // The speed test falls back to a 2.8 MB tool when space is short.
    expect(fits(ADDONS.speedtest, 4 * 1024)).toBe(true);
    expect(fits(ADDONS.speedtest, 3 * 1024)).toBe(false);
  });

  it('leaves unknown free space to the router', () => {
    expect(fits(ADDONS.tailscale, null)).toBe(true);
  });
});

