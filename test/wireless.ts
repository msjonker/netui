// Synthetic wireless config: two radios, "Home" on both bands, a disabled
// open "Guest", and a client-mode iface that the UI must leave alone. The UCI
// shape matches every other package recorded on the dev container; replace
// with an hwsim recording once one exists.

import type { UciConfig, UciSection } from '../src/api/types';

export function wireless(): UciConfig {
  let index = 0;
  const section = (name: string, type: string, values: Record<string, string | string[]>): UciSection => ({
    '.anonymous': false,
    '.index': index++,
    '.name': name,
    '.type': type,
    ...values,
  });
  return {
    radio0: section('radio0', 'wifi-device', { type: 'mac80211', band: '2g', channel: '6', htmode: 'HT20', country: 'US' }),
    radio1: section('radio1', 'wifi-device', { type: 'mac80211', band: '5g', channel: 'auto', htmode: 'VHT80', txpower: '17' }),
    home2: section('home2', 'wifi-iface', { device: 'radio0', mode: 'ap', ssid: 'Home', network: 'lan', encryption: 'sae-mixed', key: 'hunter22' }),
    home5: section('home5', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'Home', network: ['lan'], encryption: 'sae-mixed', key: 'hunter22' }),
    guest: section('guest', 'wifi-iface', { device: 'radio0', mode: 'ap', ssid: 'Guest', network: 'guest', encryption: 'none', disabled: '1' }),
    sta: section('sta', 'wifi-iface', { device: 'radio1', mode: 'sta', ssid: 'Upstream', network: 'wwan' }),
  };
}
