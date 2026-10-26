# Renders README and gallery media (PNG stills, MP4 and GIF animations) from
# HTML pages, with fixed fonts so the output is the same on every machine.
# xterm.js draws the terminal scenes, where a real program runs in a
# pseudo-terminal (tools/media/stage-server.mjs). Narrated videos are voiced
# by Kokoro-82M (Apache-2.0 weights) through kokoro-js, offline: the model is
# fetched here once, at a pinned revision, and checked against its hashes.
# kokoro-js's phonemizer bundles espeak-ng (GPL-3.0); it runs only inside this
# image at build time and never ships (docs/guardrails.md).
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends ca-certificates curl ffmpeg fonts-ibm-plex fonts-jetbrains-mono \
	&& rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/media && cd /opt/media \
	&& npm init --yes >/dev/null \
	&& npm install --ignore-scripts --no-audit --no-fund playwright@1.64.1 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 \
	&& npm cache clean --force
# onnxruntime-node needs its install script to place its native library.
RUN cd /opt/media \
	&& npm install --no-audit --no-fund kokoro-js@1.2.1 @huggingface/transformers@3.8.1 \
	&& npm cache clean --force
ARG KOKORO=https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231
RUN dir=/opt/media/models/onnx-community/Kokoro-82M-v1.0-ONNX \
	&& mkdir -p "$dir/onnx" && cd "$dir" \
	&& for file in config.json tokenizer.json tokenizer_config.json onnx/model.onnx; do curl --fail --silent --show-error --location --output "$file" "$KOKORO/$file"; done \
	&& printf '%s  %s\n' \
		df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f config.json \
		77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34 tokenizer.json \
		be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20 tokenizer_config.json \
		8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb onnx/model.onnx \
		| sha256sum --check --strict
ENV MEDIA_MODULES=/opt/media/node_modules
ENV MEDIA_MODELS=/opt/media/models
WORKDIR /work
