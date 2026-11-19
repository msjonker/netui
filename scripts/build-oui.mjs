// Builds the MAC vendor tables in src/lib from the IEEE MA-L registry.
//
//   curl -o /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
//   node scripts/build-oui.mjs /tmp/oui.csv
//
// Only home and consumer makers are kept (VENDORS below, matched against the
// registry's organization names). Two tables come out:
//   src/lib/ouiFull.ts    every prefix of those makers; a lazy chunk the
//                         Clients page loads (not in the initial load).
//   src/lib/ouiSample.ts  at most SAMPLE_CAP prefixes per maker, in the entry
//                         chunk so the column has something before the full
//                         table arrives. For capped makers, assignments outside
//                         00:xx:xx (the pre-2008 blocks) are preferred, sampled
//                         evenly.
//
// Format: "Vendor[/kind]:<deltas>|...". Each vendor's OUIs, as 24-bit ints in
// ascending order, are stored as deltas from the previous one in base 32, most
// significant digit first: digits 0-9a-v continue, the final digit is taken
// from FINAL. src/lib/oui.ts decodes it; kind letters are its KIND table.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const SAMPLE_CAP = 5;

// [label, kind letter or '', pattern on the registry's organization name].
// First match wins, so narrower makers come before broader ones.
// prettier-ignore
const VENDORS = [
  ['Apple', '', /^Apple, Inc/i],
  ['Samsung', 't', /^Samsung Electro/i],
  ['Google', 'i', /^Google/i],
  ['Nest', 'i', /^Nest Labs/i],
  ['Amazon', 'i', /^(Amazon Technologies|Amazon\.com|Blink by Amazon)/i],
  ['Intel', 'c', /^Intel Corporat/i],
  ['Realtek', 'c', /^Realtek/i],
  ['Microsoft', 'c', /^Microsoft/i],
  ['PlayStation', 'g', /^Sony (Interactive|Computer) Entertainment/i],
  ['Sony', 't', /^Sony\b/i],
  ['Nintendo', 'g', /^Nintendo/i],
  ['LG', 't', /^LG Elec/i],
  ['Xiaomi', 'p', /xiaomi/i],
  ['Huawei', 'p', /^Huawei (Technologies|Device)/i],
  ['Honor', 'p', /^Honor Device/i],
  ['OnePlus', 'p', /^OnePlus/i],
  ['OPPO', 'p', /^(Guangdong OPPO|OPPO Digital)/i],
  ['vivo', 'p', /^vivo Mobile/i],
  ['realme', 'p', /^Realme/i],
  ['Motorola', 'p', /^Motorola (Mobility|\(Wuhan\) Mobility)/i],
  ['TP-Link', 'n', /^TP-Link/i],
  ['Netgear', 'n', /^Netgear/i],
  ['ASUS', 'n', /^(ASUSTek|Asus Network)/i],
  ['D-Link', 'n', /^D-Link/i],
  ['Linksys', 'n', /linksys/i],
  ['eero', 'n', /^eero/i],
  ['AVM', 'n', /^AVM (Audiovisuelles|GmbH)/i],
  ['Zyxel', 'n', /^Zyxel/i],
  ['MikroTik', 'n', /^Routerboard\.com/i],
  ['CommScope', 'n', /^(Commscope|Arris$)/i],
  ['Sagemcom', 'n', /^Sagemcom/i],
  ['Vantiva', 'n', /^(Vantiva|Technicolor)/i],
  ['Synology', 'd', /^Synology/i],
  ['QNAP', 'd', /^QNAP/i],
  ['Raspberry Pi', 'c', /^Raspberry Pi/i],
  ['Espressif', 'i', /^Espressif/i],
  ['Tuya', 'i', /^Tuya/i],
  ['Shelly', 'i', /^Shelly/i],
  ['BroadLink', 'i', /BroadLink Technology/i],
  ['Philips Hue', 'i', /^(Signify|Philips Lighting)/i],
  ['ecobee', 'i', /^ecobee/i],
  ['Roborock', 'i', /Roborock/i],
  ['Dreame', 'i', /^Dreame/i],
  ['iRobot', 'i', /^iRobot/i],
  ['Withings', 'i', /^Withings/i],
  ['Chamberlain', 'i', /^(The )?Chamberlain/i],
  ['Lutron', 'i', /^Lutron/i],
  ['Tesla', 'i', /^Tesla,? ?Inc/i],
  ['Logitech', 'i', /logitech/i],
  ['Garmin', 'i', /^Garmin/i],
  ['Fitbit', 'i', /^Fitbit/i],
  ['Texas Instruments', 'i', /^Texas Instruments/i],
  ['Silicon Labs', 'i', /^Silicon Laboratories/i],
  ['Murata', 'i', /^Murata Manufacturing/i],
  ['Sonos', 's', /^(Sonos,? Inc|SONOS Co)/i],
  ['Bose', 's', /^Bose Corporation/i],
  ['Roku', 't', /^Roku/i],
  ['Nvidia', 't', /^NVIDIA/i],
  ['TCL', 't', /^(TCL|Shenzhen TCL|Huizhou TCL)\b/i],
  ['Hisense', 't', /hisense/i],
  ['Vizio', 't', /^Vizio/i],
  ['Panasonic', 't', /panasonic/i],
  ['Sharp', 't', /^SHARP Corporation/i],
  ['Philips TV', 't', /^TP Vision/i],
  ['Valve', 'g', /^Valve Corporation/i],
  ['Meta', 'g', /^(Meta Platforms|Facebook Inc|Oculus VR)/i],
  ['Ring', 'v', /^Ring LLC/i],
  ['Wyze', 'v', /^Wyze/i],
  ['Hikvision', 'v', /hikvision/i],
  ['Dahua', 'v', /dahua/i],
  ['Reolink', 'v', /^Reolink/i],
  ['Ezviz', 'v', /ezviz/i],
  ['GoPro', 'v', /^GoPro/i],
  ['Canon', 'r', /^Canon\b/i],
  ['Epson', 'r', /Seiko Epson/i],
  ['Brother', 'r', /^Brother Industries/i],
  ['Dell', 'c', /^Dell\b/i],
  ['HP', 'c', /^(Hewlett Packard$|HP Inc)/i],
  ['Lenovo', 'c', /lenovo/i],
  ['Foxconn', 'c', /^(Hon Hai|Foxconn)/i],
  ['AzureWave', 'c', /^AzureWave/i],
  ['Liteon', 'c', /^Lite-?on/i],
  ['Fugui', 'c', /fugui/i],
  ['USI', 'c', /^Universal Global Scientific/i],
  ['Wistron', 'c', /^Wistron/i],
  ['Compal', 'c', /^Compal/i],
  ['Pegatron', 'c', /^Pegatron/i],
  ['Quanta', 'c', /^Quanta Computer/i],
];

const FINAL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&*';
const DIGITS = '0123456789abcdefghijklmnopqrstuv';

function encode(n) {
  let s = FINAL[n % 32];
  for (n = Math.floor(n / 32); n; n = Math.floor(n / 32)) s = DIGITS[n % 32] + s;
  return s;
}

/** Minimal CSV: quoted fields with "" escapes; returns rows of fields. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

function sample(ouis) {
  if (ouis.length <= SAMPLE_CAP) return ouis;
  const newer = ouis.filter((o) => o >= 0x010000);
  const pool = newer.length >= SAMPLE_CAP ? newer : ouis;
  return Array.from({ length: SAMPLE_CAP }, (_, i) => pool[Math.floor(((i + 0.5) * pool.length) / SAMPLE_CAP)]);
}

function table(groups) {
  return groups
    .filter(([, , ouis]) => ouis.length)
    .map(([label, kind, ouis]) => {
      let prev = 0;
      let body = '';
      for (const o of ouis) (body += encode(o - prev)), (prev = o);
      return `${label}${kind ? `/${kind}` : ''}:${body}`;
    })
    .join('|');
}

function write(file, what, data) {
  const source =
    `// Generated by scripts/build-oui.mjs from the IEEE MA-L registry: ${what}.\n` +
    `// Do not edit; rerun the script. Format: see the script's header.\n\n` +
    `// prettier-ignore\nexport const TABLE =\n  '${data}';\n`;
  writeFileSync(file, source);
  const gz = gzipSync(Buffer.from(data), { level: 9 }).length;
  console.log(`${file}: ${data.length} bytes, ${gz} gzipped`);
}

const [csvPath] = process.argv.slice(2);
if (!csvPath) {
  console.error('Usage: node scripts/build-oui.mjs <oui.csv>');
  process.exit(1);
}
const [header, ...rows] = parseCsv(readFileSync(csvPath, 'utf8'));
const col = (name) => header.indexOf(name);
const [reg, assignment, org] = [col('Registry'), col('Assignment'), col('Organization Name')];
if (reg < 0 || assignment < 0 || org < 0) {
  console.error('Not the IEEE oui.csv: missing Registry, Assignment or Organization Name columns.');
  process.exit(1);
}

const found = VENDORS.map(() => new Set());
for (const r of rows) {
  if (r[reg] !== 'MA-L' || !/^[0-9A-F]{6}$/i.test(r[assignment] ?? '')) continue;
  const name = r[org].trim();
  const i = VENDORS.findIndex(([, , re]) => re.test(name));
  if (i >= 0) found[i].add(parseInt(r[assignment], 16));
}
const groups = VENDORS.map(([label, kind], i) => [label, kind, [...found[i]].sort((a, b) => a - b)]);
for (const [label, , ouis] of groups) if (!ouis.length) console.warn(`No prefixes for ${label}; check its pattern.`);
console.log(`${groups.reduce((n, [, , o]) => n + o.length, 0)} prefixes for ${groups.length} makers`);

write('src/lib/ouiFull.ts', 'every prefix of the makers it lists', table(groups));
write(
  'src/lib/ouiSample.ts',
  `at most ${SAMPLE_CAP} prefixes per maker, for the initial load`,
  table(groups.map(([label, kind, ouis]) => [label, kind, sample(ouis)])),
);
