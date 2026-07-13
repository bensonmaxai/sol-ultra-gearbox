#!/usr/bin/env python3
"""Generate local narration from a reusable MLX-Audio voice profile."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


DEFAULT_PROFILES_DIR = Path(__file__).resolve().parent / "profiles"


class ProfileError(ValueError):
    """Raised when a local voice profile is invalid."""


@dataclass(frozen=True)
class VoiceProfile:
    name: str
    model: str
    language: str
    reference_audio: Path
    reference_text: str


def profile_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        raise ProfileError("Profile name must contain letters or numbers")
    return slug


def load_profile(profiles_dir: Path, profile_name: str) -> VoiceProfile:
    profile_dir = profiles_dir.resolve() / profile_slug(profile_name)
    manifest = profile_dir / "profile.json"
    if not manifest.is_file():
        raise ProfileError(f"Profile manifest not found: {manifest}")

    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProfileError(f"Invalid profile manifest: {manifest}: {exc}") from exc

    required = ("name", "model", "language", "reference_audio", "reference_text")
    missing = [key for key in required if not isinstance(data.get(key), str) or not data[key].strip()]
    if missing:
        raise ProfileError(f"Profile is missing required fields: {', '.join(missing)}")

    reference_audio = (profile_dir / data["reference_audio"]).resolve()
    if not reference_audio.is_file():
        raise ProfileError(f"Reference audio not found: {reference_audio}")

    return VoiceProfile(
        name=data["name"].strip(),
        model=data["model"].strip(),
        language=data["language"].strip(),
        reference_audio=reference_audio,
        reference_text=data["reference_text"].strip(),
    )


def read_generation_text(inline_text: str | None, text_file: Path | None) -> str:
    if inline_text is not None:
        text = inline_text.strip()
    elif text_file is not None:
        try:
            text = text_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ProfileError(f"Unable to read text file: {text_file}: {exc}") from exc
    else:
        raise ProfileError("A text source is required")
    if not text:
        raise ProfileError("Generation text must not be empty")
    return text


def build_generate_command(
    profile: VoiceProfile,
    text: str,
    native_dir: Path,
    file_prefix: str,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "mlx_audio.tts.generate",
        "--model",
        profile.model,
        "--text",
        text,
        "--lang_code",
        profile.language,
        "--output_path",
        str(native_dir),
        "--file_prefix",
        file_prefix,
        "--audio_format",
        "wav",
        "--ref_audio",
        str(profile.reference_audio),
        "--ref_text",
        profile.reference_text,
        "--join_audio",
    ]


def build_normalize_command(native_audio: Path, output: Path) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(native_audio),
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s24le",
        str(output),
    ]


def dry_run_payload(profile: VoiceProfile, text: str, output: Path) -> dict[str, object]:
    native_dir = output.parent / ".ptt-voice-temporary"
    native_audio = native_dir / "native.wav"
    return {
        "profile": profile.name,
        "model": profile.model,
        "output": str(output.resolve()),
        "generate_command": build_generate_command(profile, text, native_dir, "native"),
        "normalize_command": build_normalize_command(native_audio, output.resolve()),
        "network_after_model_download": False,
    }


def generate(profile: VoiceProfile, text: str, output: Path) -> None:
    if output.suffix.lower() != ".wav":
        raise ProfileError("Output must use the .wav extension")
    if shutil.which("ffmpeg") is None:
        raise ProfileError("ffmpeg is required but was not found on PATH")

    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ptt-voice-", dir=output.parent) as temp_dir:
        native_dir = Path(temp_dir)
        native_audio = native_dir / "native.wav"
        subprocess.run(
            build_generate_command(profile, text, native_dir, "native"),
            check=True,
        )
        if not native_audio.is_file():
            raise ProfileError(f"MLX-Audio did not create the expected file: {native_audio}")
        subprocess.run(build_normalize_command(native_audio, output), check=True)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    generate_parser = subparsers.add_parser("generate", help="Generate narration locally")
    generate_parser.add_argument("--profiles-dir", type=Path, default=DEFAULT_PROFILES_DIR)
    generate_parser.add_argument("--profile", default="PTT VOICE")
    text_group = generate_parser.add_mutually_exclusive_group(required=True)
    text_group.add_argument("--text")
    text_group.add_argument("--text-file", type=Path)
    generate_parser.add_argument("--output", type=Path, required=True)
    generate_parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        profile = load_profile(args.profiles_dir, args.profile)
        text = read_generation_text(args.text, args.text_file)
        if args.dry_run:
            print(json.dumps(dry_run_payload(profile, text, args.output), indent=2))
            return 0
        generate(profile, text, args.output)
        print(
            json.dumps(
                {
                    "status": "complete",
                    "profile": profile.name,
                    "model": profile.model,
                    "output": str(args.output.resolve()),
                },
                indent=2,
            )
        )
        return 0
    except ProfileError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"error: local voice generation failed with exit code {exc.returncode}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
