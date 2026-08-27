#!/usr/bin/env bash
# Launch the Tripo CLI as an MCP stdio server for the coding client.
#
# The Tripo API key is a secret and must never be written into `.mcp.json`,
# client settings, or any other tracked file. This launcher loads it from the
# untracked repository `.env` at process start and passes it to `tripo` through
# the environment only, so the key exists solely in this process tree.
#
# stdout is the MCP JSON-RPC channel: nothing here may print to stdout.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="$repo_root/.env"

if [ -z "${TRIPO_API_KEY:-}" ] && [ -f "$env_file" ]; then
  # `set -a` exports every assignment sourced from .env without echoing values.
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

if [ -z "${TRIPO_API_KEY:-}" ]; then
  echo "tripo-mcp: TRIPO_API_KEY is not set and $env_file did not provide it" >&2
  exit 1
fi

if ! command -v tripo >/dev/null 2>&1; then
  echo "tripo-mcp: the 'tripo' CLI is not on PATH (npm install -g tripo-cli)" >&2
  exit 1
fi

# --quiet keeps progress logs off stderr, --no-open prevents the CLI from
# opening a browser, --yes keeps long-running tools from waiting on a TTY.
exec tripo mcp --quiet --no-open --yes
