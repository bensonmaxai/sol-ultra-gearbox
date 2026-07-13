import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "ptt_voice.py"


class PttVoiceCliTests(unittest.TestCase):
    def make_profile(self, root: Path, *, include_audio: bool = True) -> Path:
        profile_dir = root / "profiles" / "ptt-voice"
        profile_dir.mkdir(parents=True)
        if include_audio:
            (profile_dir / "reference.wav").write_bytes(b"RIFF-test-audio")
        (profile_dir / "profile.json").write_text(
            json.dumps(
                {
                    "name": "PTT VOICE",
                    "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
                    "language": "English",
                    "reference_audio": "reference.wav",
                    "reference_text": "A precise transcript of the reference voice.",
                }
            ),
            encoding="utf-8",
        )
        return root / "profiles"

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_generate_dry_run_builds_local_clone_and_normalize_commands(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            profiles_dir = self.make_profile(root)
            output = root / "narration.wav"

            result = self.run_cli(
                "generate",
                "--profiles-dir",
                str(profiles_dir),
                "--profile",
                "PTT VOICE",
                "--text",
                "Verify the runtime.",
                "--output",
                str(output),
                "--dry-run",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["profile"], "PTT VOICE")
            self.assertEqual(payload["output"], str(output.resolve()))
            self.assertIn("mlx_audio.tts.generate", payload["generate_command"])
            self.assertIn("--ref_audio", payload["generate_command"])
            self.assertIn("--ref_text", payload["generate_command"])
            self.assertIn("Verify the runtime.", payload["generate_command"])
            self.assertIn("48000", payload["normalize_command"])
            self.assertFalse(output.exists())

    def test_generate_rejects_a_missing_reference_audio_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            profiles_dir = self.make_profile(root, include_audio=False)

            result = self.run_cli(
                "generate",
                "--profiles-dir",
                str(profiles_dir),
                "--profile",
                "ptt-voice",
                "--text",
                "Hello.",
                "--output",
                str(root / "out.wav"),
                "--dry-run",
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Reference audio not found", result.stderr)

    def test_generate_requires_exactly_one_text_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            profiles_dir = self.make_profile(root)
            text_file = root / "script.txt"
            text_file.write_text("From a file.", encoding="utf-8")

            result = self.run_cli(
                "generate",
                "--profiles-dir",
                str(profiles_dir),
                "--profile",
                "PTT VOICE",
                "--text",
                "Inline.",
                "--text-file",
                str(text_file),
                "--output",
                str(root / "out.wav"),
                "--dry-run",
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not allowed with argument", result.stderr)


if __name__ == "__main__":
    unittest.main()
