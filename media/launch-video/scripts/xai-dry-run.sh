#!/usr/bin/env bash
set -euo pipefail

echo "DRY RUN ONLY — no xAI request is sent."
for prompt in prompts/xai/*.md; do
  echo
  echo "Prompt: $prompt"
  echo "xai-video generate --prompt-file $prompt --aspect-ratio 9:16 --resolution 720p --duration-seconds 4 --dry-run"
done
