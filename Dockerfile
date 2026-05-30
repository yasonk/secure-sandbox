FROM docker.io/cloudflare/sandbox:0.10.2

# bubblewrap: codex's preferred sandbox backend (avoids the bundled-fallback warning).
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap \
  && rm -rf /var/lib/apt/lists/*

# Install agent CLIs globally.
RUN npm install -g @openai/codex @anthropic-ai/claude-code

# Expose the WebSocket port used by codex app-server
EXPOSE 4500
