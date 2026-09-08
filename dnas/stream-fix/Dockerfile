# stream-fix: normalization shim between DNAS's relay client and FrogRock.
# See fixer.py docstring for the exact framing problems it solves.
FROM python:3.12-alpine
WORKDIR /opt/stream-fix
COPY fixer.py /opt/stream-fix/fixer.py
ENV LISTEN_PORT=8091 UPSTREAM_HOST=frogrock UPSTREAM_PORT=8090
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8091), 3).close()"
CMD ["python", "/opt/stream-fix/fixer.py"]
