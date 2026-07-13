from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sidecar.config import load_settings
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

    def test_trusted_lan_networks_are_explicit_normalized_cidrs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            out = write_local_settings(
                data_dir,
                {
                    "llm_network_scope": "trusted-lan",
                    "llm_trusted_networks": ["10.23.7.9/16", "fc00::1/64", "10.23.0.0/16"],
                },
            )
            self.assertEqual(out["llm_network_scope"], "trusted-lan")
            self.assertEqual(out["llm_trusted_networks"], ["10.23.0.0/16", "fc00::/64"])

    def test_rejects_public_or_malformed_trusted_lan_networks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            for networks in (["8.8.8.0/24"], ["not-a-network"], "10.0.0.0/8"):
                out = write_local_settings(data_dir, {"llm_trusted_networks": networks})
                self.assertNotIn("llm_trusted_networks", out)

    def test_load_settings_resolves_stored_and_environment_trusted_networks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            write_local_settings(
                data_dir,
                {
                    "llm_trusted_networks": ["10.0.0.0/8"],
                    "llm_backup_trusted_networks": ["172.16.0.0/12"],
                },
            )
            with (
                patch.dict(
                    os.environ,
                    {
                        "ULTIMATE_NOVELAI_LAUNCHER_DATA_DIR": temp,
                        "LLM_TRUSTED_NETWORKS": "192.168.10.0/24, 192.168.20.0/24",
                    },
                    clear=True,
                ),
                patch("sidecar.config.get_stored_token", return_value=""),
                patch("sidecar.config.get_stored_llm_key", return_value=""),
                patch("sidecar.config.get_stored_llm_backup_key", return_value=""),
            ):
                settings = load_settings()
            self.assertEqual(
                settings.llm_trusted_networks,
                ("192.168.10.0/24", "192.168.20.0/24"),
            )
            self.assertEqual(settings.llm_backup_trusted_networks, ("172.16.0.0/12",))


if __name__ == "__main__":
    unittest.main()
