import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ubus from './ubus';
import { DeviceError, relay } from './devices';

vi.mock('./ubus', async (orig) => ({ ...(await orig<typeof ubus>()), read: vi.fn(), call: vi.fn() }));

const read = vi.mocked(ubus.read);
const call = vi.mocked(ubus.call);
const MAC = '8c:de:f9:b6:f3:24';

beforeEach(() => {
  read.mockReset();
  call.mockReset();
});

describe('relay', () => {
  it('sends reads for one device made together as one batch', async () => {
    read.mockResolvedValue({ results: [{ status: 0, data: { uptime: 5 } }, { status: 0, data: { model: 'Example AP' } }] });
    const [info, board] = await Promise.all([relay(MAC, 'system', 'info'), relay(MAC, 'system', 'board')]);
    expect(info).toEqual({ uptime: 5 });
    expect(board).toEqual({ model: 'Example AP' });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('netui.devices', 'batch', {
      mac: MAC,
      calls: [
        { object: 'system', method: 'info', args: {} },
        { object: 'system', method: 'board', args: {} },
      ],
    });
  });

  it('sends a lone read as a plain call, and each device its own batch', async () => {
    read.mockImplementation(async (_o, method, args) =>
      method === 'call' ? { status: 0, data: (args as { mac: string }).mac } : { results: [] },
    );
    const [a, b] = await Promise.all([relay(MAC, 'system', 'info'), relay('64:70:02:c2:fc:22', 'system', 'info')]);
    expect([a, b]).toEqual([MAC, '64:70:02:c2:fc:22']);
    expect(read.mock.calls.map((c) => c[1])).toEqual(['call', 'call']);
  });

  it('fails each call on its own status, and all of them when the batch fails', async () => {
    read.mockResolvedValueOnce({ results: [{ status: 0, data: 1 }, { status: 4 }] });
    const both = await Promise.allSettled([relay(MAC, 'iwinfo', 'info'), relay(MAC, 'iwinfo', 'assoclist')]);
    expect(both[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(both[1]).toMatchObject({ status: 'rejected', reason: { name: 'UbusError', status: 4 } });

    read.mockResolvedValueOnce({ error: 'unreachable' });
    const failed = await Promise.allSettled([relay(MAC, 'iwinfo', 'info'), relay(MAC, 'iwinfo', 'assoclist')]);
    expect(failed.map((r) => r.status === 'rejected' && r.reason instanceof DeviceError)).toEqual([true, true]);
  });

  it('never batches writes', async () => {
    call.mockResolvedValue({ status: 0 });
    await Promise.all([relay(MAC, 'uci', 'set', { config: 'wireless' }, true), relay(MAC, 'uci', 'apply', {}, true)]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
  });
});
