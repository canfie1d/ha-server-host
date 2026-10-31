# The host runs prebuilt server bundles, so the image needs only Node (servers are built for this
# major version) and tar, which the base image has. HA's default init (tini) is PID 1.
FROM node:22-slim

WORKDIR /opt/server-host
COPY src ./src

CMD ["node", "src/index.mjs"]
