# Disposable OpenWrt for development and fixture recording. Real procd, ubusd,
# rpcd, netifd, uhttpd and LuCI from the official rootfs.
ARG OPENWRT_TAG=x86-64-25.12.5
FROM openwrt/rootfs:${OPENWRT_TAG}
# WiFi userspace for mac80211_hwsim radios (see wifi.sh). The host kernel
# provides the driver, so no kmods are needed.
RUN mkdir -p /var/lock && apk update && apk add wifi-scripts wpad-basic-mbedtls iw iwinfo && rm -rf /var/cache/apk/*
COPY ujail-shim /sbin/ujail
COPY 99-netui-dev /etc/uci-defaults/99-netui-dev
CMD ["/sbin/init"]
