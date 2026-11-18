# OpenWrt package for netui. Build with the SDK matching the target release:
# a 25.x SDK produces an .apk, a 24.10 SDK an .ipk, from this same Makefile.
#
#   npm run build                              # on the host: produces dist/
#   ln -s /path/to/netui/openwrt <sdk>/package/netui
#   make -C <sdk> package/netui/compile V=s
#
# Or let scripts/build-package.sh do it in the official SDK container.
#
# Nothing is compiled: the package ships the prebuilt static files from dist/
# and the rpcd ACL. Override NETUI_DIST to package a dist/ from elsewhere.

include $(TOPDIR)/rules.mk

PKG_NAME:=netui
# CI passes the release tag without its "v" (scripts/build-package.sh).
NETUI_VERSION ?= 0.4.0
PKG_VERSION:=$(NETUI_VERSION)
PKG_RELEASE:=1
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

# Resolve the symlink so ../dist means the repo's dist/, not the SDK's.
NETUI_DIST ?= $(abspath $(shell readlink -f $(CURDIR))/../dist)

define Package/netui
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Web management UI for OpenWrt routers and access points
  # luci-base provides the luci-rpc and luci objects (leases, host hints,
  # timezones, conntrack); LuCI stays installed as the fallback UI anyway.
  # rpcd-mod-file runs the three service scripts the ACL allows.
  # SQM, UPnP, DDNS, WireGuard, wifischedule, etherwake and https-dns-proxy
  # stay optional: netui hides or explains what is not installed.
  # rpcd-mod-ucode and uclient-fetch run netui.devices, which adopts access
  # points and relays calls to them. owut (firmware upgrades) is optional.
  DEPENDS:=+rpcd +rpcd-mod-iwinfo +rpcd-mod-file +rpcd-mod-ucode +uclient-fetch +uhttpd +uhttpd-mod-ubus +luci-base
  PKGARCH:=all
endef

define Package/netui/description
  A static single-page UI served by uhttpd under /netui/, talking to rpcd
  over /ubus with its own login and ACL. Run netui-passwd once to create
  the login.
endef

define Build/Prepare
	@if [ ! -f "$(NETUI_DIST)/index.html" ]; then \
		echo "netui: $(NETUI_DIST)/index.html not found. Run 'npm run build' first." >&2; \
		exit 1; \
	fi
	mkdir -p $(PKG_BUILD_DIR)
	rm -rf $(PKG_BUILD_DIR)/dist
	$(CP) $(NETUI_DIST) $(PKG_BUILD_DIR)/dist
endef

define Build/Compile
endef

define Package/netui/install
	$(INSTALL_DIR) $(1)/www/netui
	$(CP) $(PKG_BUILD_DIR)/dist/. $(1)/www/netui/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/netui.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/usr/sbin/netui-passwd $(1)/usr/sbin/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./files/usr/share/rpcd/ucode/netui-devices ./files/usr/share/rpcd/ucode/netui-firmware ./files/usr/share/rpcd/ucode/netui-speedtest ./files/usr/share/rpcd/ucode/netui-services ./files/usr/share/rpcd/ucode/netui-users ./files/usr/share/rpcd/ucode/netui-packages ./files/usr/share/rpcd/ucode/netui-tailscale $(1)/usr/share/rpcd/ucode/
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./files/lib/upgrade/keep.d/netui $(1)/lib/upgrade/keep.d/
endef

# rpcd reads ACLs at startup.
define Package/netui/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	# A firmware upgrade keeps /www/netui (keep.d) but forgets the package, so
	# reinstalling cannot remove the previous build's assets: drop what is not ours.
	list=/lib/apk/packages/netui.list
	[ -f "$$list" ] || list=/usr/lib/opkg/info/netui.list
	if [ -f "$$list" ]; then
		for f in /www/netui/assets/*; do
			grep -qxF "$$f" "$$list" || rm -f "$$f"
		done
	fi
	/etc/init.d/rpcd restart
	uci -q get rpcd.netui >/dev/null || echo "netui: run 'netui-passwd' to create the login, then open http://<router>/netui/"
fi
exit 0
endef

define Package/netui/postrm
#!/bin/sh
# opkg leaves the emptied directories behind; apk removes them itself.
rmdir "$${IPKG_INSTROOT}/www/netui/assets" "$${IPKG_INSTROOT}/www/netui" 2>/dev/null
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd restart
exit 0
endef

# ---------------------------------------------------------------------------
# netui-agent: install on an OpenWrt router to manage it as an access point
# from a netui gateway's Devices page.

define Package/netui-agent
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Access point agent for a netui gateway
  DEPENDS:=+rpcd +rpcd-mod-ucode +uhttpd +uhttpd-mod-ubus
  PKGARCH:=all
endef

define Package/netui-agent/description
  Lets a netui gateway discover, adopt and manage this router as an access
  point. Run 'netui-agent prepare' once, plug it into the gateway's LAN and
  adopt it from the gateway's Devices page.
endef

define Package/netui-agent/install
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	sed -e 's/@VERSION@/$(PKG_VERSION)-r$(PKG_RELEASE)/' ./agent/files/usr/share/rpcd/ucode/netui-agent > $(1)/usr/share/rpcd/ucode/netui-agent
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./agent/files/usr/share/rpcd/acl.d/netui-agent.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/usr/libexec/netui-agent
	$(INSTALL_BIN) ./agent/files/usr/sbin/netui-agent $(1)/usr/sbin/
	$(INSTALL_BIN) ./agent/files/usr/libexec/netui-agent/access-point $(1)/usr/libexec/netui-agent/
	# Same firmware plugin as the gateway's; the gateway relays to it.
	$(INSTALL_DATA) ./files/usr/share/rpcd/ucode/netui-firmware ./files/usr/share/rpcd/ucode/netui-packages $(1)/usr/share/rpcd/ucode/
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./agent/files/lib/upgrade/keep.d/netui-agent $(1)/lib/upgrade/keep.d/
endef

define Package/netui-agent/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	/etc/init.d/rpcd restart
	[ -f /etc/netui-agent/adopted.json ] || echo "netui-agent: run 'netui-agent prepare', then adopt this router from the gateway's Devices page"
fi
exit 0
endef

define Package/netui-agent/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd restart
exit 0
endef

$(eval $(call BuildPackage,netui))
$(eval $(call BuildPackage,netui-agent))
