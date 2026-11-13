# A WiFi client for the dev router: associates over a mac80211_hwsim radio and
# takes a DHCP lease, so iwinfo assoclist and the Clients view have a station.
FROM alpine:3
RUN apk add --no-cache wpa_supplicant iw
COPY station.sh /station.sh
CMD ["/bin/sh", "/station.sh"]
