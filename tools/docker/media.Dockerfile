# Renders README and gallery media (PNG stills, MP4 and GIF animations) from
# HTML pages, with fixed fonts so the output is the same on every machine.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends ffmpeg fonts-ibm-plex fonts-jetbrains-mono \
	&& rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/media && cd /opt/media \
	&& npm init --yes >/dev/null \
	&& npm install --ignore-scripts --no-audit --no-fund playwright@1.64.1 \
	&& npm cache clean --force
ENV MEDIA_MODULES=/opt/media/node_modules
WORKDIR /work
