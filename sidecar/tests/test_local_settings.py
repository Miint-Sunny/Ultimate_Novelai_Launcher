from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from sidecar.local_settings import read_local_settings, write_local_settings


class LocalSettingsUrlGuardTests(unittest.TestCase):
    def test_accepts_novelai_https_and_custom_llm_base_url(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(
                data_dir,
                {
                    "nai_base_url": "https://image.novelai.net",
                    "llm_base_url": "http://localhost:1234/v1",
                    "llm_model": "gpt-4o-mini",
                },
            )
            self.assertEqual(out["nai_base_url"], "https://image.novelai.net")
            self.assertEqual(out["llm_base_url"], "http://localhost:1234/v1")
            self.assertEqual(out["llm_model"], "gpt-4o-mini")

    def test_accepts_novelai_subdomain(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(data_dir, {"nai_base_url": "https://api.novelai.net"})
            self.assertEqual(out["nai_base_url"], "https://api.novelai.net")

    def test_rejects_attacker_nai_host(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(data_dir, {"nai_base_url": "https://attacker.example/steal"})
            self.assertNotIn("nai_base_url", out)
            self.assertNotIn("nai_base_url", read_local_settings(data_dir))

    def test_rejects_lookalike_nai_host(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(data_dir, {"nai_base_url": "https://evilnovelai.net"})
            self.assertNotIn("nai_base_url", out)

    def test_rejects_plain_http_for_nai(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(data_dir, {"nai_base_url": "http://image.novelai.net"})
            self.assertNotIn("nai_base_url", out)

    def test_rejects_metadata_ip_and_bad_scheme_for_llm(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(
                data_dir, {"llm_base_url": "http://169.254.169.254/latest/meta-data"}
            )
            self.assertNotIn("llm_base_url", out)
            out2 = write_local_settings(data_dir, {"llm_base_url": "file:///etc/passwd"})
            self.assertNotIn("llm_base_url", out2)

    def test_rejects_encoded_metadata_ip_forms_for_llm(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            for evil in (
                "http://[::ffff:169.254.169.254]/latest/meta-data",  # IPv4-mapped IPv6
                "http://2852039166/latest/meta-data",  # decimal-encoded 169.254.169.254
                "http://0xA9FEA9FE/",  # hex-encoded 169.254.169.254
            ):
                out = write_local_settings(data_dir, {"llm_base_url": evil})
                self.assertNotIn("llm_base_url", out, msg=f"should reject {evil}")

    def test_read_drops_stale_poisoned_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            (data_dir / "settings.json").write_text(
                json.dumps({"nai_base_url": "http://evil.example", "llm_model": "keep-me"}),
                encoding="utf-8",
            )
            loaded = read_local_settings(data_dir)
            self.assertNotIn("nai_base_url", loaded)
            self.assertEqual(loaded["llm_model"], "keep-me")

    def test_empty_base_url_is_preserved_as_default_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(data_dir, {"nai_base_url": "", "llm_base_url": ""})
            self.assertEqual(out["nai_base_url"], "")
            self.assertEqual(out["llm_base_url"], "")


if __name__ == "__main__":
    unittest.main()
