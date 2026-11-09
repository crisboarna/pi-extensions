# knip in a fixed Linux image, so dead-code analysis gives the same answer on
# every machine and in CI. The repository is mounted read-only at /repo;
# knip's own native parser comes from this image, not from the host's
# node_modules.
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
RUN npm install --global --ignore-scripts --no-audit --no-fund knip@6.42.1 typescript@7.0.2 \
	&& npm cache clean --force
WORKDIR /repo
ENTRYPOINT ["knip"]
