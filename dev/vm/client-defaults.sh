#!/bin/sh
# First boot of the netui test client VM. Written into the image by up.sh.
#
# eth0 = cable to router port eth2, a DHCP client like any LAN device (zone
# wan, so it never serves DHCP back). eth1 = management, 10.232.9.2, so the
# host can ssh in regardless of what the VLAN tests do to eth0. VLAN tests add
# 802.1q devices on eth0 over ssh (see vm.sh client-vlan).

uci -q batch <<UCI
set system.@system[0].hostname='netui-vmclient'

delete network.wan6
set network.wan.device='eth0'
set network.wan.proto='dhcp'
set network.wan.hostname='vmclient'

delete network.lan.ipaddr
add_list network.lan.ipaddr='10.232.9.2/24'
set dhcp.lan.ignore='1'
set dhcp.lan.dhcpv6='disabled'
set dhcp.lan.ra='disabled'
UCI

br=$(uci show network | sed -n "s/^network\.\(@device\[[0-9]*\]\)\.name='br-lan'$/\1/p" | head -1)
uci -q delete "network.$br.ports"
uci add_list "network.$br.ports=eth1"
uci commit

mkdir -p /etc/dropbear
echo '@PUBKEY@' >/etc/dropbear/authorized_keys
chmod 600 /etc/dropbear/authorized_keys
exit 0
