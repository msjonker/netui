// netui.users for component tests: rpcd logins with netui's groups, in
// memory. Starts with the netui admin the fake session signs in as.

import type { FakeReadHandler, FakeRouter } from '../fakeRouter';
import type { NetuiUser } from '../../src/api/types';

const states = new WeakMap<FakeRouter, NetuiUser[]>();
const usersOf = (r: FakeRouter) => {
  let u = states.get(r);
  if (!u) states.set(r, (u = [{ username: 'netui', role: 'admin' }]));
  return u;
};

export function seedUsers(r: FakeRouter, users: NetuiUser[]): void {
  states.set(r, structuredClone(users));
}

export const handle: FakeReadHandler = (object, method, args, router) => {
  if (object !== 'netui.users') return undefined;
  const users = usersOf(router);
  const u = users.find((x) => x.username === args.username);
  const admins = users.filter((x) => x.role === 'admin').length;
  switch (method) {
    case 'list':
      return { users: structuredClone(users) };
    case 'add':
      if (u) return { error: `${String(args.username)} is already a login on this router.` };
      users.push({ username: args.username as string, role: args.role as NetuiUser['role'] });
      return { result: true };
    case 'remove':
      if (!u) return { error: 'no such netui user' };
      if (u.role === 'admin' && admins < 2) return { error: 'Keep at least one admin.' };
      states.set(router, users.filter((x) => x !== u));
      return { result: true };
    case 'password':
      return u ? { result: true } : { error: 'no such netui user' };
    case 'role':
      if (!u) return { error: 'no such netui user' };
      if (u.role === 'admin' && args.role !== 'admin' && admins < 2) return { error: 'Keep at least one admin.' };
      u.role = args.role as NetuiUser['role'];
      return { result: true };
  }
  return undefined;
};
