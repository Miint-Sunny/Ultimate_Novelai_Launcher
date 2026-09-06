# Ultimate Novelai launcher Notices

Ultimate Novelai launcher is licensed under GPL-3.0-only.

## Referenced Projects

- `main reference/novelai_web_ui` is the authorized primary implementation reference for this refactor. Its UI, workflows, and parameter mapping may be adapted into this GPL project, but secrets, private service endpoints, and account/operation-specific configuration must not be copied.
- HainTag (`reference_repos/HainTag`) is GPL-3.0. Any copied or adapted GPL code must retain copyright notices, license terms, and modification notes.
- astrbot_plugin_ppnai (`reference_repos/astrbot_plugin_ppnai`) is MIT. Its NovelAI request shape and bot-side generation ideas may be used as implementation references.
- NovelAI-Tag (`reference_repos/NovelAI-Tag`) is MIT. Its tag data and search experience may inform later local knowledge-base work.
- Novelai-harness (`reference_repos/Novelai-harness`, https://github.com/saltysalrua/Novelai-harness) is MIT. Its Agent harness design (tool loop, presets, skills, permission model) informed `src/services/agentHarness`, and its export pipeline — visible watermark compositing, low-information placement search and the Koch-Zhao DCT blind watermark with the `NHWM` payload format and fixed key — is ported to TypeScript in `src/services/watermark` so blind watermarks stay mutually extractable.
- Aaalice_NAI_Launcher (`reference_repos/Aaalice_NAI_Launcher`) is MIT. Its launcher, gallery, metadata, and desktop-client product patterns may be referenced. The Qwen 3.5 prompt token counting scheme and the redistributed merge-list asset `src/assets/tokenizer/qwen35_bpe.txt.gz` (derived from NovelAI's published tokenizer data via that project's `tool/tokenizer/build_qwen_tokenizer_asset.dart` pipeline) originate from this project; regeneration is reproduced by `scripts/build-qwen-tokenizer-asset.mjs`.

## Refactor Notes

This app is being cleaned from the reference web UI into a local-first desktop tool. The frontend must not store NovelAI tokens in browser storage or call NovelAI directly. Token handling, generation, Vibe encoding, upscaling, metadata work, and persistent history belong in the Python sidecar.
