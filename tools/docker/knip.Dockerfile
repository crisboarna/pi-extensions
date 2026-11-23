# knip in a fixed Linux image, so dead-code analysis gives the same answer on
# every machine and in CI. The repository is mounted read-only at /repo;
# knip's own native parser comes from this image, not from the host's
# node_modules.
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN npm install --global --ignore-scripts --no-audit --no-fund knip@6.42.1 typescript@7.0.2 \
	&& npm cache clean --force
WORKDIR /repo
ENTRYPOINT ["knip"]
