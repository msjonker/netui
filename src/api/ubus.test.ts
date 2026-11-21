import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSY_HOLDOFF_MS,
  LoginError,
  NULL_SESSION,
  RpcError,
  SessionExpiredError,
  ReadOnlyError,
  TransportError,
  UbusError,
  batch,
  call,
  getSession,
  login,
  onSessionExpired,
  read,
  req,
  resetBusy,
} from './ubus';
import { createQueryClient } from './queries';

const SID = 'c0ffee00c0ffee00c0ffee00c0ffee00';

type Body = { id: number; params: [string, string, string, object] };

/** Install a fetch mock that answers each JSON-RPC request via `handler`. */
function mockRouter(handler: (params: Body['params']) => unknown) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body | Body[];
    const answer = (r: Body) => {
      const out = handler(r.params);
      return out && typeof out === 'object' && 'error' in out
        ? { jsonrpc: '2.0', id: r.id, ...out }
        : { jsonrpc: '2.0', id: r.id, result: out };
    };
    const payload = Array.isArray(body) ? body.map(answer).reverse() : answer(body);
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function seedSession(expiresInMs = 300_000) {
  sessionStorage.setItem(
    'netui.session',
    JSON.stringify({ id: SID, username: 'netui', timeoutMs: 300_000, expiresAt: Date.now() + expiresInMs }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetBusy();
});

describe('read-only sessions', () => {
  function seedViewer() {
    sessionStorage.setItem(
      'netui.session',
      JSON.stringify({ id: SID, username: 'viewer', timeoutMs: 300_000, expiresAt: Date.now() + 300_000, readOnly: true }),
    );
  }

  it('reports a refused change as read-only while the session lives', async () => {
    seedViewer();
    mockRouter(([, obj]) => (obj === 'session' ? [0, {}] : { error: { code: -32002, message: 'Access denied' } }));
    await expect(call('uci', 'set', {})).rejects.toBeInstanceOf(ReadOnlyError);
    expect(getSession()?.id).toBe(SID);
  });

  it('still notices an expired viewer session', async () => {
    seedViewer();
    mockRouter(() => ({ error: { code: -32002, message: 'Access denied' } }));
    await expect(call('uci', 'set', {})).rejects.toBeInstanceOf(SessionExpiredError);
    expect(getSession()).toBeNull();
  });
});

describe('login', () => {
  it('logs in with the null session and stores the session id', async () => {
    const fetchMock = mockRouter(([sid, obj, method, args]) => {
      if (method === 'access') return [0, { access: true }];
      expect([sid, obj, method]).toEqual([NULL_SESSION, 'session', 'login']);
      expect(args).toEqual({ username: 'netui', password: 'pw' });
      return [0, { ubus_rpc_session: SID, timeout: 300, expires: 299 }];
    });

    const s = await login('netui', 'pw');

    // The login, then whether the session may change config.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(s.id).toBe(SID);
    expect(s.readOnly).toBe(false);
    expect(getSession()?.id).toBe(SID);
    expect(s.expiresAt).toBeGreaterThan(Date.now() + 298_000);
  });

  it('marks a viewer login read-only', async () => {
    mockRouter(([sid, , method, args]) => {
      if (method === 'login') return [0, { ubus_rpc_session: SID, timeout: 300, expires: 299 }];
      expect([sid, args]).toEqual([SID, { scope: 'ubus', object: 'uci', function: 'set' }]);
      return [0, { access: false }];
    });
    expect((await login('viewer', 'pw')).readOnly).toBe(true);
  });

  it('treats a router without session access (older ACL) as an admin', async () => {
    mockRouter(([, , method]) =>
      method === 'login' ? [0, { ubus_rpc_session: SID, timeout: 300 }] : { error: { code: -32002, message: 'Access denied' } },
    );
    expect((await login('netui', 'pw')).readOnly).toBe(false);
  });

  it('throws LoginError on permission denied', async () => {
    mockRouter(() => [6]);
    await expect(login('netui', 'wrong')).rejects.toBeInstanceOf(LoginError);
    expect(getSession()).toBeNull();
  });

  it('rejects a login response without a session id', async () => {
    mockRouter(() => [0, { timeout: 300 }]);
    await expect(login('netui', 'pw')).rejects.toBeInstanceOf(TransportError);
  });
});

describe('call', () => {
  it('sends [sid, object, method, args] and returns data', async () => {
    seedSession();
    mockRouter(([sid, obj, method, args]) => {
      expect([sid, obj, method, args]).toEqual([SID, 'system', 'board', {}]);
      return [0, { hostname: 'router' }];
    });
    await expect(call('system', 'board')).resolves.toEqual({ hostname: 'router' });
  });

  it('surfaces a non-zero status as a typed UbusError', async () => {
    seedSession();
    mockRouter(() => [4]);
    const err = await call('iwinfo', 'info', { device: 'nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UbusError);
    expect(err).toMatchObject({ status: 4, object: 'iwinfo', method: 'info' });
    expect(getSession()).not.toBeNull();
  });

  it('surfaces JSON-RPC errors as RpcError', async () => {
    seedSession();
    mockRouter(() => ({ error: { code: -32000, message: 'Object not found' } }));
    await expect(call('nope', 'x')).rejects.toBeInstanceOf(RpcError);
  });

  it('drops the session and notifies on status 6', async () => {
    seedSession();
    mockRouter(() => [6]);
    const listener = vi.fn();
    const off = onSessionExpired(listener);

    await expect(call('system', 'info')).rejects.toBeInstanceOf(SessionExpiredError);

    expect(listener).toHaveBeenCalledOnce();
    expect(getSession()).toBeNull();
    off();
  });

  it('drops the session on JSON-RPC access denied (-32002)', async () => {
    seedSession();
    mockRouter(() => ({ error: { code: -32002, message: 'Access denied' } }));
    await expect(call('system', 'info')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(getSession()).toBeNull();
  });

  it('does not hit the network when the local session has expired', async () => {
    seedSession(-1);
    const fetchMock = mockRouter(() => [0, {}]);
    const listener = vi.fn();
    const off = onSessionExpired(listener);

    await expect(call('system', 'info')).rejects.toBeInstanceOf(SessionExpiredError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it('slides the expiry forward on success', async () => {
    seedSession(1_000);
    mockRouter(() => [0, {}]);
    await call('system', 'info');
    expect(getSession()!.expiresAt).toBeGreaterThan(Date.now() + 299_000);
  });

  it('keeps the session on status 6 when permissionDeniedIsAuth is false', async () => {
    seedSession();
    mockRouter(() => [6]);
    const err = await call('uci', 'apply', {}, { permissionDeniedIsAuth: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UbusError);
    expect(getSession()).not.toBeNull();
  });

  it('still drops the session on -32002 when permissionDeniedIsAuth is false', async () => {
    seedSession();
    mockRouter(() => ({ error: { code: -32002, message: 'Access denied' } }));
    await expect(call('uci', 'apply', {}, { permissionDeniedIsAuth: false })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(getSession()).toBeNull();
  });

  it('leaves expiry to the caller with deferExpiry', async () => {
    seedSession();
    mockRouter(() => ({ error: { code: -32002, message: 'Access denied' } }));
    const listener = vi.fn();
    const off = onSessionExpired(listener);
    await expect(call('uci', 'confirm', {}, { deferExpiry: true })).rejects.toBeInstanceOf(SessionExpiredError);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('wraps network failures in TransportError', async () => {
    seedSession();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(call('system', 'info')).rejects.toBeInstanceOf(TransportError);
    expect(getSession()).not.toBeNull();
  });

  it('wraps HTTP errors in TransportError', async () => {
    seedSession();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));
    await expect(call('system', 'info')).rejects.toBeInstanceOf(TransportError);
  });
});

describe('batch', () => {
  it('sends one array request and matches results by id, not position', async () => {
    seedSession();
    const fetchMock = mockRouter(([, obj, method]) => [0, { from: `${obj}.${method}` }]);

    const [board, info] = await batch([
      req<{ from: string }>('system', 'board'),
      req<{ from: string }>('system', 'info'),
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(board).toEqual({ ok: true, data: { from: 'system.board' } });
    expect(info).toEqual({ ok: true, data: { from: 'system.info' } });
  });

  it('settles failures per call', async () => {
    seedSession();
    mockRouter(([, obj]) => (obj === 'luci-rpc' ? [4] : [0, { ok: 1 }]));

    const [a, b] = await batch([req('system', 'board'), req('luci-rpc', 'getHostHints')]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toBeInstanceOf(UbusError);
  });

  it('rejects the whole batch and drops the session on any auth failure', async () => {
    seedSession();
    mockRouter(([, obj]) => (obj === 'uci' ? [6] : [0, {}]));
    await expect(batch([req('system', 'board'), req('uci', 'get', { config: 'network' })])).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(getSession()).toBeNull();
  });
});

describe('read', () => {
  it('coalesces reads issued in the same tick into one batch', async () => {
    seedSession();
    const fetchMock = mockRouter(([, obj, method]) => (obj === 'iwinfo' ? [4] : [0, { from: `${obj}.${method}` }]));

    const a = read('system', 'board');
    const b = read('system', 'info');
    const c = read('iwinfo', 'info').catch((e: unknown) => e);

    await expect(a).resolves.toEqual({ from: 'system.board' });
    await expect(b).resolves.toEqual({ from: 'system.info' });
    expect(await c).toBeInstanceOf(UbusError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(Array.isArray(JSON.parse(fetchMock.mock.calls[0]![1].body as string))).toBe(true);
  });

  it('sends a lone read as a plain call', async () => {
    seedSession();
    const fetchMock = mockRouter(() => [0, { x: 1 }]);
    await expect(read('system', 'board')).resolves.toEqual({ x: 1 });
    expect(Array.isArray(JSON.parse(fetchMock.mock.calls[0]![1].body as string))).toBe(false);
  });
});

describe('a router that does not answer in time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** fetch as AbortSignal.timeout ends it. */
  function timingOut() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      }),
    );
  }

  it('reports a timeout, which queries do not retry', async () => {
    seedSession();
    timingOut();
    const err = await call('luci-rpc', 'getHostHints').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).timedOut).toBe(true);
    const retry = createQueryClient().getDefaultOptions().queries!.retry as (n: number, e: Error) => boolean;
    expect(retry(0, err as Error)).toBe(false);
    expect(retry(0, new TransportError('Router unreachable'))).toBe(true);
  });

  it('holds polling reads back, then sends them together', async () => {
    seedSession();
    timingOut();
    await call('luci-rpc', 'getHostHints').catch(() => undefined);

    vi.useFakeTimers();
    const fetchMock = mockRouter(() => [0, {}]);
    const a = read('system', 'info');
    const b = read('network.interface', 'dump');
    await vi.advanceTimersByTimeAsync(BUSY_HOLDOFF_MS - 1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledOnce();
    // A user's action is not held.
    await call('system', 'reboot');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("holds reads back after uhttpd's own timeout too", async () => {
    seedSession();
    mockRouter(() => ({ error: { code: -32003, message: 'ubus request timed out' } }));
    await expect(call('luci-rpc', 'getHostHints')).rejects.toBeInstanceOf(RpcError);

    vi.useFakeTimers();
    const fetchMock = mockRouter(() => [0, {}]);
    const a = read('system', 'info');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BUSY_HOLDOFF_MS);
    await a;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
