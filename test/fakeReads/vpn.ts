// luci.wireguard for the fake router.
//
// generateKeyPair / generatePsk answer in the recorded shape (the recordings
// hold fake keys) but with a fresh fake key per call, so tests can tell the
// server's, each client's private and preshared keys apart.
//
// getWgInstances is derived from the applied network config: every enabled
// proto-wireguard interface is "running", its peers have never handshaked.
// Tests put a connected peer in with `router.overrides`, see
// SYNTHETIC_WG_INSTANCES.

import type { FakeReadHandler } from '../fakeRouter';
import type { UciSection, WgInstances, WgKeyPair, WgPsk } from '../../src/api/types';
import keyPairRecording from '../fixtures/ubus/dl-wrx36/plain/luci.wireguard.generateKeyPair.json';
import pskRecording from '../fixtures/ubus/dl-wrx36/plain/luci.wireguard.generatePsk.json';
import emptyRecording from '../fixtures/ubus/dl-wrx36/plain/luci.wireguard.getWgInstances.json';

// Typed assignments: tsc fails here if a recording stops matching its type.
export const recorded: { keyPair: WgKeyPair; psk: WgPsk; instances: WgInstances } = {
  keyPair: keyPairRecording,
  psk: pskRecording,
  instances: emptyRecording,
};

/** 32 bytes of `tag` (NUL padded) in base64: 44 characters, like a real key. */
export function fakeKey(tag: string): string {
  return btoa((tag + '\0'.repeat(32)).slice(0, 32));
}

/** The fake "wg pubkey". */
export const pubOf = (priv: string) => fakeKey(`PUB:${priv.slice(0, 24)}`);

let counter = 0;

/**
 * SYNTHETIC, not a recording: the router had no WireGuard instance when the
 * fixtures were taken ({} above). Shaped after the ucode in
 * /usr/share/rpcd/ucode/luci.wireguard (every field a string, as split from
 * `wg show all dump`). Replace with a real recording once a server exists.
 */
export const SYNTHETIC_WG_INSTANCES: WgInstances = {
  wg0: {
    name: 'wg0',
    public_key: fakeKey('SYNTHETIC-SERVER-PUBLIC'),
    listen_port: '51820',
    fwmark: 'off',
    peers: [
      {
        name: 'Phone',
        public_key: fakeKey('SYNTHETIC-PHONE-PUBLIC'),
        endpoint: '203.0.113.7:53211',
        allowed_ips: ['10.6.0.2/32'],
        latest_handshake: '1700000000',
        transfer_rx: '1048576',
        transfer_tx: '5242880',
        persistent_keepalive: 'off',
      },
      {
        name: 'Laptop',
        public_key: fakeKey('SYNTHETIC-LAPTOP-PUBLIC'),
        endpoint: '(none)',
        allowed_ips: [],
        latest_handshake: '0',
        transfer_rx: '0',
        transfer_tx: '0',
        persistent_keepalive: 'off',
      },
    ],
  },
};

export const handle: FakeReadHandler = (object, method, _args, router) => {
  if (object !== 'luci.wireguard') return undefined;
  switch (method) {
    case 'generateKeyPair': {
      const priv = fakeKey(`PRIVATE-${++counter}-netui-test`);
      return { keys: { ...recorded.keyPair.keys, priv, pub: pubOf(priv) } } satisfies WgKeyPair;
    }
    case 'generatePsk':
      return { psk: fakeKey(`PSK-${++counter}-netui-test`) } satisfies WgPsk;
    case 'getWgInstances': {
      const net = router.configs.network ?? {};
      const out: WgInstances = {};
      const sections: UciSection[] = Object.values(net);
      for (const s of sections) {
        if (s['.type'] !== 'interface' || s.proto !== 'wireguard' || s.disabled === '1') continue;
        const name = s['.name'];
        out[name] = {
          name,
          public_key: typeof s.private_key === 'string' ? pubOf(s.private_key) : '(none)',
          listen_port: typeof s.listen_port === 'string' ? s.listen_port : '0',
          fwmark: 'off',
          peers: sections
            .filter((p) => p['.type'] === `wireguard_${name}` && p.disabled !== '1')
            .map((p) => ({
              name: typeof p.description === 'string' ? p.description : null,
              public_key: String(p.public_key),
              endpoint: '(none)',
              allowed_ips: [],
              latest_handshake: '0',
              transfer_rx: '0',
              transfer_tx: '0',
              persistent_keepalive: 'off',
            })),
        };
      }
      // Like rpcd over HTTP: an empty object comes back as a bare [0], no data.
      return Object.keys(out).length ? out : null;
    }
  }
  return undefined;
};
