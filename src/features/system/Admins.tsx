import { useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { addUser, removeUser, setPassword, setRole, useUsers, usersKey } from '../../api/users';
import { getSession } from '../../api/ubus';
import type { NetuiRole } from '../../api/types';
import { Modal } from '../../components/overlay';
import { Banner, Button, Card, Field, Pill } from '../../components/ui';

const ROLE_LABEL: Record<NetuiRole, string> = { admin: 'Admin', viewer: 'Read only' };
const USERNAME = /^[a-z][a-z0-9_]{0,31}$/;

type Editing = { kind: 'add' } | { kind: 'password'; username: string } | { kind: 'remove'; username: string };

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Who can sign in to netui. Admins change settings; read-only users see
 * everything netui shows but change nothing and cannot download backups.
 * Each user is an rpcd login, like the one netui-passwd creates.
 */
export function AdminsCard() {
  const qc = useQueryClient();
  const me = getSession()?.username;
  const users = useUsers(!getSession()?.readOnly);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState({ username: '', password: '', confirm: '', role: 'viewer' as NetuiRole });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read-only users, and routers without the plugin, do not get this card.
  if (!users.data) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await qc.invalidateQueries({ queryKey: usersKey });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (e: Editing) => {
    setForm({ username: '', password: '', confirm: '', role: 'viewer' });
    setError(null);
    setEditing(e);
  };
  const pwError =
    form.password && form.password.length < 8 ? 'At least 8 characters.' : form.confirm && form.confirm !== form.password ? 'The passwords differ.' : undefined;
  const nameError = form.username && !USERNAME.test(form.username) ? 'Lowercase letters, digits and _, starting with a letter.' : undefined;
  const pwOk = form.password.length >= 8 && form.confirm === form.password;

  return (
    <Card
      title="Admins"
      actions={
        <Button onClick={() => open({ kind: 'add' })}>
          Add user
        </Button>
      }
    >
      <ul class="divide-y divide-line" aria-label="Users">
        {users.data.map((u) => {
          const self = u.username === me;
          return (
            <li key={u.username} class="flex flex-wrap items-center gap-3 py-2">
              <span class="min-w-0 flex-1 truncate">
                {u.username} {self && <Pill>You</Pill>}
              </span>
              <select
                class="input w-36"
                aria-label={`Role of ${u.username}`}
                value={u.role}
                disabled={self || busy}
                title={self ? 'You cannot change your own role.' : undefined}
                onChange={(e) => void run(() => setRole(u.username, e.currentTarget.value as NetuiRole))}
              >
                <option value="admin">{ROLE_LABEL.admin}</option>
                <option value="viewer">{ROLE_LABEL.viewer}</option>
              </select>
              <Button onClick={() => open({ kind: 'password', username: u.username })}>Password</Button>
              <Button variant="danger" disabled={self} onClick={() => open({ kind: 'remove', username: u.username })}>
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
      {error && !editing && (
        <Banner tone="bad" role="alert">
          {error}
        </Banner>
      )}

      {editing && (
        <Modal
          title={editing.kind === 'add' ? 'Add user' : editing.kind === 'password' ? `New password for ${editing.username}` : `Remove ${editing.username}?`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              {editing.kind === 'add' && (
                <Button
                  variant="primary"
                  disabled={busy || !USERNAME.test(form.username) || !pwOk}
                  onClick={() => void run(() => addUser(form.username, form.password, form.role))}
                >
                  Add
                </Button>
              )}
              {editing.kind === 'password' && (
                <Button variant="primary" disabled={busy || !pwOk} onClick={() => void run(() => setPassword(editing.username, form.password))}>
                  Change password
                </Button>
              )}
              {editing.kind === 'remove' && (
                <Button variant="danger" disabled={busy} onClick={() => void run(() => removeUser(editing.username))}>
                  Remove
                </Button>
              )}
            </>
          }
        >
          {editing.kind === 'remove' ? (
            <p class="text-muted">They can no longer sign in to netui, and are signed out now.</p>
          ) : (
            <div>
              {editing.kind === 'add' && (
                <>
                  <Field label="Username" stacked error={nameError}>
                    {(id) => (
                      <input id={id} class="input" autoComplete="off" value={form.username} onInput={(e) => setForm({ ...form, username: e.currentTarget.value.trim() })} />
                    )}
                  </Field>
                  <Field label="Role" stacked hint={form.role === 'viewer' ? 'Sees everything, changes nothing, cannot download backups.' : 'Can change every setting netui offers.'}>
                    {(id) => (
                      <select id={id} class="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.currentTarget.value as NetuiRole })}>
                        <option value="viewer">{ROLE_LABEL.viewer}</option>
                        <option value="admin">{ROLE_LABEL.admin}</option>
                      </select>
                    )}
                  </Field>
                </>
              )}
              <Field label="Password" stacked error={pwError && form.password.length < 8 ? pwError : undefined}>
                {(id) => <input id={id} type="password" class="input" autoComplete="new-password" value={form.password} onInput={(e) => setForm({ ...form, password: e.currentTarget.value })} />}
              </Field>
              <Field label="Repeat password" stacked error={form.password.length >= 8 ? pwError : undefined}>
                {(id) => <input id={id} type="password" class="input" autoComplete="new-password" value={form.confirm} onInput={(e) => setForm({ ...form, confirm: e.currentTarget.value })} />}
              </Field>
            </div>
          )}
          {error && (
            <p class="mt-2 text-xs text-bad" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </Card>
  );
}
