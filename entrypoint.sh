#!/bin/sh
set -e

# Configure WireGuard from env vars
if [ -n "$WG_PRIVATE_KEY" ]; then
  echo "Configuring WireGuard..."

  # Create the interface
  ip link add dev wg0 type wireguard

  # Set private key
  wg set wg0 private-key <(echo "$WG_PRIVATE_KEY")

  # Add peer
  wg set wg0 \
    peer "$WG_PEER_PUBLIC_KEY" \
    endpoint "$WG_PEER_ENDPOINT" \
    allowed-ips "$WG_PEER_ALLOWEDIPS" \
    persistent-keepalive "$WG_PEER_PERSISTENT_KEEPALIVE"

  # Set address and bring interface up
  ip address add "$WG_ADDRESS" dev wg0
  ip link set mtu 1420 up dev wg0

  # Set DNS if provided
  if [ -n "$WG_DNS" ]; then
    echo "nameserver $WG_DNS" > /etc/resolv.conf
  fi

  echo "WireGuard interface wg0 is up."
  wg show
else
  echo "WireGuard: skipping (no private key set)."
fi

# Drop to appuser and run the app
exec su-exec appuser "$@"
