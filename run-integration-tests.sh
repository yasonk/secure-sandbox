#!/usr/bin/env bash
set -euo pipefail

bash "$(dirname "$0")/test/run-integration-tests.sh" "$@"
