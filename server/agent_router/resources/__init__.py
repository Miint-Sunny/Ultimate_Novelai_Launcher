"""Versioned, read-only resources for the desktop Agent.

The production ``prompts.yaml`` is intentionally supplied separately.  Keeping
this package importable lets development and build preflight report its absence
explicitly instead of silently falling back to an unrelated prompt set.
"""
