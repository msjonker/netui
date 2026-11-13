# netui

A friendly web UI for OpenWrt routers, access points and mesh WiFi.

## Develop

```sh
npm install
cp .env.example .env.local   # set ROUTER_URL
npm run dev                  # /ubus is proxied to ROUTER_URL
npm test
npm run build                # typecheck + build; check gzip sizes against the 175 KB budget
```

## Dev router (Docker)

A disposable OpenWrt 25.12 container with the real rpcd, uhttpd, netifd, dnsmasq
and LuCI, plus two DHCP clients on its LAN. It serves `dist/` at `/netui/` and
mounts the ACL from this repo, so you can exercise the real login and ACL.

```sh
npm run router:up              # LuCI at http://10.231.1.2/, netui at http://10.231.1.2/netui/
echo ROUTER_URL=http://10.231.1.2 > .env.local
npm run record-fixtures:dev    # -> test/fixtures/ubus/dev-container/
npm run router:reset           # throw it away and start clean
```

Login `netui` / `netui`. `OPENWRT_TAG=x86-64-24.10.8 npm run router:reset` to try 24.10.

Simulated WiFi: run `sudo modprobe mac80211_hwsim radios=3` on the host, then
`npm run router:wifi`. Two radios go to the router and one to a station client
(`netui-client-tablet`). Only hwsim phys are moved; real WiFi hardware is never
touched. Radios return to the host when the containers stop, so re-run after
`router:up`. Undo with `sudo rmmod mac80211_hwsim`.

The client containers route through Docker's bridge (10.231.1.1), not through
the router, so their traffic does not show on the dashboard chart. Generate WAN
traffic from the router itself (`npm run router:shell`, then `ping 10.231.0.1`).

Limits: without hwsim there are no radios (iwinfo and `wireless` are empty), `system info`
reports the host kernel's memory and uptime, and ujail is shimmed out because
Docker denies its namespaces. It is not the target device and not a substitute
for the x86 VM when testing apply/rollback on network or firewall changes.

## Test VMs (ports, VLANs, firewall input)

Destructive changes (bridge membership, VLANs, the LAN address, firewall input)
are tested on OpenWrt x86 VMs under libvirt, never on a real router. Needs
membership of the `libvirt` group; no sudo.

```sh
dev/vm/vm.sh up          # router 10.232.1.1 (eth0 LAN, eth1 WAN, eth2-eth4 ports) + client VM on eth2
dev/vm/vm.sh deploy      # copy dist/ and the ACL; netui at http://10.232.1.1/netui/ (netui / netui)
dev/vm/vm.sh ssh 'bridge vlan show'
dev/vm/vm.sh client      # shell on the client, cabled to router eth2
dev/vm/vm.sh down
NETUI_VM=vlan scripts/record-fixtures.sh   # -> test/fixtures/ubus/vm/vlan/
```

To check a tagged VLAN end to end from the client:
`ip link add link eth0 name eth0.20 type vlan id 20 && ip link set eth0.20 up && udhcpc -i eth0.20`.

The recorded `vm/plain` and `vm/vlan` scenarios back the switch model tests and
`resetRouter({}, 'plain' | 'vlan')` in component tests.

## Testing

- Unit tests type against recorded fixtures in `test/fixtures/ubus/`. Record new
  ones with `npm run record-fixtures` (or `:dev`) before writing an API wrapper.
- Component tests mock `src/api/ubus.ts` with `test/fakeRouter.ts`, an in-memory
  router that serves the fixtures and stages uci writes with rpcd's recorded
  semantics (`uci changes` format, status 5/6 on confirm/apply, rollback
  restoring the staged changes). Assert on `router.writes()`.
- `test/applyFlow.ts` drives the review dialog (`review()`, `applyReviewed()`).
- `test/dom.ts`: use `type()` for inputs and `pick()` for `<select>`.
  `@testing-library/preact` turns `fireEvent.change` into an `input` event, so a
  select's `onChange` never fires with it; `pick()` dispatches a real `change`.
- Drawers are `<aside>` (role `complementary`); modals are `<dialog>`.

## Install as a package

`openwrt/Makefile` packages the prebuilt `dist/` plus the ACL and a
`netui-passwd` helper. Use the SDK for the target release (25.x builds an
`.apk`, 24.10 an `.ipk`):

```sh
npm run build
ln -s "$PWD/openwrt" <sdk>/package/netui
make -C <sdk> package/netui/compile V=s     # -> <sdk>/bin/packages/*/base/netui-*.apk
```

Or in Docker, without installing an SDK:

```sh
docker run --rm -v "$PWD:/src" openwrt/sdk:x86-64-25.12.5 sh -c \
  'ln -s /src/openwrt package/netui && make defconfig && make package/netui/compile V=s && cp bin/packages/*/base/netui-*.apk /src/'
```

The SDK warns that `rpcd`, `uhttpd` etc. "do not exist" when no feeds are
installed; that is harmless, the dependencies are still recorded in the package.

On the router: `apk add --allow-untrusted netui-*.apk` (or `opkg install` on
24.10), then `netui-passwd` to create the login, and open `/netui/`.

## Manual setup (without the package)


1. Install the ACL: copy `openwrt/files/usr/share/rpcd/acl.d/netui.json` to
   `/usr/share/rpcd/acl.d/` on the router.
2. Create the dedicated rpcd login (never use root):

   ```sh
   uci add rpcd login
   uci set rpcd.@login[-1].username='netui'
   uci set rpcd.@login[-1].password="$(uhttpd -m 'choose-a-password')"
   uci add_list rpcd.@login[-1].read='netui'
   uci add_list rpcd.@login[-1].write='netui'
   uci commit rpcd
   /etc/init.d/rpcd restart
   ```

3. Deploy: `ssh root@$ROUTER_HOST mkdir -p /www/netui && ROUTER_HOST=... npm run deploy`,
   then open `http(s)://<router>/netui/`.

Serve over HTTPS where possible; the session id is a bearer token.
