#!/bin/sh
# First boot of the netui test VM (router). Written into the image by up.sh.
#
# Ports: eth0 = LAN port the host is plugged into (10.232.1.10), eth1 = WAN
# (libvirt NAT, DHCP), eth2-eth4 = extra LAN ports. eth2 is cabled to the
# client VM. Starts as a plain bridge with no VLANs, like a fresh install.

uci -q batch <<UCI
set system.@system[0].hostname='netui-vm'

delete network.lan.ipaddr
add_list network.lan.ipaddr='10.232.1.1/24'
set network.wan.device='eth1'
set network.wan6.device='eth1'

set rpcd.netui=login
set rpcd.netui.username='netui'
set rpcd.netui.password='$(uhttpd -m netui)'
add_list rpcd.netui.read='netui'
add_list rpcd.netui.write='netui'
UCI

# The bridge section board.json generated for br-lan.
br=$(uci show network | sed -n "s/^network\.\(@device\[[0-9]*\]\)\.name='br-lan'$/\1/p" | head -1)
uci -q delete "network.$br.ports"
for p in eth0 eth2 eth3 eth4; do uci add_list "network.$br.ports=$p"; done
uci commit

mkdir -p /etc/dropbear
echo '@PUBKEY@' >/etc/dropbear/authorized_keys
chmod 600 /etc/dropbear/authorized_keys
exit 0
