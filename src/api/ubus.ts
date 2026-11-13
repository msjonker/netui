// JSON-RPC transport to rpcd via uhttpd's /ubus endpoint.
//
// Every call is `[session_id, object, method, args]` and comes back as
// `[status, data?]`. A non-zero status throws a typed UbusError; callers never
// see undefined data from a failed call.

export const ENDPOINT = '/ubus';
export const NULL_SESSION = '00000000000000000000000000000000';
const STORAGE_KEY = 'netui.session';
const DEFAULT_TIMEOUT_MS = 15_000;

// UBUS_STATUS_* from libubus.h.
export const UbusStatus = {
  OK: 0,
  INVALID_COMMAND: 1,
  INVALID_ARGUMENT: 2,
  METHOD_NOT_FOUND: 3,
  NOT_FOUND: 4,
  NO_DATA: 5,
  PERMISSION_DENIED: 6,
  TIMEOUT: 7,
  NOT_SUPPORTED: 8,
  UNKNOWN_ERROR: 9,
  CONNECTION_FAILED: 10,
} as const;

const STATUS_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(UbusStatus).map(([name, code]) => [code, name]),
);

// uhttpd-mod-ubus answers -32002 when the session id is unknown, expired, or
// the ACL denies the object outright.
const RPC_ACCESS_DENIED = -32002;

/** ubus returned a non-zero status in the result tuple. */
export class UbusError extends Error {
  readonly status: number;
  readonly object: string;
  readonly method: string;

  constructor(status: number, object: string, method: string) {
    super(`${object}.${method}: ${STATUS_NAMES[status] ?? `status ${status}`}`);
    this.name = 'UbusError';
    this.status = status;
    this.object = object;
    this.method = method;
  }
}

/** uhttpd rejected the request at the JSON-RPC layer (no result tuple). */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`JSON-RPC ${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** The router could not be reached, or answered with something other than JSON-RPC. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** The session was dropped. The UI must route to login; do not retry. */
export class SessionExpiredError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Session expired', options);
    this.name = 'SessionExpiredError';
  }
}

/** session.login rejected the credentials. */
export class LoginError extends Error {
  constructor(message = 'Invalid username or password') {
    super(message);
    this.name = 'LoginError';
  }
}

// ---------------------------------------------------------------------------
// Session

export interface Session {
  id: string;
  username: string;
  /** rpcd's idle timeout. Each successful call pushes expiresAt forward by this. */
  timeoutMs: number;
  expiresAt: number;
}

/** Receives an optional explanation to show on the login screen. */
type ExpiredListener = (notice?: string) => void;
const expiredListeners = new Set<ExpiredListener>();

export function saveSession(s: Session): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function getSession(): Session | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (typeof s.id !== 'string' || typeof s.expiresAt !== 'number') return null;
    if (s.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** Drop the local session without notifying listeners (user-initiated logout). */
export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Subscribe to forced session loss (status 6, -32002, or local expiry). */
export function onSessionExpired(listener: ExpiredListener): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}

/** Drop the session and route to login, optionally explaining why. */
export function expireSession(notice?: string): void {
  clearSession();
  for (const l of expiredListeners) l(notice);
}

function sessionLost(cause: unknown, defer: boolean): SessionExpiredError {
  if (!defer) expireSession();
  return new SessionExpiredError({ cause });
}

function touchSession(s: Session): void {
  saveSession({ ...s, expiresAt: Date.now() + s.timeoutMs });
}

// ---------------------------------------------------------------------------
// Wire format

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: 'call';
  params: [string, string, string, object];
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: [number, unknown?];
  error?: { code: number; message: string };
}

let nextId = 1;

function makeRequest(sid: string, object: string, method: string, args: object): RpcRequest {
  return { jsonrpc: '2.0', id: nextId++, method: 'call', params: [sid, object, method, args] };
}

async function post(body: RpcRequest | RpcRequest[], timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TransportError('Router unreachable', { cause: err });
  }
  if (!res.ok) throw new TransportError(`HTTP ${res.status} from ${ENDPOINT}`);
  try {
    return await res.json();
  } catch (err) {
    throw new TransportError('Malformed JSON-RPC response', { cause: err });
  }
}

/** Decode one response into data, or the error it represents. Auth failures are flagged, not thrown. */
function decode(
  res: RpcResponse | undefined,
  object: string,
  method: string,
): { ok: true; data: unknown } | { ok: false; error: Error; auth: boolean } {
  if (!res) return { ok: false, error: new TransportError(`No response for ${object}.${method}`), auth: false };
  if (res.error) {
    const error = new RpcError(res.error.code, res.error.message);
    return { ok: false, error, auth: res.error.code === RPC_ACCESS_DENIED };
  }
  if (!Array.isArray(res.result) || typeof res.result[0] !== 'number') {
    return { ok: false, error: new TransportError(`Malformed result for ${object}.${method}`), auth: false };
  }
  const [status, data] = res.result;
  if (status !== UbusStatus.OK) {
    const error = new UbusError(status, object, method);
    return { ok: false, error, auth: status === UbusStatus.PERMISSION_DENIED };
  }
  return { ok: true, data };
}

function requireSession(defer = false): Session {
  const s = getSession();
  if (!s) throw sessionLost(undefined, defer);
  return s;
}

// ---------------------------------------------------------------------------
// Public API

export interface CallOptions {
  timeoutMs?: number;
  /**
   * Treat ubus status 6 as a lost session (the default). rpcd also answers 6
   * for `uci apply` while another rollback is pending and for `uci confirm`
   * from a different session, so the apply flow turns this off. A genuinely
   * invalid session is still caught: uhttpd rejects it with -32002 first.
   */
  permissionDeniedIsAuth?: boolean;
  /**
   * Throw SessionExpiredError without clearing the session or notifying
   * listeners, so the caller can call expireSession() with an explanation.
   */
  deferExpiry?: boolean;
}

/** A single ubus call. `T` is a phantom type carried through to `batch()`. */
export interface Call<T = unknown> {
  object: string;
  method: string;
  args?: object;
  /** Type marker only; never set. */
  readonly __result?: T;
}

export function req<T>(object: string, method: string, args: object = {}): Call<T> {
  return { object, method, args };
}

export async function call<T>(
  object: string,
  method: string,
  args: object = {},
  opts: CallOptions = {},
): Promise<T> {
  const s = requireSession(opts.deferExpiry);
  const raw = await post(makeRequest(s.id, object, method, args), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) {
    throw new TransportError(`Malformed response for ${object}.${method}`);
  }
  const r = decode(raw as RpcResponse, object, method);
  if (!r.ok) {
    const auth =
      r.auth && (opts.permissionDeniedIsAuth !== false || !(r.error instanceof UbusError));
    if (auth) throw sessionLost(r.error, opts.deferExpiry ?? false);
    throw r.error;
  }
  touchSession(s);
  return r.data as T;
}

export type Settled<T> = { ok: true; data: T } | { ok: false; error: Error };

type BatchResults<C extends readonly Call[]> = {
  [K in keyof C]: Settled<C[K] extends Call<infer T> ? T : never>;
};

/**
 * Send independent calls as one JSON-RPC array request. Each result settles
 * independently so one missing object does not blank a whole page, but any
 * auth failure drops the session and rejects the entire batch.
 */
export async function batch<const C extends readonly Call[]>(
  calls: C,
  opts: CallOptions = {},
): Promise<BatchResults<C>> {
  if (calls.length === 0) return [] as unknown as BatchResults<C>;
  const s = requireSession();
  const requests = calls.map((c) => makeRequest(s.id, c.object, c.method, c.args ?? {}));
  const raw = await post(requests, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Array.isArray(raw)) throw new TransportError('Malformed batch response');

  // Responses may arrive in any order; match on id.
  const byId = new Map<number, RpcResponse>();
  for (const r of raw as RpcResponse[]) byId.set(r.id, r);

  const out: Settled<unknown>[] = [];
  for (const [i, c] of calls.entries()) {
    const r = decode(byId.get(requests[i]!.id), c.object, c.method);
    if (!r.ok && r.auth) throw sessionLost(r.error, false);
    out.push(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
  }
  touchSession(s);
  return out as BatchResults<C>;
}

// ---------------------------------------------------------------------------
// Read coalescing

interface Pending {
  call: Call;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
let queue: Pending[] = [];

/**
 * Like call(), but every read() issued in the same tick goes out as one
 * batch request. Query hooks use this so a page's initial reads share a
 * single round trip without the hooks knowing about each other.
 */
export function read<T>(object: string, method: string, args: object = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (queue.length === 0) queueMicrotask(flush);
    queue.push({ call: { object, method, args }, resolve: resolve as (v: unknown) => void, reject });
  });
}

async function flush(): Promise<void> {
  const pending = queue;
  queue = [];
  if (pending.length === 1) {
    const [p] = pending as [Pending];
    call(p.call.object, p.call.method, p.call.args).then(p.resolve, p.reject);
    return;
  }
  try {
    const results = await batch(pending.map((p) => p.call));
    results.forEach((r, i) => (r.ok ? pending[i]!.resolve(r.data) : pending[i]!.reject(r.error)));
  } catch (err) {
    for (const p of pending) p.reject(err);
  }
}

export async function login(username: string, password: string): Promise<Session> {
  const raw = await post(
    makeRequest(NULL_SESSION, 'session', 'login', { username, password }),
    DEFAULT_TIMEOUT_MS,
  );
  const r = decode(raw as RpcResponse, 'session', 'login');
  if (!r.ok) {
    if (r.auth) throw new LoginError();
    throw r.error;
  }

  // Validate only the fields we rely on rather than trusting a static type.
  const data = r.data as Record<string, unknown> | undefined;
  const id = data?.ubus_rpc_session;
  const timeout = data?.timeout;
  const expires = data?.expires;
  if (typeof id !== 'string' || typeof timeout !== 'number') {
    throw new TransportError('session.login response missing ubus_rpc_session/timeout');
  }
  const timeoutMs = timeout * 1000;
  const session: Session = {
    id,
    username,
    timeoutMs,
    expiresAt: Date.now() + (typeof expires === 'number' ? expires * 1000 : timeoutMs),
  };
  saveSession(session);
  return session;
}
