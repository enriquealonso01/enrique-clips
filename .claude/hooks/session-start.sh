#!/bin/bash
set -euo pipefail

# Only run in remote (cloud) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install

# Write Composio MCP config if API key is available
if [ -n "${COMPOSIO_API_KEY:-}" ]; then
  cat > .claude/settings.local.json << EOF
{
  "mcpServers": {
    "composio": {
      "url": "https://mcp.composio.dev/composio/mcp?apiKey=${COMPOSIO_API_KEY}"
    }
  }
}
EOF
fi
