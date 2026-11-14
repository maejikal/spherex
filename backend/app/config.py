"""Runtime configuration, overridable through ``SKY_*`` environment variables or ``backend/.env``."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SKY_", env_file=".env", extra="ignore")

    # --- CORS -------------------------------------------------------------
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # --- Trusted upstream hosts (fixed; never taken from requests) ----------
    # SPHEREx imagery is read by the browser directly from this HiPS; the backend only reads its
    # metadata (survey description, channel table) and uses it to verify targets.
    spherex_hips_url: str = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
    sesame_url: str = "https://cds.unistra.fr/cgi-bin/nph-sesame"
    # Sesame redirects to regional mirrors; redirects are only followed to these hosts.
    sesame_allowed_hosts: list[str] = [
        "cds.unistra.fr",
        "vizier.cds.unistra.fr",
        "vizier.u-strasbg.fr",
        "vizier.idia.ac.za",
        "vizier.cfa.harvard.edu",
        "vizier.iucaa.in",
        "vizier.nao.ac.jp",
    ]
    # SIMBAD TAP endpoints, tried in order (CDS primary, then the official Harvard mirror).
    simbad_tap_urls: list[str] = [
        "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
        "https://simbad.harvard.edu/simbad/sim-tap/sync",
    ]

    # --- HTTP behaviour ----------------------------------------------------
    connect_timeout: float = 5.0
    read_timeout: float = 20.0
    max_retries: int = 2
    retry_backoff_base: float = 0.4  # seconds; doubled each attempt, plus jitter
    max_upstream_text_bytes: int = 2 * 1024 * 1024
    max_upstream_concurrency: int = 6
    user_agent: str = "SkyExplorer/0.2 (NASA Space Apps SPHEREx prototype)"

    # --- Caching -------------------------------------------------------------
    survey_cache_ttl_seconds: int = 3600
    resolver_cache_ttl_seconds: int = 7 * 24 * 3600
    catalogue_cache_ttl_seconds: int = 3600
    memory_cache_max_entries: int = Field(default=512, ge=1)

    # --- Request limits --------------------------------------------------------
    max_name_length: int = 100
    max_nearby_radius_arcsec: float = 120.0
    max_nearby_limit: int = 50


@lru_cache
def get_settings() -> Settings:
    return Settings()
