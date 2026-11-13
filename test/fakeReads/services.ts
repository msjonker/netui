import type { FakeReadHandler } from '../fakeRouter';

// `file exec` for the post-apply service hooks (api/services.ts). Records the
// call like any other; returns what rpcd does for a clean exit.
export const handle: FakeReadHandler = (object, method) =>
  object === 'file' && method === 'exec' ? { code: 0 } : undefined;
