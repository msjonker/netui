# ubus fixtures

Real responses from the target device. Types in `src/api/types.ts` and every
normalizer in `src/model/` are written against these files, not against docs.

Record or refresh them with:

```sh
ROUTER_HOST=192.168.1.1 npm run record-fixtures
```

`dev-container/` comes from the Docker dev router (`npm run record-fixtures:dev`).
It is real OpenWrt output but not the target device: no radios, host memory
figures, Docker hostnames. Fixtures from the actual router go at the top level
and take precedence once recorded.

`dl-wrx36/` is a factory-reset Dynalink DL-WRX36 used as a hardware test
router (OpenWrt SNAPSHOT, qualcommax/ipq807x, DSA ports `lan1`-`lan4` + `wan`,
radios disabled as shipped). `plain/` is the factory config; `vlan/` adds an
isolated `iot` network on VLAN 10 tagged on lan1-lan4, created through netui.
Record with
`NETUI_DEVICE=dl-wrx36/<scenario> ROUTER_HOST=192.168.1.1 npm run record-fixtures`.

An empty object reply is recorded as `{}` (what `ubus call` prints), but over
HTTP rpcd sends a bare `[0]` with no data at all: hooks for replies that can be
empty (`luci.wireguard getWgInstances`, `luci.ddns get_services_status`) must
default to `{}`.

Files hold the `data` part of the result only (what `ubus call` prints), not
the JSON-RPC envelope. Tests that mock the transport wrap them as `[0, data]`.

Naming: `<object>.<method>[.<arg>].json`, e.g. `iwinfo.assoclist.phy0-ap0.json`.
`_ubus_list.txt` is `ubus -v list` for every object the ACL grants, and
`_openwrt_release.txt` records which release the fixtures came from.

`tl-wdr4300-v1/` is a TL-WDR4300 v1 (ath79, radio0 2.4 GHz, radio1 5 GHz, both
ath9k, 8 MB flash) right after flashing OpenWrt 24.10.8 over its previous
firmware: 24.10 turns every radio off and leaves the open "OpenWrt" networks
enabled (25.12 does the opposite), the stock WiFi package is the basic build
(`luci.getFeatures.hostapd.json`: no eap, no mesh), and iwinfo lists no
devices at all while the radios are off.

`tl-wr1043nd-v2/` is a fresh OpenWrt 25.12.6 install on a single-radio
ath79 router with the stock basic WiFi package (`wpad-basic-mbedtls`),
recorded over `/ubus` (its ssh was off). The `.bss_transition` files are a
WiFi created by netui with BSS transition on: hostapd rejects the option
(`log.hostapd.bss_transition.txt`) and starts nothing, so there is no
`hostapd.phy0-ap0` object (uhttpd answers JSON-RPC -32000), yet iwinfo still
reports the SSID, read from hostapd's config file. The other files are the
same WiFi after netui turned the option off. The SSID is renamed to
`netui-test` and the router's MAC replaced with `02:00:00:00:00:01`.

Credential-like fields are redacted to `"REDACTED"` by the script. Client
hostnames and MACs are not; check the diff before committing.

`bench-v2/netui.firmware.status.*` are `netui.firmware status`: `idle`,
`checking` and `checked` on the gateway; `ap-upgrade-*` on the AX3600 during a
real upgrade from the UI (`setup` and `building` while the build server works,
`saved` after the download, `failed` for a version that does not exist).
`upgrade-installing.synthetic.json` is HAND-WRITTEN: owut exiting 0 after
handing the image to sysupgrade, which the recording could not catch before
the device went down.
