# Shoutcast DNAS 2.6.1 (official binary, final release)
# Public path: internet -> gthost nginx :8000 -> wg0 -> 192.168.0.241:8100 (this container)
# Internal port is 8100 (host port 8000 is taken by another container; no host publish needed)
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    wireguard iproute2 sudo ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY dnas/sc_serv /opt/sc_serv2/sc_serv
COPY dnas/cacert.pem /opt/sc_serv2/cacert.pem
COPY wireguard/wg0.conf.template /etc/wireguard/wg0.conf.template
COPY dnas/entrypoint.sh /entrypoint.sh
# CWD = /opt/sc_serv2 so relative conf paths (data/...) resolve inside the mount
WORKDIR /opt/sc_serv2
RUN chmod a+x sc_serv /entrypoint.sh \
    && mkdir -p data \
    && useradd --system --home-dir /opt/sc_serv2 scserv \
    && chown -R scserv:scserv /opt/sc_serv2
# Healthcheck hits currentsong (finite + public) — NOT the / stream endpoint.
# Curling the infinite stream holds a listener slot for the whole healthcheck
# timeout; DNAS never releases it quickly enough, so currentlisteners climbs
# to maxlisteners (100) and real listeners start getting 503 "Server limit
# reached". currentsong returns immediately and does not count as a listener.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf -o /dev/null 'http://127.0.0.1:8100/currentsong?sid=1' || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/opt/sc_serv2/sc_serv", "/opt/sc_serv2/sc_serv2.conf"]
