FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec AS sandbox
FROM --platform=linux/amd64 node:24-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a
RUN apt-get update && apt-get install -y --no-install-recommends bash git python3 ca-certificates && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@10.28.2
COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY src/workspace/supervisor.py src/workspace/files-helper.mjs /opt/multipi/
RUN mkdir -p /workspace
WORKDIR /workspace
# DirectoryBackup atomically replaces this directory: keep it out of image lower layers.
CMD ["bash", "-c", "mkdir -p /workspace/repo && exec sleep infinity"]
