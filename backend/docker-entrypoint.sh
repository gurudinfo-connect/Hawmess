#!/bin/sh
set -e
node dist/db/migrate.js
if [ "$RUN_SEED" = "true" ]; then node dist/db/seed.js; fi
exec node dist/index.js
