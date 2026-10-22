#!/bin/sh
# Shadow staging's nightly refresh (stockpile#331), one subcommand per step
# of the CronJob stockpile-staging-refresh (../refresh-cronjob.yaml).
# Mounted from the ConfigMap stockpile-staging-refresh at /refresh.
#
#   dump     production's stockpile database, from a READ REPLICA, as the
#            migration rehearsal's read-only role, to /work (the pod's own
#            disk). Staging keeps running meanwhile.
#   stop     staging's api and worker scaled to 0, waited out.
#   restore  the dump put in place of stockpile_staging's contents and
#            scrubbed (refresh.sql), in one transaction, as the staging
#            database's owner.
#   start    a fresh Redis (no job from yesterday's copy), then the api (its
#            init chain migrates the copy to this image's schema and seeds)
#            and the worker.
#
# A step that fails stops the Job there. Before `stop`, staging keeps
# yesterday's copy, up. After it, staging stays DOWN on yesterday's scrubbed
# copy (the restore is all or nothing) until the next run or a manual one —
# never up on a half copy, never on an unscrubbed one.
#
# The data is production's. Nothing here prints its rows: sizes and counts
# only, and tool output through `redact` (PostgreSQL errors can quote row
# values). $VAR only, never the braced form: Flux substitution is off for
# this ConfigMap, and this keeps it so.
set -eu
set -o pipefail

WORK=/work
NS=stockpile-staging
RELEASE=stockpile-staging

redact() {
  sed -E \
    -e 's/^([[:space:]]*([a-z_]+: )?)(DETAIL|CONTEXT|WHERE):.*/\1\3: (removed: can quote row data)/' \
    -e 's/Key \(([^)]*)\)=\(.*\)/Key (\1)=(redacted)/g' \
    -e 's/Failing row contains .*/Failing row contains (redacted)/g' \
    -e '/invalid input|out of range|malformed|could not (convert|parse)|is not a valid|violates/s/"[^"]*"/"(redacted)"/g'
}

first_error() {
  cat "$@" 2> /dev/null | grep -m1 -E 'ERROR|FATAL|error:' | redact | tr -s ' \t' ' ' | cut -c1-220
}

fail() {
  echo "FAILED: $1" >&2
  exit 1
}

# ------------------------------------------------------------------ dump
dump() {
  : "$SOURCE_HOST" "$SOURCE_DB" "$SOURCE_USER" "$SOURCE_PASSWORD"
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
      --no-subscriptions --no-security-labels --no-comments -f "$WORK/stockpile.dump" 2> "$WORK/dump.err"; then
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
  echo "dumped: $(du -h "$WORK/stockpile.dump" | cut -f1)"
}

# ------------------------------------------------------------------ stop
stop() {
  kubectl -n "$NS" scale deployment "$RELEASE-api" "$RELEASE-worker" --replicas=0
  kubectl -n "$NS" wait pod --for=delete --timeout=300s \
    -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/controller in (api,worker)" || true
  left=$(kubectl -n "$NS" get pod -o name -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/controller in (api,worker)" | wc -l)
  [ "$left" -eq 0 ] || fail "the api or worker didn't stop within 5 minutes; nothing restored."
  echo "api and worker stopped"
}

# ------------------------------------------------------------------ restore
restore() {
  : "$PGHOST" "$PGDATABASE" "$PGUSER" "$PGPASSWORD"
  [ -s "$WORK/stockpile.dump" ] || fail "no dump to restore"
  pg_restore --no-owner --no-privileges --no-comments -f "$WORK/restore.sql" "$WORK/stockpile.dump" 2> "$WORK/restore.err" ||
    fail "could not read the dump: $(first_error "$WORK/restore.err")"
  rc=0
  psql "host=$PGHOST dbname=$PGDATABASE sslmode=require connect_timeout=15 application_name=stockpile-staging-refresh" \
    -X -q -A -t -v ON_ERROR_STOP=1 --single-transaction -f /refresh/refresh.sql > "$WORK/psql.out" 2> "$WORK/psql.err" || rc=$?
  rm -f "$WORK/restore.sql"
  # Only the count line refresh.sql prints; never anything else of the data.
  grep -E '^copied and scrubbed: ' "$WORK/psql.out" || true
  if [ "$rc" -ne 0 ]; then
    redact < "$WORK/psql.err" | grep -E 'ERROR|FATAL' | head -n 5
    fail "the restore or the scrub failed and was rolled back: staging keeps yesterday's copy ($(first_error "$WORK/psql.err"))"
  fi
}

# ------------------------------------------------------------------ start
start() {
  kubectl -n "$NS" rollout restart deployment "$RELEASE-redis"
  kubectl -n "$NS" rollout status deployment "$RELEASE-redis" --timeout=300s
  kubectl -n "$NS" scale deployment "$RELEASE-api" "$RELEASE-worker" --replicas=1
  # The api's init chain migrates the copy to this image and seeds it.
  kubectl -n "$NS" rollout status deployment "$RELEASE-api" --timeout=900s
  kubectl -n "$NS" rollout status deployment "$RELEASE-worker" --timeout=900s
  echo "staging is up on last night's copy"
}

step=$1
shift
"$step" "$@"
