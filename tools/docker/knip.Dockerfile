# knip in a fixed Linux image, so dead-code analysis gives the same answer on
# every machine and in CI. The repository is mounted read-only at /repo;
# knip's own native parser comes from this image, not from the host's
# node_modules.
FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
RUN npm install --global --ignore-scripts --no-audit --no-fund knip@6.42.1 typescript@7.0.2 \
	&& npm cache clean --force
WORKDIR /repo
ENTRYPOINT ["knip"]
