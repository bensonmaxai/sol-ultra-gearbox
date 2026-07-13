#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
XAI_VIDEO_SCRIPT="${XAI_VIDEO_SCRIPT:-$CODEX_HOME/skills/xai-video-generation/scripts/xai_video.py}"

if [[ ! -f "$XAI_VIDEO_SCRIPT" ]]; then
  echo "xAI video helper not found: set XAI_VIDEO_SCRIPT or CODEX_HOME" >&2
  exit 1
fi

run_dry_run() {
  local image_path="$1"
  local prompt_path="$2"
  local output_path="$3"
  local manifest_path="$4"

  python3 "$XAI_VIDEO_SCRIPT" generate \
    --prompt-file "$prompt_path" \
    --image "$image_path" \
    --duration 4 \
    --aspect-ratio 9:16 \
    --resolution 720p \
    --out "$output_path" \
    --manifest "$manifest_path" \
    --dry-run
}

echo "DRY RUN ONLY — three local request validations; no xAI network request is sent."
run_dry_run public/generated/routing-background.png prompts/xai/01-gear-data-streams.md public/xai/gear-routing.mp4 receipts/gear-routing.json
run_dry_run public/generated/fail-closed-background.png prompts/xai/02-fail-closed-gate.md public/xai/fail-closed-gate.mp4 receipts/fail-closed-gate.json
run_dry_run public/generated/rollback-background.png prompts/xai/03-rollback-clean-state.md public/xai/rollback-clean-state.mp4 receipts/rollback-clean-state.json
