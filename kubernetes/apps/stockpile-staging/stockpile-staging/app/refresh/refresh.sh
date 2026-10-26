#!/bin/sh
# Shadow staging's nightly refresh (stockpile#331), one subcommand per step
# of the CronJob stockpile-staging-refresh (../refresh-cronjob.yaml).
# Mounted from the ConfigMap stockpile-staging-refresh at /refresh.
#
#   precheck the staging api image has staging mode and a scrub tool that
#            loads and refuses correctly (see precheck). Runs FIRST: without
#            them, nothing of production is read at all.
#   dump     production's stockpile database, from a READ REPLICA, as the
#            migration rehearsal's read-only role, to /work (the pod's own
#            disk).
#   restore  the dump into a fresh scratch database, stockpile_staging_next,
#            owned by the refresh role. The staging app's role cannot open
#            it: pg_hba admits that role to stockpile_staging only, and the
#            database's CONNECT is revoked from PUBLIC. The dump file is
#            deleted as this step exits, whatever happened.
#   migrate  the staging image's migrations on the scratch copy (as the
#            api's init chain does), so the scrub sees its own schema.
#   scrub    the staging image's own scrub tool on the scratch copy:
#            personal data replaced, production's sealed secrets deleted,
#            test users made.
#   stop     staging's api and worker scaled to 0.
#   swap     the scratch copy handed to the app's role and renamed into
#            place in ONE transaction (stockpile_staging -> _old, _next ->
#            stockpile_staging); _old dropped after. If ANY step before it
#            failed, it drops stockpile_staging_next instead.
#   start    staging's settings checked (OUTBOUND_MODE=readonly), a fresh
#            Redis if the copy changed, then the api (its init chain
#            migrates, a no-op now, and seeds) and the worker.
#
# Failures: `precheck` and `dump` stop the Job outright (no copy exists
# yet; `dump` deletes its partial file). From `restore` on, a step that
# fails records it in /work/failed and exits 0, and every later step but
# `swap` and `start` steps aside. So the scratch copy never outlives a
# failed night: `swap` drops it (and `restore` already drops it on its own
# failure). Staging keeps running on yesterday's copy; if it had been
# stopped, `start` brings it back, then fails the Job. The one exception is
# `start`'s own settings check: if OUTBOUND_MODE isn't readonly, staging
# stays down. A pod killed outright (the Job's deadline) runs no cleanup;
# the next night's `restore` drops the leftover first.
#
# The data is production's until the scrub has run. Nothing here prints
# its rows: sizes and counts only, and tool output through `redact`
# (PostgreSQL errors can quote row values). $VAR only, never the braced
# form: Flux substitution is off for this ConfigMap, and this keeps it so.
set -eu
set -o pipefail

WORK=/work
DUMP=$WORK/stockpile.dump
NS=stockpile-staging
RELEASE=stockpile-staging
DB=stockpile_staging
NEXT=stockpile_staging_next
OLD=stockpile_staging_old
FAILED=$WORK/failed

redact() {
  sed -E \
    -e '/DbError \{/c\  (database error details removed: they can quote row data)' \
    -e 's/^([[:space:]]*([a-z_]+: )?)(DETAIL|CONTEXT|WHERE):.*/\1\3: (removed: can quote row data)/' \
    -e 's/Key \(([^)]*)\)=\(.*\)/Key (\1)=(redacted)/g' \
    -e 's/Failing row contains .*/Failing row contains (redacted)/g' \
    -e '/invalid input|out of range|malformed|could not (convert|parse)|is not a valid|violates/s/"[^"]*"/"(redacted)"/g' \
    -e 's#postgres(ql)?://[^@[:space:]]*@#postgresql://(redacted)@#g'
}

first_error() {
  cat "$@" 2> /dev/null | grep -m1 -E 'ERROR|FATAL|[Ee]rror:' | redact | tr -s ' \t' ' ' | cut -c1-220
}

fail() {
  echo "FAILED: $1" >&2
  exit 1
}

# From `restore` on: note the failure and let `swap` clean up and `start`
# report it.
soft_fail() {
  echo "FAILED: $1" >&2
  printf '%s\n' "$1" >> "$FAILED"
  exit 0
}

# An earlier step failed: this one does nothing.
skip_if_failed() {
  if [ -s "$FAILED" ]; then
    echo "skipped: an earlier step failed"
    exit 0
  fi
}

# Production's raw rows never stay on this pod's disk past the step that
# needs them.
drop_dump() {
  rm -f "$DUMP" "$WORK"/*.err "$WORK"/*.out
}

# The refresh role on the primary's maintenance database, or on $1.
refresh_conn() {
  echo "host=postgres-rw.databases.svc.cluster.local port=5432 dbname=$1 user=$REFRESH_USER sslmode=require connect_timeout=15 application_name=stockpile-staging-refresh"
}

q() {
  db=$1
  shift
  PGPASSWORD=$REFRESH_PASSWORD psql "$(refresh_conn "$db")" -X -q -A -t -v ON_ERROR_STOP=1 "$@"
}

have_db() {
  q postgres -c "select count(*) from pg_database where datname = '$1'"
}

drop_next() {
  if [ "$(have_db "$NEXT" 2> /dev/null || echo unknown)" = 0 ]; then
    return 0
  fi
  if q postgres -c "drop database if exists $NEXT" 2> "$WORK/drop.err"; then
    echo "dropped the scratch copy $NEXT"
  else
    echo "WARNING: could not drop $NEXT ($(first_error "$WORK/drop.err")); the next run drops it first" >&2
  fi
  rm -f "$WORK/drop.err"
}

# ------------------------------------------------------------------ precheck
# Runs in the staging api image (the same tag as the migrate and scrub
# steps and the api itself), before anything of production is read.
precheck() {
  export HOME=/tmp
  rm -f "$FAILED"
  grep -rqs -e STAGING_LOGIN_TOKEN dist && grep -rqs -e STAGING_SCHEDULES dist ||
    fail "this image has no staging mode (STAGING_LOGIN_TOKEN / STAGING_SCHEDULES): it needs a Stockpile main build that ships it. Nothing read from production."
  [ -f dist/tools/staging-scrub.js ] ||
    fail "this image has no dist/tools/staging-scrub.js: it needs a Stockpile main build that ships it. Nothing read from production."
  # The tool must load, and refuse: run WITHOUT --confirm-staging-scrub and
  # with a made-up SCRUB_DATABASE_URL that resolves nowhere, it exits 2 (its
  # refusal code) before connecting. Anything else (a load error is 1, a
  # run would be 0) means this isn't the tool the refresh expects.
  rc=0
  SCRUB_DATABASE_URL="postgresql://x:y@scrub-check.invalid/precheck_staging" \
    node dist/tools/staging-scrub.js > "$WORK/check.out" 2>&1 || rc=$?
  if [ "$rc" -ne 2 ]; then
    redact < "$WORK/check.out" | tail -n 20
    rm -f "$WORK/check.out"
    fail "staging-scrub.js did not refuse a run without --confirm-staging-scrub (exit $rc, expected 2). Nothing read from production."
  fi
  rm -f "$WORK/check.out"
  echo "precheck: staging mode and the scrub tool are in this image"
}

# ------------------------------------------------------------------ dump
dump() {
  : "$SOURCE_HOST" "$SOURCE_DB" "$SOURCE_USER" "$SOURCE_PASSWORD"
  # Kept only if the dump succeeds.
  trap 'rc=$?; [ "$rc" -eq 0 ] || drop_dump' EXIT
  export PGPASSWORD="$SOURCE_PASSWORD"
  src="host=$SOURCE_HOST port=5432 dbname=$SOURCE_DB user=$SOURCE_USER sslmode=require connect_timeout=15 application_name=stockpile-staging-refresh options='-c default_transaction_read_only=on'"
  mkdir -p "$WORK"

  standby=$(psql "$src" -XAtqc "select pg_is_in_recovery()" 2> "$WORK/src.err") ||
    fail "could not reach a production database replica: $(first_error "$WORK/src.err")"
  [ "$standby" = t ] || fail "refused: $SOURCE_HOST answered from the primary; the refresh reads replicas only."
  size=$(psql "$src" -XAtqc "select pg_size_pretty(pg_database_size(current_database()))")
  echo "source: $SOURCE_DB on $SOURCE_HOST (a replica), $size"

  n=0
  while :; do
    n=$((n + 1))
    if pg_dump "$src" --format=custom --no-owner --no-privileges --no-publications \
      --no-subscriptions --no-security-labels --no-comments -f "$DUMP" 2> "$WORK/dump.err"; then
      break
    fi
    if [ "$n" -lt 3 ] && grep -q 'conflict with recovery' "$WORK/dump.err"; then
      echo "dump attempt $n was cut off by replication on the replica; trying again"
      sleep 10
      continue
    fi
    redact < "$WORK/dump.err" | head -n 40
    fail "could not dump production: $(first_error "$WORK/dump.err")"
  done
  rm -f "$WORK"/*.err
  echo "dumped: $(du -h "$DUMP" | cut -f1)"
}

# ------------------------------------------------------------------ restore
restore() {
  : "$REFRESH_USER" "$REFRESH_PASSWORD"
  # The dump goes as this step exits, whatever happened; on a failure, so
  # does the scratch copy.
  trap 'rc=$?; drop_dump; if [ "$rc" -ne 0 ] || [ -s "$FAILED" ]; then drop_next; fi' EXIT
  skip_if_failed
  [ -s "$DUMP" ] || soft_fail "no dump to restore"

  primary=$(q postgres -c "select not pg_is_in_recovery()" 2> "$WORK/q.err") ||
    soft_fail "could not reach the database primary as $REFRESH_USER: $(first_error "$WORK/q.err")"
  [ "$primary" = t ] || soft_fail "refused: postgres-rw answered from a replica"

  [ "$(have_db "$DB")" = 1 ] ||
    soft_fail "$DB does not exist (CNPG's Database object stockpile-staging creates it); nothing changed."
  # Leftovers of an earlier night: _old is yesterday's copy after a swap
  # whose drop failed; _next an unfinished scratch copy.
  if [ "$(have_db "$OLD")" = 1 ]; then
    q postgres -c "drop database $OLD" 2> "$WORK/q.err" ||
      soft_fail "could not drop the leftover $OLD: $(first_error "$WORK/q.err")"
  fi
  if [ "$(have_db "$NEXT")" = 1 ]; then
    q postgres -c "drop database $NEXT" 2> "$WORK/q.err" ||
      soft_fail "could not drop the leftover $NEXT: $(first_error "$WORK/q.err")"
  fi

  # Owned by the refresh role, no CONNECT for PUBLIC: until the swap, the
  # app's role has no way in (and pg_hba refuses it this name besides).
  q postgres -c "create database $NEXT owner $REFRESH_USER template template0" 2> "$WORK/q.err" ||
    soft_fail "could not create $NEXT: $(first_error "$WORK/q.err")"
  q postgres -c "revoke all on database $NEXT from public" 2> "$WORK/q.err" ||
    soft_fail "could not close $NEXT to PUBLIC: $(first_error "$WORK/q.err")"

  if ! PGPASSWORD=$REFRESH_PASSWORD pg_restore --no-owner --no-privileges --no-comments --exit-on-error \
    -d "$(refresh_conn "$NEXT")" "$DUMP" 2> "$WORK/restore.err"; then
    redact < "$WORK/restore.err" | grep -E 'ERROR|FATAL|error' | head -n 5 || true
    soft_fail "could not restore into $NEXT: $(first_error "$WORK/restore.err"). Staging keeps yesterday's copy."
  fi
  q "$NEXT" -c "analyze"
  tables=$(q "$NEXT" -c "select count(*) from pg_tables where schemaname = 'public'")
  echo "restored into $NEXT: $tables tables (the app's role cannot open it)"
}

# ------------------------------------------------------------------ migrate
# Runs in the staging api image, DATABASE_URL = the scratch copy, taken
# from the environment (NEXT_DATABASE_URL, from a Secret), never argv.
migrate() {
  : "$NEXT_DATABASE_URL"
  skip_if_failed
  export DATABASE_URL="$NEXT_DATABASE_URL" HOME=/tmp
  rc=0
  npx prisma migrate deploy > "$WORK/migrate.out" 2>&1 || rc=$?
  redact < "$WORK/migrate.out" | grep -E 'migration|Migration|Error|error' | head -n 40 || true
  rm -f "$WORK/migrate.out"
  [ "$rc" -eq 0 ] || soft_fail "migrations failed on $NEXT (exit $rc). Staging keeps yesterday's copy."
  echo "migrated $NEXT to this image's schema"
}

# ------------------------------------------------------------------ scrub
# Runs in the staging api image: the SAME tag as the api and worker. The
# tool reads SCRUB_DATABASE_URL (the scratch copy, as the refresh role) from
# this container's environment (the pod spec, from a Secret): no address or
# password is ever in argv. STOCKPILE_ENV=staging comes from the ConfigMap.
scrub() {
  : "$SCRUB_DATABASE_URL" "$STOCKPILE_ENV"
  skip_if_failed
  export HOME=/tmp
  rc=0
  node dist/tools/staging-scrub.js --confirm-staging-scrub > "$WORK/scrub.out" 2>&1 || rc=$?
  redact < "$WORK/scrub.out" | tail -n 60
  rm -f "$WORK/scrub.out"
  [ "$rc" -eq 0 ] || soft_fail "the scrub exited $rc. Nothing swapped: staging keeps yesterday's copy."
  echo "scrubbed $NEXT"
}

# ------------------------------------------------------------------ stop
stop() {
  skip_if_failed
  sel="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/controller in (api,worker)"
  touch "$WORK/stopped"
  kubectl -n "$NS" scale deployment "$RELEASE-api" "$RELEASE-worker" --replicas=0 ||
    soft_fail "could not scale the api and worker down; nothing swapped."
  kubectl -n "$NS" wait pod --for=delete --timeout=300s -l "$sel" || true
  left=$(kubectl -n "$NS" get pod -o name -l "$sel" | wc -l)
  [ "$left" -eq 0 ] || soft_fail "the api or worker didn't stop within 5 minutes; nothing swapped."
  echo "api and worker stopped"
}

# ------------------------------------------------------------------ swap
swap() {
  : "$REFRESH_USER" "$REFRESH_PASSWORD"
  drop_dump
  # Any failure up to here, or in here before the rename commits: the
  # scratch copy goes.
  trap 'rc=$?; if [ "$rc" -ne 0 ] || [ -s "$FAILED" ]; then drop_next; fi' EXIT
  skip_if_failed
  # Everything in the copy (and the database itself) to the app's role.
  q "$NEXT" -c "reassign owned by $REFRESH_USER to $DB" 2> "$WORK/q.err" ||
    soft_fail "could not hand $NEXT to $DB: $(first_error "$WORK/q.err"); nothing swapped."
  # One transaction: both names move, or neither does. A session still on
  # stockpile_staging (say, a pod Helm brought back) makes it refuse.
  q postgres -1 \
    -c "alter database $DB rename to $OLD" \
    -c "alter database $NEXT rename to $DB" 2> "$WORK/q.err" ||
    soft_fail "could not swap the copy in: $(first_error "$WORK/q.err"); staging keeps yesterday's copy."
  echo "swapped: $DB is tonight's scrubbed copy"
  touch "$WORK/swapped"
  q postgres -c "drop database $OLD" 2> "$WORK/q.err" ||
    echo "note: could not drop $OLD yet ($(first_error "$WORK/q.err")); the next run drops it"
}

# ------------------------------------------------------------------ start
start() {
  drop_dump
  # Nothing was stopped: staging never left yesterday's copy.
  if [ ! -f "$WORK/stopped" ]; then
    [ -s "$FAILED" ] && fail "staging was not touched and keeps YESTERDAY's copy: $(head -n 1 "$FAILED")"
    fail "staging was not touched (no step stopped it)"
  fi
  # Fail closed: the settings every staging container loads must still say
  # readonly, or staging stays down.
  mode=$(kubectl -n "$NS" get configmap "$RELEASE-env" -o jsonpath='{.data.OUTBOUND_MODE}')
  envname=$(kubectl -n "$NS" get configmap "$RELEASE-env" -o jsonpath='{.data.STOCKPILE_ENV}')
  if [ "$mode" != readonly ] || [ "$envname" != staging ]; then
    fail "refused to start staging: $RELEASE-env has OUTBOUND_MODE='$mode' STOCKPILE_ENV='$envname' (need readonly / staging)."
  fi
  if [ -f "$WORK/swapped" ]; then
    # No BullMQ job from yesterday's copy survives.
    kubectl -n "$NS" rollout restart deployment "$RELEASE-redis"
    kubectl -n "$NS" rollout status deployment "$RELEASE-redis" --timeout=300s
  fi
  kubectl -n "$NS" scale deployment "$RELEASE-api" "$RELEASE-worker" --replicas=1
  kubectl -n "$NS" rollout status deployment "$RELEASE-api" --timeout=900s
  kubectl -n "$NS" rollout status deployment "$RELEASE-worker" --timeout=900s
  if [ -s "$FAILED" ]; then
    fail "staging is back up on YESTERDAY's copy: $(head -n 1 "$FAILED")"
  fi
  echo "staging is up on last night's scrubbed copy"
}

step=$1
shift
"$step" "$@"
