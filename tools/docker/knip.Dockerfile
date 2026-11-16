# knip in a fixed Linux image, so dead-code analysis gives the same answer on
# every machine and in CI. The repository is mounted read-only at /repo;
# knip's own native parser comes from this image, not from the host's
# node_modules.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
RUN npm install --global --ignore-scripts --no-audit --no-fund knip@6.42.1 typescript@7.0.2 \
	&& npm cache clean --force
WORKDIR /repo
ENTRYPOINT ["knip"]
