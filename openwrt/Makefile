# OpenWrt package for netui. Build with the SDK matching the target release:
# a 25.x SDK produces an .apk, a 24.10 SDK an .ipk, from this same Makefile.
#
#   npm run build                              # on the host: produces dist/
#   ln -s /path/to/netui/openwrt <sdk>/package/netui
#   make -C <sdk> package/netui/compile V=s
#
# Nothing is compiled: the package ships the prebuilt static files from dist/
# and the rpcd ACL. Override NETUI_DIST to package a dist/ from elsewhere.

include $(TOPDIR)/rules.mk

PKG_NAME:=netui
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

# Resolve the symlink so ../dist means the repo's dist/, not the SDK's.
NETUI_DIST ?= $(abspath $(shell readlink -f $(CURDIR))/../dist)

define Package/netui
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Web management UI for OpenWrt routers and access points
  # luci-base provides the luci-rpc object (leases, host hints); LuCI stays
  # installed as the fallback UI anyway.
  DEPENDS:=+rpcd +rpcd-mod-iwinfo +uhttpd +uhttpd-mod-ubus +luci-base
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
endef

# rpcd reads ACLs at startup.
define Package/netui/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	/etc/init.d/rpcd restart
	uci -q get rpcd.netui >/dev/null || echo "netui: run 'netui-passwd' to create the login, then open http://<router>/netui/"
fi
exit 0
endef

define Package/netui/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd restart
exit 0
endef

$(eval $(call BuildPackage,netui))
