// netui.users: who can sign in to netui, as admin or read-only viewer. The
// plugin only manages logins with netui's ACL groups and always keeps one
// admin; the UI also keeps people from removing or demoting themselves.

import { useQuery } from '@tanstack/react-query';
import { call, read } from './ubus';
import { DeviceError } from './devices';
import type { NetuiRole, NetuiUser } from './types';

export const usersKey = ['netui.users', 'list'] as const;

async function write(method: string, args: object): Promise<void> {
  const r = await call<{ error?: string }>('netui.users', method, args);
  if (r?.error) throw new DeviceError(r.error);
}

/** Viewers may not list users: the query errors and the card stays hidden. */
export const useUsers = (enabled = true) =>
  useQuery({
    queryKey: usersKey,
    enabled,
    retry: false,
    queryFn: async () => (await read<{ users: NetuiUser[] }>('netui.users', 'list')).users,
  });

export const addUser = (username: string, password: string, role: NetuiRole) => write('add', { username, password, role });
export const removeUser = (username: string) => write('remove', { username });
export const setPassword = (username: string, password: string) => write('password', { username, password });
export const setRole = (username: string, role: NetuiRole) => write('role', { username, role });

export const rootKey = ['netui.users', 'root'] as const;

/** Whether root (ssh, LuCI) has a password. Admins only; never the hash. */
export const useRootPassword = (enabled = true) =>
  useQuery({
    queryKey: rootKey,
    enabled,
    retry: false,
    queryFn: async () => (await read<{ password_set: boolean }>('netui.users', 'root')).password_set,
  });

export const setRootPassword = (password: string) => write('root_password', { password });
