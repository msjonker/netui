import type { WanExposure } from '../model/internet';
import { Banner } from './ui';

/** Explains why nothing at home is reachable from the internet, when that is the case. */
export function NatNotice({ exposure }: { exposure: WanExposure }) {
  if (!exposure || exposure.scope === 'public') return null;
  const at = <span class="font-mono text-xs">{exposure.address}</span>;
  return (
    <Banner tone="warn" role="status">
      {exposure.scope === 'cgnat' ? (
        <>
          Your provider shares one public address between several customers (carrier-grade NAT; this router's internet
          address is {at}). Port forwards and the VPN server cannot be reached from the internet. Ask your provider for
          a public IPv4 address, or use Tailscale for remote access and Cloudflare Tunnel to publish a website or app
          (Settings → VPN).
        </>
      ) : (
        <>
          This router is behind another router: its internet address, {at}, is a private one. Port forwards and the VPN
          server only work from the internet if that router passes the traffic on: put it in bridge mode, or forward the
          same ports to {at}.
        </>
      )}
    </Banner>
  );
}
