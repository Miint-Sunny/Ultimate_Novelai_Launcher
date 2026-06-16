from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sidecar.config import Settings
from sidecar.db import (
    create_generation,
    init_db,
    list_history,
    lookup_tag_translations,
    mark_error,
    mark_success,
    upsert_tag_translations,
)


def make_settings(path: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=path,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=False,
    )


class DbTests(unittest.TestCase):
    def test_history_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = make_settings(Path(temp))
            init_db(settings)
            record = create_generation(
                settings,
                generation_id="img1",
                user_input="1girl",
                mode="tags",
                tags="1girl",
                negative="bad anatomy",
                params={"width": 832},
            )
            self.assertEqual(record.status, "pending")

            path = settings.images_dir / "img1.png"
            path.write_bytes(b"png")
            success = mark_success(settings, "img1", path)
            self.assertEqual(success.status, "success")
            self.assertEqual(success.image_url, "/images/img1")

            history = list_history(settings)
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0].id, "img1")

    def test_error_state_is_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = make_settings(Path(temp))
            init_db(settings)
            create_generation(
                settings,
                generation_id="img2",
                user_input="1girl",
                mode="tags",
                tags="1girl",
                negative="",
                params={},
            )
            failed = mark_error(settings, "img2", "NAI_TOKEN is not configured")
            self.assertEqual(failed.status, "error")
            self.assertEqual(failed.error, "NAI_TOKEN is not configured")

    def test_tag_translation_cache_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = make_settings(Path(temp))
            init_db(settings)
            count = upsert_tag_translations(
                settings,
                [
                    {"tag": "long hair", "zh": "长发", "source": "ai"},
                    {"tag": "Blue_Eyes", "zh": "蓝眼睛", "source": "wiki"},
                ],
            )
            self.assertEqual(count, 2)
            translations = lookup_tag_translations(settings, ["long_hair", "blue eyes", "missing"])
            self.assertEqual(translations, {"long_hair": "长发", "blue_eyes": "蓝眼睛"})


if __name__ == "__main__":
    unittest.main()
