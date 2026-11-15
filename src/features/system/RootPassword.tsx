import { useState } from 'preact/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { rootKey, setRootPassword, useRootPassword } from '../../api/users';
import { getSession } from '../../api/ubus';
import { validateRootPassword } from '../../model/setup';
import { Modal } from '../../components/overlay';
import { Banner, Button, Card, Field } from '../../components/ui';

/** root's password: what ssh and LuCI ask for. netui's own sign-in is separate. */
export function RootPasswordCard() {
  const qc = useQueryClient();
  const set = useRootPassword(!getSession()?.readOnly);
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState({ a: '', b: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (set.data === undefined) return null;
  const invalid = validateRootPassword(pw.a, pw.b);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await setRootPassword(pw.a);
      setOpen(false);
      await qc.invalidateQueries({ queryKey: rootKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Router password">
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <div>For ssh and LuCI</div>
          <div class={set.data ? 'text-xs text-muted' : 'text-xs text-warn'}>
            {set.data
              ? 'Set. netui keeps its own sign-in.'
              : 'Not set: anyone on your network can sign in to the router with ssh.'}
          </div>
        </div>
        <Button
          variant={set.data ? 'secondary' : 'primary'}
          onClick={() => {
            setPw({ a: '', b: '' });
            setError(undefined);
            setOpen(true);
          }}
        >
          {set.data ? 'Change' : 'Set Password'}
        </Button>
      </div>
      {open && (
        <Modal
          title="Router password"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" disabled={busy || !!invalid} onClick={() => void save()}>
                Save
              </Button>
            </>
          }
        >
          <div class="space-y-3">
            <Field label="New password" stacked>
              {(id) => (
                <input
                  id={id}
                  class="input"
                  type="password"
                  autocomplete="new-password"
                  value={pw.a}
                  onInput={(e) => setPw({ ...pw, a: e.currentTarget.value })}
                />
              )}
            </Field>
            <Field label="Again" stacked error={pw.b ? invalid : undefined}>
              {(id) => (
                <input
                  id={id}
                  class="input"
                  type="password"
                  autocomplete="new-password"
                  value={pw.b}
                  onInput={(e) => setPw({ ...pw, b: e.currentTarget.value })}
                />
              )}
            </Field>
            {error && (
              <Banner tone="bad" role="alert">
                {error}
              </Banner>
            )}
          </div>
        </Modal>
      )}
    </Card>
  );
}
