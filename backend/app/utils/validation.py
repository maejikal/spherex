"""Shared validation helpers for values that arrive from the browser."""

from __future__ import annotations

import unicodedata

from ..models.errors import InvalidParameters


def clean_object_name(raw: str, max_length: int) -> str:
    """Normalise and validate a user-supplied astronomical object name."""
    text = unicodedata.normalize("NFKC", raw)
    if any(unicodedata.category(ch).startswith("C") for ch in text):
        raise InvalidParameters("Object name contains control characters.")
    text = " ".join(text.split())
    if not text:
        raise InvalidParameters("Object name must not be empty.")
    if len(text) > max_length:
        raise InvalidParameters(f"Object name must be at most {max_length} characters.")
    return text
