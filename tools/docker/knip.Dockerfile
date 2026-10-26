# knip in a fixed Linux image, so dead-code analysis gives the same answer on
# every machine and in CI. The repository is mounted read-only at /repo;
# knip's own native parser comes from this image, not from the host's
# node_modules.
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
RUN npm install --global --ignore-scripts --no-audit --no-fund knip@6.42.1 typescript@7.0.2 \
	&& npm cache clean --force
WORKDIR /repo
ENTRYPOINT ["knip"]
