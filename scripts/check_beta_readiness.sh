#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/6] JavaScript syntax (all modules and tests)"
while IFS= read -r -d '' file; do
  node --check "$file" >/dev/null
done < <(find js -name '*.js' -print0 | sort -z)

echo "[2/6] PHP syntax (all endpoints and support files)"
while IFS= read -r -d '' file; do
  php -l "$file" >/dev/null
done < <(find api -name '*.php' -print0 | sort -z)

echo "[3/6] Shared config version parity"
js_versions="$(node --input-type=module -e 'import { ENGINE_VERSION, LANGUAGE_VERSION } from "./js/shared/config.js"; console.log(`${ENGINE_VERSION}|${LANGUAGE_VERSION}`);')"
php_versions="$(php -r 'require "api/config.php"; echo ENGINE_VERSION . "|" . LANGUAGE_VERSION;')"
if [[ "$js_versions" != "$php_versions" ]]; then
  echo "Version mismatch: js/shared/config.js=$js_versions api/config.php=$php_versions" >&2
  exit 1
fi

echo "[4/6] ArenaScript language regression tests"
node js/lang/regression-tests.js

echo "[5/6] Engine invariant tests"
node js/tests/engine-invariant-tests.js

echo "[6/6] API contract and end-to-end tests"
node js/tests/api-contract-tests.js

echo "Beta readiness checks passed."
