#!/usr/bin/env bash
# Mechanical wrapper: run exactly one kb CLI evolution iteration from durable state.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)

cd "$REPO"
exec npm run bench:evol:iteration -- "$@"
