#!/usr/bin/env bash
set -euo pipefail

APP_ID="581330"
GAME_ROOT="/home/steam/steamcmd/sandstorm"
APPS_DIR="${GAME_ROOT}/steamapps"
MANIFEST="${APPS_DIR}/appmanifest_${APP_ID}.acf"

have_server_binary() {
  [[ -x "${GAME_ROOT}/Insurgency/Binaries/Linux/InsurgencyServer-Linux-Shipping" ]]
}

get_manifest_val() {
  local key="$1"
  if [[ -f "${MANIFEST}" ]]; then
    # Extract the value for a key like "StateFlags" "6"
    grep -Po "\"${key}\"\\s*\"\\K[^\"]+" "${MANIFEST}" | head -n1 || true
  fi
}

log() {
  echo "[heal] $*"
}

main() {
  local stuck_reason=""

  if [[ -f "${MANIFEST}" ]]; then
    local stateflags updateresult buildid targetbuildid
    stateflags="$(get_manifest_val StateFlags || true)"
    updateresult="$(get_manifest_val UpdateResult || true)"
    buildid="$(get_manifest_val buildid || true)"
    targetbuildid="$(get_manifest_val TargetBuildID || true)"

    # Heuristic for stuck / incomplete installs
    if [[ "${stateflags:-}" == "6" ]]; then
      stuck_reason="StateFlags=6"
    fi
    if [[ -n "${updateresult:-}" && "${updateresult}" != "0" ]]; then
      stuck_reason="${stuck_reason:+${stuck_reason},}UpdateResult=${updateresult}"
    fi
    if [[ -n "${buildid:-}" && -n "${targetbuildid:-}" && "${buildid}" != "${targetbuildid}" ]]; then
      stuck_reason="${stuck_reason:+${stuck_reason},}buildid!=TargetBuildID"
    fi

    # Healthy installs are a no-op
    if [[ -z "${stuck_reason}" ]]; then
      log "Steam install looks healthy (StateFlags=${stateflags:-?}, UpdateResult=${updateresult:-?}, buildid=${buildid:-?}, target=${targetbuildid:-?}); skipping."
      return 0
    fi
  else
    # Manifest missing: if critical server binary is also missing, treat as incomplete
    if ! have_server_binary; then
      stuck_reason="manifest-missing-and-server-binary-missing"
    fi
  fi

  if [[ -z "${stuck_reason}" ]]; then
    log "No stuck steam state detected; skipping."
    return 0
  fi

  log "Detected stuck steam state: ${stuck_reason}; cleaning and running validate..."
  mkdir -p "${APPS_DIR}"
  rm -f "${MANIFEST}" || true
  rm -rf "${APPS_DIR}/downloading" "${APPS_DIR}/temp" || true

  local steamcmd_bin
  if [[ -x "/home/steam/steamcmd/steamcmd.sh" ]]; then
    steamcmd_bin="/home/steam/steamcmd/steamcmd.sh"
  else
    steamcmd_bin="steamcmd"
  fi

  "${steamcmd_bin}" +login anonymous +force_install_dir "${GAME_ROOT}" +app_update "${APP_ID}" validate +quit
  log "Steam heal completed."
}

main "$@"

