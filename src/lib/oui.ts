import { isLocallyAdministered, normalizeMac } from './mac';

// MAC vendor lookup from a deliberately small OUI table (bundle budget).
//
// Source: the IEEE MA-L registry (oui.csv). Kept: home/consumer vendors only,
// with a per-vendor cap; for capped vendors, assignments outside 00:xx:xx
// (the pre-2008 blocks) are preferred and sampled evenly. Big vendors (Apple,
// Samsung, Intel) are therefore only partly covered; client names fill the
// gap in model/clients.ts. Phones mostly use private addresses anyway.
//
// Format: "Vendor[/kind]:<deltas>|...". Each vendor's OUIs, as 24-bit ints in
// ascending order, are stored as deltas from the previous one in base 32,
// most significant digit first: digits 0-9a-v continue, the final digit is
// taken from FINAL. Kind letters are in KIND below.

export type DeviceKind = 'phone' | 'computer' | 'tv' | 'console' | 'speaker' | 'iot' | 'camera' | 'printer' | 'network' | 'nas';

const KIND: Record<string, DeviceKind> = {
  p: 'phone',
  c: 'computer',
  t: 'tv',
  g: 'console',
  s: 'speaker',
  i: 'iot',
  v: 'camera',
  r: 'printer',
  n: 'network',
  d: 'nas',
};

const FINAL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&*';

// prettier-ignore
const TABLE =
  'Apple:836O9md#fjn*eqlK9hfZfv7Jek2Ng3oBfr4%fk8RglkNftvTg8cH8qdQfglJfegRfb0K9g8WfgbF8hkBflmUg0s&f5fKfnoO8hnZfqfIffcR9hlPme6O9drQg7fKfpdQgdv*fjtYeoe#|Samsung/t:860P18gtE1ni0H1orn*1fqlS1n3eC1gbf#1gdp$18j8F1nfsQ|Google/i:h2uIodcGobqGfj7V16qnEpbjI1f6cX1oq7Q1er0E10ceT1815B18avNnp5Y10i5So85N|Amazon/i:g4lF8d9Eob3FvvuI1gg6XfgsR10r1K17d8VnknH101bB1f47X11j7P1f73S1vo0Nh1lH|Intel/c:8cuCpgiI1fmnA10atO16j6U10v3Io9nR16s1Tvu2S119s&ungUvu9T119dV178qN1008Z|Realtek/c:1o2M|Microsoft/c:89pI2gbbJ2ftvZ2gt1A2nisU2893V|Sony/t:8naL3f95E2ot3A482d#|PlayStation/g:9trY2f9kI4801J2n6dC2o4mV28afM|Nintendo/g:80uW31aqW2808S1f65Z1o3eO1fogH1gpfP1vihQ|LG/t:86rN2g44M1fuqM1pf3H1g56W2eloD198iV1v6qM|Xiaomi/p:843L1osiV2fafA1otbA1gmrL1vfsF2mqqC1o77H|Huawei/p:80g*3ot4K3vumR40s2E|OnePlus/p:2p9vP5vf5T|TP-Link/n:9ufY1eihB1hcn%1nk5J173iC18ioF1v9pB1gjaO1nkqB1ob2A|Netgear/n:98aR1oguZ1uu2Y3vmfR1vqiE27oi&|ASUS/n:8gg!oe9K10kvM1g1gX1nioJ2712*3gigQ2vk4K|D-Link/n:9emW3eu2$58miG386lF|Linksys/n:h1h#4vpqU3n8lP30c7A|eero/n:h6vR2f7iZ38n6K1fhsE313fN2e6aZ|AVM/n:9d7&2fn5N1nisK2npaK5h2s*uqqR|Synology/d:49S8vu4&|QNAP/d:28nl&c7p7Y|Raspberry Pi/c:2hjeB80dG8mm4E204nS8qqVfe6P|Espressif/i:gekN8k8If7s!108b$140YnkfB7pdQfnbL90rBfsgJmsr%10n3Cmj8Voa2K8k6Tnje!8j6BgdeXfe1XevaHgvi!grkFmqtV8rfFngaZ8c9$f7fDg3mM8avE8o7S|Tuya/i:10mgXodnI3060!30jaN3m3tH2068F|Sonos/s:38vi$7gtP1nq0Qh07C1mveNg8hI3h7iFmjp&|Roku/t:g1cB4g0bU3ogjN20p5Xnsq$1fatX|Philips Hue/i:5sIc84gO2h33E|Ring/v:1gvsI1nfo$218bVepqFgkoF2nbgJobdH|ecobee/i:48o9S|Wyze/v:2pakO4vjhE7jr!4vtn#|Hikvision/v:80oS4pohG57s4K|Dahua/v:hrfN902u*|Reolink/v:eose#|Dell/c:9fo#1vchX3868I36ujA2p06K206bP|HP/c:83h$2gitJ2830O310hZ2nulH27n6J|Lenovo/c:11hcV3utpP20daJ1n91Y1fuqP3045L|Foxconn/c:8q3U2n6qU2oneR2fjn$28toA2vdiN|AzureWave/c:haa!1f9c$1g07!1g2jV202vQ10quI37ekA2fuaB|Liteon/c:10ouI1vb7L2fs1Q1pnaI3g0fF27vsK|Murata/i:8hjF40in#4fctA47uvP|Fugui/c:1ghp%2g54#1onoX1eluE3hglR1nfk&|USI/c:8uuL3gpeW4umdJ|Wistron/c:h57P500cC40m2!|Compal/c:h3uD4nlsO5felU|Pegatron/c:ol5F6p7fZ|Quanta/c:8vb#70lrC|Canon/r:1g35M48ldO1gnbG6g0oJ|Epson/r:3g6iS2pb4A4043K3ftfT|Brother/r:301a$o9cY5hcoE1uh0I|Valve/g:e0cc&|Nvidia/t:12L3oq8#ogmH|Bose/s:8kmH27fm&3h6hN4o4s*|Logitech/i:h0dS3flnH57acX|Garmin/i:ovhE2ouuR|Fitbit/i:1g06#48t6U|TCL/t:hgtT381uJ4g1e&46mcX|Hisense/t:gpqO2n8tR5oc8&2o8vT|Vizio/t:p2r%1vm5C781hF27cl#|Panasonic/t:884!71dpQ|Sharp/t:g00*7071#|Philips TV/t:1h3mV5g82P|Texas Instruments/i:88pC40hv%3gtqK47stB|Silicon Labs/i:83cE38jeA48qrS2f9o&|Arris/n:8ji!80r8P|Sagemcom/n:9oo!7vflX|Technicolor/n:gvjE7n6cL|Withings/i:97Ea8mgW|iRobot/i:4pefK6mkP|Tesla/i:oacP4hjrB|Meta/g:2o9gX5gcfA3p1cT|GoPro/v:8gbJcvs7X|Chamberlain/i:59F|Lutron/i:3vH|Zyxel/n:9frN8f6gG|MikroTik/n:gl9R40l2Z2vs4O5mptL';

export interface Vendor {
  name: string;
  kind?: DeviceKind;
}

let index: Map<number, Vendor> | undefined;

function build(): Map<number, Vendor> {
  const m = new Map<number, Vendor>();
  for (const group of TABLE.split('|')) {
    const [head, body = ''] = group.split(':');
    const [name = '', k] = head!.split('/');
    const v: Vendor = { name, kind: k ? KIND[k] : undefined };
    let oui = 0;
    let acc = 0;
    for (const ch of body) {
      const f = FINAL.indexOf(ch);
      if (f < 0) {
        acc = acc * 32 + parseInt(ch, 32);
        continue;
      }
      oui += acc * 32 + f;
      acc = 0;
      m.set(oui, v);
    }
  }
  return m;
}

/** Vendor for a globally unique MAC, if it is in the table. */
export function ouiVendor(mac: string): Vendor | undefined {
  const n = normalizeMac(mac);
  if (!n || isLocallyAdministered(n)) return undefined;
  index ??= build();
  return index.get(parseInt(n.slice(0, 8).replace(/:/g, ''), 16));
}

/** What the Vendor column shows: the maker, "Private address" for a randomized MAC, or nothing. */
export function vendorLabel(mac: string): string | undefined {
  return isLocallyAdministered(mac) ? 'Private address' : ouiVendor(mac)?.name;
}
