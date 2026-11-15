import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { useUci } from '../../api/queries';
import { useRootPassword } from '../../api/users';
import { getSession } from '../../api/ubus';
import { isFreshWifi } from '../../model/setup';
import { Banner, Button } from '../../components/ui';

const DISMISSED = 'netui.setup.dismissed';

/** A fresh router: offer the setup. A router without a root password: say so. */
export function SetupBanner() {
  const admin = !getSession()?.readOnly;
  const wireless = useUci('wireless');
  const root = useRootPassword(admin);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED) ?? '');
  if (!admin || !wireless.data) return null;
  const kind = isFreshWifi(wireless.data) ? 'setup' : root.data === false ? 'password' : null;
  if (!kind || dismissed === kind) return null;
  const dismiss = () => {
    localStorage.setItem(DISMISSED, kind);
    setDismissed(kind);
  };
  return (
    <div class="lg:col-span-3">
      <Banner
        tone={kind === 'setup' ? 'accent' : 'warn'}
        role="status"
        actions={
          <>
            <Button onClick={dismiss}>Not Now</Button>
            <Link
              href={kind === 'setup' ? '/setup' : '/settings/system'}
              class="inline-flex h-8 items-center rounded-md border border-transparent bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              {kind === 'setup' ? 'Set Up' : 'Set a Password'}
            </Link>
          </>
        }
      >
        {kind === 'setup'
          ? 'Your router is not set up yet: its WiFi is off. Turn it on with a name and password, and check the internet connection and time zone.'
          : 'The router has no password: anyone on your network can sign in to it with ssh.'}
      </Banner>
    </div>
  );
}
