import { useState } from 'preact/hooks';
import { usePackages } from '../api/packages';
import { useUci } from '../api/queries';
import { getSession } from '../api/ubus';
import { httpsState, secureUrl } from '../model/https';

const DISMISSED = 'netui.insecure-dismissed';

/**
 * Over plain HTTP, the session id that stands for the admin's login crosses
 * the network unencrypted. Where the router serves HTTPS, say so and link
 * there. Admins only (viewers cannot read uhttpd's config); dismissed for
 * the rest of the browser session.
 */
export function InsecureBanner() {
  const plain = typeof location !== 'undefined' && location.protocol === 'http:';
  const admin = !getSession()?.readOnly;
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(DISMISSED) === '1');
  const show = plain && admin && !hidden;
  const uhttpd = useUci('uhttpd', show);
  const packages = usePackages(undefined, show);
  const https = httpsState(uhttpd.data);
  if (!show || !https?.configured || packages.data?.addons.https?.installed === false) return null;
  return (
    <div role="status" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-warn-soft px-5 py-1.5 text-xs">
      <span class="min-w-0 flex-1">
        This connection is not encrypted: someone on your network could take over your sign-in.{' '}
        <a class="font-medium text-accent underline" href={secureUrl(location, https.port)}>
          Open netui over HTTPS
        </a>{' '}
        (the first time, your browser asks you to accept the router's own certificate).
      </span>
      <button
        type="button"
        class="text-muted hover:underline"
        onClick={() => {
          sessionStorage.setItem(DISMISSED, '1');
          setHidden(true);
        }}
      >
        Not now
      </button>
    </div>
  );
}
