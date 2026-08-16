# Built-in ComfyUI workflow templates

Package-shipped defaults, looked up after the user directory
(`<data_dir>/comfy-workflows/<model>.json`). Each file is a ComfyUI
**API-format** export (ComfyUI → dev mode → Save (API Format)) named after the
workflow/model id it serves.

Currently empty on purpose: no workflow has been validated yet. Ship a template
here only after it has produced correct output locally, and remember to add the
file to the PyInstaller data list in `scripts/build-sidecar.mjs`.
