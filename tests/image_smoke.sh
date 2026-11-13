#!/usr/bin/env bash
# Smoke test of a built server image (server/Dockerfile). Docker and jq required; nothing is pushed
# and no container reaches a network (--network none).
#
#   tests/image_smoke.sh <image> [<expected 40-hex revision>]
#
# Checks, in order:
#   1. image config: OCI labels (source, licenses, title, description; revision when given),
#      numeric non-root user 1000:1000, NODE_ENV=production, no NODE_OPTIONS, the entrypoint
#      `node server/dist/index.js`, workdir /app, port 8080;
#   2. file system: /app holds exactly node_modules, server, shared and static; the server entry,
#      its room worker and the client bundle are there; no dev dependency, test or source tree;
#      no package manager; nothing under /app is writable by the runtime user;
#   3. refusals: the server does not start with --max-old-space-size (NODE_OPTIONS or the command
#      line) nor with WORKER_TEST_HOOKS under the image's NODE_ENV=production;
#   4. a start the way the chart runs it (read-only root filesystem, writable /tmp, no capabilities,
#      no privilege escalation) with placeholder settings: /healthz 200 (also through the busybox
#      wget the compose health check uses), the client bundle served, /metrics 404 on the public
#      listener and 200 on the internal one, PID 1 running as 1000:1000, no file written.
# The placeholder gate and S3 endpoints point at a closed local port: none of the checks needs them.
set -euo pipefail

image="${1:?usage: $0 <image> [<expected revision>]}"
want_rev="${2:-}"
fail() { echo "FAIL: $*" >&2; exit 1; }
command -v jq >/dev/null || fail "jq is required"

containers=()
cleanup() { for c in ${containers[@]+"${containers[@]}"}; do docker rm -f "$c" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

# ---- 1. image config ----------------------------------------------------------------------------
cfg="$(docker image inspect --format '{{json .Config}}' "$image")"
label() { jq -r --arg k "$1" '.Labels[$k] // ""' <<<"$cfg"; }
src="$(label org.opencontainers.image.source)"
rev="$(label org.opencontainers.image.revision)"
[[ "$src" == https://* ]] || fail "label org.opencontainers.image.source is '$src', expected an https URL"
[ "$(label org.opencontainers.image.licenses)" = "Apache-2.0" ] || fail "label org.opencontainers.image.licenses is not Apache-2.0"
[ "$(label org.opencontainers.image.title)" = "artifacts-canvas-server" ] || fail "label org.opencontainers.image.title is not artifacts-canvas-server"
[ -n "$(label org.opencontainers.image.description)" ] || fail "label org.opencontainers.image.description is empty"
if [ -n "$want_rev" ]; then
  [[ "$want_rev" =~ ^[0-9a-f]{40}$ ]] || fail "expected revision '$want_rev' is not a 40-hex commit"
  [ "$rev" = "$want_rev" ] || fail "label org.opencontainers.image.revision is '$rev', expected '$want_rev'"
fi
user="$(jq -r '.User // ""' <<<"$cfg")"
[ "$user" = "1000:1000" ] || fail "image user is '$user', expected 1000:1000"
jq -e '.Env | index("NODE_ENV=production")' <<<"$cfg" >/dev/null || fail "NODE_ENV=production is not set"
if jq -e '.Env | map(select(startswith("NODE_OPTIONS="))) | length > 0' <<<"$cfg" >/dev/null; then
  fail "the image sets NODE_OPTIONS"
fi
entry="$(jq -c '[.Entrypoint, .Cmd]' <<<"$cfg")"
[ "$entry" = '[["node","server/dist/index.js"],null]' ] || fail "entrypoint/cmd is $entry, expected node server/dist/index.js and no cmd"
[ "$(jq -r '.WorkingDir' <<<"$cfg")" = "/app" ] || fail "workdir is not /app"
jq -e '.ExposedPorts["8080/tcp"]' <<<"$cfg" >/dev/null || fail "port 8080 is not exposed"
echo "config: source=$src revision=${rev:-<empty>} licenses=Apache-2.0; user=$user; NODE_ENV=production, no NODE_OPTIONS; entrypoint=$(jq -c .Entrypoint <<<"$cfg")"

# ---- 2. file system -----------------------------------------------------------------------------
# Not read-only here: with a read-only root every write check would pass for the wrong reason.
facts_js='
const fs = require("fs"), path = require("path");
const has = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const writable = [];
const canWrite = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
let entries = 0;
(function walk(d) {
  if (canWrite(d)) writable.push(d);
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    entries++;
    if (e.isDirectory()) walk(p);
    else if (!e.isSymbolicLink() && canWrite(p)) writable.push(p);
  }
})("/app");
console.log(JSON.stringify({
  ids: [process.getuid(), process.getgid()],
  app: fs.readdirSync("/app").sort(),
  entries,
  writable: writable.slice(0, 5),
  present: ["/app/server/dist/index.js", "/app/server/dist/room-worker.js", "/app/shared/dist/index.js",
            "/app/node_modules/@pocharlies/artifacts-canvas-shared/package.json",
            "/app/static/index.html", "/app/static/reporter.js"].filter((p) => !fs.existsSync(p)),
  dev: ["typescript", "vite", "vitest", "tsx", "s3rver", "@playwright/test", "@types/node"]
         .filter((m) => has("/app/node_modules/" + m)),
  trees: ["/app/server/src", "/app/server/test", "/app/shared/src", "/app/client", "/app/e2e-system",
          "/app/tests", "/app/package-lock.json", "/app/.git"].filter(has),
  pm: ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn",
       "/usr/local/lib/node_modules/npm"].filter(has),
}));'
facts="$(docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node "$image" -e "$facts_js")"
jq -e '.ids == [1000, 1000]' <<<"$facts" >/dev/null || fail "a process in the image runs as $(jq -c .ids <<<"$facts"), expected [1000,1000]"
jq -e '.app == ["node_modules", "server", "shared", "static"]' <<<"$facts" >/dev/null \
  || fail "/app holds $(jq -c .app <<<"$facts"), expected node_modules, server, shared, static"
for k in present dev trees pm writable; do
  jq -e --arg k "$k" '.[$k] == []' <<<"$facts" >/dev/null || case "$k" in
    present)  fail "missing in the image: $(jq -c .present <<<"$facts")" ;;
    dev)      fail "dev dependencies in the image: $(jq -c .dev <<<"$facts")" ;;
    trees)    fail "source, test or build files in the image: $(jq -c .trees <<<"$facts")" ;;
    pm)       fail "package manager in the image: $(jq -c .pm <<<"$facts")" ;;
    writable) fail "writable by the runtime user: $(jq -c .writable <<<"$facts")" ;;
  esac
done
echo "/app: $(jq -c .app <<<"$facts"), $(jq .entries <<<"$facts") entries, none writable by uid 1000; no dev dependency, test tree or package manager"

# ---- 3. refusals --------------------------------------------------------------------------------
# Placeholder settings: enough for the config to load; the endpoints are a closed local port.
dummy_env=(
  -e GATE_AUTHZ_URL=http://127.0.0.1:9/_gate/plugin/authz
  -e ARTIFACT_BASE_URL=http://127.0.0.1:9/artifacts
  -e S3_ENDPOINT=http://127.0.0.1:9 -e S3_BUCKET=artifacts
  -e S3_ACCESS_KEY_ID=smoke-canvas -e S3_SECRET_ACCESS_KEY=placeholder
  -e HEAP_LIMIT_MB=816
)
chart_opts=(--network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges)
run_bg() { # <name> <docker run args...>: start detached, remember it for cleanup
  local n="$1"; shift
  containers+=("$n")
  docker run -d --name "$n" "${chart_opts[@]}" "${dummy_env[@]}" "$@" >/dev/null
}
refuses() { # <what> <expected message> <docker run args...>
  local what="$1" msg="$2"; shift 2
  local n="canvas-smoke-$$-${#containers[@]}" state="" rc logs
  run_bg "$n" "$@"
  for _ in $(seq 1 30); do
    state="$(docker inspect --format '{{.State.Status}}' "$n")"
    [ "$state" = exited ] && break
    sleep 1
  done
  rc="$(docker inspect --format '{{.State.ExitCode}}' "$n")"
  logs="$(docker logs "$n" 2>&1)"
  [ "$state" = exited ] || { echo "$logs" >&2; fail "$what: the server still runs after 30 s, expected it to refuse"; }
  [ "$rc" != 0 ] || { echo "$logs" >&2; fail "$what: exited 0, expected a refusal"; }
  grep -qF -- "$msg" <<<"$logs" || { echo "$logs" >&2; fail "$what: exited $rc without the expected message '$msg'"; }
  echo "refused: $what (exit $rc: '$msg')"
}
refuses "NODE_OPTIONS=--max-old-space-size=512" "--max-old-space-size is set" \
  -e NODE_OPTIONS=--max-old-space-size=512 "$image"
refuses "node --max-old-space-size=512 on the command line" "--max-old-space-size is set" \
  --entrypoint node "$image" --max-old-space-size=512 server/dist/index.js
refuses "WORKER_TEST_HOOKS=true under the image's NODE_ENV" "WORKER_TEST_HOOKS is set with NODE_ENV=production" \
  -e WORKER_TEST_HOOKS=true "$image"

# ---- 4. a start the way the chart runs it -------------------------------------------------------
name="canvas-smoke-$$-run"
run_bg "$name" "$image"
status() { # <url> -> HTTP status from inside the container (0 when unreachable)
  docker exec "$name" node -e 'fetch(process.argv[1]).then((r) => console.log(r.status), () => console.log(0))' "$1"
}
up=""
for _ in $(seq 1 30); do
  [ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] \
    || { docker logs "$name" >&2; fail "the server exited"; }
  [ "$(status http://127.0.0.1:8080/healthz)" = 200 ] && { up=1; break; }
  sleep 1
done
[ -n "$up" ] || { docker logs "$name" >&2; fail "/healthz never answered 200"; }
for check in "8080 /healthz 200" "8080 /_canvas/_/index.html 200" "8080 /_canvas/_/reporter.js 200" \
             "8080 /metrics 404" "9091 /metrics 200"; do
  read -r port path want <<<"$check"
  got="$(status "http://127.0.0.1:$port$path")"
  [ "$got" = "$want" ] || { docker logs "$name" >&2; fail "GET :$port$path answered $got, expected $want"; }
  echo "GET :$port$path -> $got"
done
[ "$(docker exec "$name" wget -qO- http://127.0.0.1:8080/healthz)" = '{"ok":true}' ] \
  || fail "busybox wget (the compose health check) did not get /healthz"
ids="$(docker exec "$name" awk '/^Uid:|^Gid:/ {print $2}' /proc/1/status | paste -sd' ' -)"
[ "$ids" = "1000 1000" ] || fail "PID 1 runs as uid/gid '$ids', expected 1000 1000"
changed="$(docker diff "$name")"
[ -z "$changed" ] || fail "files written in the container: $changed"
grep -q 'artifacts-canvas server listening' <<<"$(docker logs "$name" 2>&1)" || fail "no listening line in the logs"
echo "PID 1 uid/gid: $ids; read-only root filesystem, no file written; wget health check ok"
echo "OK: $image"
