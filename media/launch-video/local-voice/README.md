# Local voice generation

This folder keeps the reusable `PTT VOICE` workflow local to the launch-video
package. It uses MLX-Audio with the Qwen3-TTS 1.7B Base model, so inference runs
on Apple Silicon and the reference recording is not uploaded to a voice service.

## Install

From this folder:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

The environment, model inputs, and rendered audio are ignored by Git. The first
generation downloads the model into the local Hugging Face cache; later runs can
operate without a model download.

## Profile layout

Create `profiles/ptt-voice/profile.json` and place its reference recording beside
it. The manifest format is:

```json
{
  "name": "PTT VOICE",
  "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
  "language": "English",
  "reference_audio": "reference.wav",
  "reference_text": "Exact transcript of reference.wav"
}
```

Keep the transcript verbatim. A clean reference with one speaker and little
music produces a more stable clone.

## Generate

Inspect the exact local commands without generating audio:

```sh
.venv/bin/python ptt_voice.py generate \
  --profile "PTT VOICE" \
  --text "Sol Ultra Gearbox verifies what actually ran." \
  --output outputs/smoke.wav \
  --dry-run
```

Generate the locked English launch narration:

```sh
.venv/bin/python ptt_voice.py generate \
  --profile "PTT VOICE" \
  --text-file scripts/launch-en.txt \
  --output outputs/sol-ultra-gearbox-launch-en.wav
```

The final file is normalized to mono 48 kHz, 24-bit PCM WAV for video editing.
