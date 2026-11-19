import { usePackages } from '../../api/packages';
import { useUci } from '../../api/queries';
import { useApply } from '../../api/useApply';
import { getSession } from '../../api/ubus';
import { httpsState, redirectOps, secureUrl } from '../../model/https';
import { AddonCard } from '../../components/InstallAddon';
import { Button, Card, ToggleRow } from '../../components/ui';

const PLAN = { returnTo: '/settings/system' };

/**
 * Secure access: HTTPS for netui and LuCI. "Always use HTTPS" is offered only
 * on a page already open over HTTPS, so switching it on cannot cut off the
 * connection netui is using. Admins only (uhttpd's config is not a viewer's).
 */
export function HttpsCard() {
  const admin = !getSession()?.readOnly;
  const packages = usePackages(undefined, admin);
  const cfg = useUci('uhttpd', admin);
  const apply = useApply();
  if (!admin) return null;
  const installed = packages.data?.addons.https?.installed;
  if (installed === false) {
    return (
      <AddonCard addon="https" title="Secure access (HTTPS)">
        Lets you open netui and LuCI over an encrypted connection, so nobody on your network can read or take over your
        sign-in.
      </AddonCard>
    );
  }
  const state = httpsState(cfg.data);
  if (!state) return null;
  const secure = location.protocol === 'https:';
  return (
    <Card title="Secure access (HTTPS)">
      {!state.configured ? (
        <p class="text-muted">
          The web server is not set to serve HTTPS. Set a certificate and an HTTPS port in LuCI (Services, uHTTPd).
        </p>
      ) : secure ? (
        <ToggleRow
          label="Always use HTTPS"
          hint="Plain HTTP visits go to the encrypted address instead, for LuCI too. Browsers warn about the router's certificate because the router made it itself; that is normal for a home router."
          checked={state.redirect}
          disabled={apply.busy}
          onChange={(on) => void apply.start(redirectOps(cfg.data!, state, on), PLAN)}
        />
      ) : (
        <div class="flex flex-wrap items-center gap-4">
          <p class="min-w-0 flex-1 text-muted">
            netui is open over plain HTTP. Open it over HTTPS to make that the only way in.
          </p>
          <Button variant="primary" onClick={() => location.assign(secureUrl(location, state.port))}>
            Open over HTTPS
          </Button>
        </div>
      )}
    </Card>
  );
}
