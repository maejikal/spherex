"""Spherical-geometry helpers. Angular separation uses the haversine formula, never degree differences."""

from __future__ import annotations

import math


def normalize_ra(ra_deg: float) -> float:
    """Wrap right ascension into ``0 <= ra < 360``."""
    value = ra_deg % 360.0
    # ``-1e-18 % 360`` yields 360.0 after rounding; keep the half-open range.
    return 0.0 if value >= 360.0 else value


def angular_separation_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great-circle separation between two ICRS/J2000 positions in arcseconds."""
    phi1, phi2 = math.radians(dec1), math.radians(dec2)
    dphi = phi2 - phi1
    dlam = math.radians(ra2 - ra1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2.0) ** 2
    a = min(1.0, max(0.0, a))
    return math.degrees(2.0 * math.asin(math.sqrt(a))) * 3600.0
