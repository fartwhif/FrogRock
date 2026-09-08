#!/bin/bash
set -e

# ── WireGuard tunnel (DNAS container's own peer: 192.168.0.241) ──
if [ -n "$WG_PRIVATE_KEY" ] && [ -n "$WG_PEER_PUBLIC_KEY" ] && [ -n "$WG_PEER_ENDPOINT" ]; then
  echo "Configuring WireGuard tunnel (shoutcast-dnas)..."

  # Fill template placeholders from env vars
  sed \
    -e "s|__WG_PRIVATE_KEY__|${WG_PRIVATE_KEY}|g" \
    -e "s|__WG_ADDRESS__|${WG_ADDRESS:-192.168.0.241/32}|g" \
    -e "s|__WG_PEER_PUBLIC_KEY__|${WG_PEER_PUBLIC_KEY}|g" \
    -e "s|__WG_PEER_ALLOWEDIPS__|${WG_PEER_ALLOWEDIPS:-192.168.0.0/20}|g" \
    -e "s|__WG_PEER_ENDPOINT__|${WG_PEER_ENDPOINT}|g" \
    -e "s|__WG_PEER_PERSISTENT_KEEPALIVE__|${WG_PEER_PERSISTENT_KEEPALIVE:-25}|g" \
    /etc/wireguard/wg0.conf.template > /etc/wireguard/wg0.conf

  wg-quick up wg0
  echo "WireGuard tunnel established (shoutcast-dnas)"
  wg show
else
  echo "WireGuard: skipping (missing env vars)"
fi

# Drop to scserv and run the server
exec sudo -E -u scserv "$@"
