# Ultimate Novelai launcher Notices

Ultimate Novelai launcher is licensed under GPL-3.0-only.

## Referenced Projects

- `main reference/novelai_web_ui` is the authorized primary implementation reference for this refactor. Its UI, workflows, and parameter mapping may be adapted into this GPL project, but secrets, private service endpoints, and account/operation-specific configuration must not be copied.
- HainTag (`reference_repos/HainTag`) is GPL-3.0. Any copied or adapted GPL code must retain copyright notices, license terms, and modification notes.
- astrbot_plugin_ppnai (`reference_repos/astrbot_plugin_ppnai`) is MIT. Its NovelAI request shape and bot-side generation ideas may be used as implementation references.
- NovelAI-Tag (`reference_repos/NovelAI-Tag`) is MIT. Its tag data and search experience may inform later local knowledge-base work.
- Aaalice_NAI_Launcher (`reference_repos/Aaalice_NAI_Launcher`) is MIT. Its launcher, gallery, metadata, and desktop-client product patterns may be referenced.

## Refactor Notes

This app is being cleaned from the reference web UI into a local-first desktop tool. The frontend must not store NovelAI tokens in browser storage or call NovelAI directly. Token handling, generation, Vibe encoding, upscaling, metadata work, and persistent history belong in the Python sidecar.
