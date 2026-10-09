#!/bin/sh
# Migration rehearsal steps, one subcommand per step of the PodTemplate
# rehearsal-stockpile (podtemplates.yaml). Mounted from the ConfigMap
# ci-rehearsal at /rehearsal.
#
# Each step writes one short, plain-words line to /dev/termination-log; the
# dispatcher puts the failing step's line in the cluster/rehearsal commit
# status. A failing step exits non-zero, and the pod stops there.
#
# The database is a copy of production. Nothing here may print its rows:
#   - the copy step prints sizes and counts only, never tool output as is;
#   - everything else goes through `redact`, which removes the parts of
#     PostgreSQL and Prisma errors that can quote row values (DETAIL and
#     CONTEXT lines, "Key (...)=(...)", "Failing row contains", quoted
#     values in conversion errors, Prisma's DbError dump).
#
# Scripts here use $VAR, never the braced form, so that they pass through
# Flux substitution untouched (it is disabled for this object as well).
set -eu
set -o pipefail

TERM_LOG=/dev/termination-log
WORK=/work
SOCK=/var/run/postgresql
APP_ROLE=stockpile
APP_PASS=rehearsal
DB=$CI_REHEARSAL_DB

say() {
  printf '%s' "$1" | cut -c1-400 > "$TERM_LOG" 2> /dev/null || true
  echo "$1"
}

fail() {
  say "$1"
  exit 1
}

redact() {
  sed -E \
    -e '/DbError \{/c\  (database error details removed: they can quote row data)' \
    -e 's/^([[:space:]]*([a-z_]+: )?)(DETAIL|CONTEXT|WHERE):.*/\1\3: (removed: can quote row data)/' \
    -e 's/Key \(([^)]*)\)=\(.*\)/Key (\1)=(redacted)/g' \
    -e 's/Failing row contains .*/Failing row contains (redacted)/g' \
    -e '/invalid input|out of range|malformed|could not (convert|parse)|is not a valid/s/"[^"]*"/"(redacted)"/g'
}

# First error line of the given files, redacted, one line.
first_error() {
  cat "$@" 2> /dev/null | grep -m1 -E 'ERROR|FATAL|error:' | redact | tr -s ' \t' ' ' | cut -c1-220
}

# Settings for the app containers. Every secret is made up here, at random,
# for this one process: the copy holds plugin credentials encrypted with
# production's key, which the rehearsal never has, so none of them can be
# read, and no outside system can be signed in to. Besides, the pod has no
# egress but DNS and the database replicas (CiliumNetworkPolicy
# ci-rehearsal). OUTBOUND_MODE=readonly is Stockpile's outbound-write guard
# (#329): every outside write refused before it is sent; the ready step
# checks the api reports it.
app_env() {
  export DATABASE_URL="postgresql://$APP_ROLE:$APP_PASS@127.0.0.1:5432/$DB?schema=public"
  export REDIS_URL=redis://127.0.0.1:6379
  export CHECKPOINT_DISABLE=1
  export PRISMA_HIDE_UPDATE_MESSAGE=1
  export NO_COLOR=1
  export OUTBOUND_MODE=readonly
  AUTH_SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
  SECRETS_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
  export AUTH_SESSION_SECRET SECRETS_ENCRYPTION_KEY
  export GOOGLE_CLIENT_ID=rehearsal
  export GOOGLE_CLIENT_SECRET=rehearsal
  export AUTH_CALLBACK_URL=https://stockpile-rehearsal.invalid/api/auth/google/callback
  export AUTH_SECURE_COOKIES=true
  export AUTH_POST_LOGIN_REDIRECT=/
  export DEFAULT_TENANT=demo
  export HOME=/tmp
}

# ------------------------------------------------------------------ copy
# pg_dump of the production database from a read replica, streamed into
# the pod's own Postgres (memory-backed, gone with the pod). Read only:
# the role may only read (pg_read_all_data, and pg_hba admits it to this
# one database), the session is read-only, and a primary is refused.
copy() {
  : "$PGUSER" "$PGPASSWORD" "$SOURCE_HOST" "$SOURCE_DB"
  src="host=$SOURCE_HOST port=5432 dbname=$SOURCE_DB sslmode=require connect_timeout=15 application_name=stockpile-rehearsal options='-c default_transaction_read_only=on'"
  mkdir -p "$WORK"

  standby=$(psql "$src" -XAtqc "select pg_is_in_recovery()" 2> "$WORK/src.err") ||
    fail "Could not reach a production database replica to copy: $(first_error "$WORK/src.err")"
  if [ "$standby" != t ]; then
    fail "Refused to copy: $SOURCE_HOST answered from the primary; the rehearsal reads replicas only."
  fi
  size=$(psql "$src" -XAtqc "select pg_size_pretty(pg_database_size(current_database()))")
  echo "source: $SOURCE_DB on $SOURCE_HOST (a replica), $size"

  n=0
  while :; do
    n=$((n + 1))
    dropdb --if-exists -h "$SOCK" -U postgres "$DB"
    createdb -h "$SOCK" -U postgres -O "$APP_ROLE" "$DB"
    if pg_dump "$src" --format=custom --no-owner --no-privileges --no-publications \
      --no-subscriptions --no-security-labels 2> "$WORK/dump.err" |
      pg_restore -h "$SOCK" -U postgres --role="$APP_ROLE" --no-owner --no-privileges \
        --exit-on-error -d "$DB" 2> "$WORK/restore.err"; then
      break
    fi
    if [ "$n" -lt 3 ] && grep -q 'conflict with recovery' "$WORK/dump.err"; then
      echo "copy attempt $n was cut off by replication on the replica; trying again"
      sleep 10
      continue
    fi
    echo "pg_dump:"
    redact < "$WORK/dump.err" | head -n 40
    echo "pg_restore:"
    redact < "$WORK/restore.err" | head -n 40
    fail "Could not copy production: $(first_error "$WORK/dump.err" "$WORK/restore.err")"
  done
  rm -f "$WORK"/*.err

  vacuumdb -h "$SOCK" -U postgres --analyze-only --quiet -d "$DB"
  tables=$(psql -h "$SOCK" -U postgres -d "$DB" -XAtqc \
    "select count(*) from pg_tables where schemaname = 'public'")
  applied=$(psql -h "$SOCK" -U postgres -d "$DB" -XAtqc \
    "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null" 2> /dev/null || echo 0)
  say "Copied production ($size, $tables tables, $applied migrations applied there) into $DB"
}

# ------------------------------------------------------------------ migrate
# As the HelmRelease's 02-migrate init container.
migrate() {
  app_env
  mkdir -p "$WORK"
  rc=0
  npx prisma migrate deploy > "$WORK/migrate.out" 2>&1 || rc=$?
  redact < "$WORK/migrate.out"
  applied=$(grep -oE 'Applying migration `[^`]+`' "$WORK/migrate.out" | sed -E 's/.*`([^`]+)`/\1/' || true)
  count=$(printf '%s\n' "$applied" | grep -c . || true)
  if [ "$rc" -ne 0 ]; then
    name=$(sed -n -E 's/^Migration name: (.+)$/\1/p' "$WORK/migrate.out" | head -n1)
    [ -n "$name" ] || name=$(printf '%s\n' "$applied" | tail -n1)
    [ -n "$name" ] || name="(none started)"
    err=$(awk '/^Database error:/ { getline; print; exit }' "$WORK/migrate.out" | sed -E 's/^ERROR: +//' | redact)
    [ -n "$err" ] || err=$(grep -m1 -E '^Error' -A3 "$WORK/migrate.out" | grep -v '^Error' | grep -m1 . | redact || true)
    [ -n "$err" ] || err="prisma migrate deploy exited $rc"
    fail "Migration $name failed on prod copy: $err"
  fi
  if [ "$count" -eq 0 ]; then
    say "No new migrations: production already has every migration in this build"
  else
    say "Applied $count new migration(s) to a copy of production: $(printf '%s\n' "$applied" | tr '\n' ' ')"
  fi
}

# ------------------------------------------------------------------ seed
# As the HelmRelease's 03-seed init container.
seed() {
  app_env
  mkdir -p "$WORK"
  rc=0
  node dist/seed/main.js > "$WORK/seed.out" 2>&1 || rc=$?
  redact < "$WORK/seed.out"
  if [ "$rc" -ne 0 ]; then
    # Fixed words: the seed's own last line could quote a row.
    fail "The seed failed on the migrated copy of production (step seed, exit $rc; see the log)"
  fi
  say "The seed ran on the migrated copy of production"
}

# ------------------------------------------------------------------ servers
# The api and worker as the HelmRelease runs them, on the migrated copy.
# Their output is redacted like everything else, a line at a time (sed
# alone holds a long-running server's output back until it exits).
redact_lines() {
  while IFS= read -r line; do printf '%s\n' "$line" | redact; done
}

api() {
  app_env
  export API_PORT="$1"
  node dist/main.js 2>&1 | redact_lines
}

# WORKER_JOBS=off asks the worker to start no queue processors and register
# no schedules (proposed for stockpile; ignored until it exists, when the
# readonly outbound mode and the network policy are what keep jobs inert).
worker() {
  app_env
  export WORKER_HEALTH_PORT="$1"
  export WORKER_JOBS=off
  node dist/worker/main.js 2>&1 | redact_lines
}

# ------------------------------------------------------------------ checks
ready() {
  # $1 what, $2 url, $3 seconds to wait, $4 seconds it must then stay ready
  node /rehearsal/probe.js "$@"
}

reads() {
  app_env
  node /rehearsal/schema-reads.js "$1"
}

passed() {
  say "Rehearsal passed"
}

step=$1
shift
"$step" "$@"
