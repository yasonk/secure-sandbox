FROM docker.io/cloudflare/sandbox:0.10.2

# Install agent CLIs globally.
RUN npm install -g @openai/codex @anthropic-ai/claude-code

# Expose the WebSocket port used by codex app-server
EXPOSE 4500
