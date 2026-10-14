#!/usr/bin/env bash
# Regenerates the Linux screenshot baselines of the e2e suite (tests/e2e/baselines/*-linux) in the official Playwright
# image that matches the installed @playwright/test, on linux/amd64 and Ubuntu 24.04 (what GitHub's ubuntu-latest runs).
# Usage: scripts/qa/linux-baselines.sh            regenerate
#        COMPARE=1 scripts/qa/linux-baselines.sh  only compare against the committed baselines (as CI does)
# (needs Docker; the repo is copied, so node_modules/dist of the host stay untouched)
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="$(node -p "require('@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"
SPECS="${SPECS:-smoke.spec.ts realms.spec.ts}"
COMPARE="${COMPARE:-0}"
[ "$COMPARE" = 1 ] || rm -rf tests/e2e/baselines/chromium-linux tests/e2e/baselines/webkit-linux
docker run --rm --platform linux/amd64 --ipc=host -e SPECS="$SPECS" -e COMPARE="$COMPARE" -v "$PWD:/src:ro" -v "$PWD/tests/e2e/baselines:/out" "$IMAGE" bash -c '
  set -euo pipefail
  mkdir /work
  cd /src && tar --exclude=./node_modules --exclude=./.git --exclude=./dist --exclude=./data* --exclude=./test-results -cf - . | tar -xf - -C /work
  cd /work && npm ci --no-audit --no-fund >/dev/null
  if [ "$COMPARE" = 1 ]; then
    CI=1 npx playwright test -c tests/e2e/playwright.config.ts $SPECS --retries=0
  else
    npx playwright test -c tests/e2e/playwright.config.ts $SPECS --update-snapshots=all --retries=0
    cp -r tests/e2e/baselines/chromium-linux tests/e2e/baselines/webkit-linux /out/
  fi
'
ls tests/e2e/baselines
