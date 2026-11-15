"""Runtime configuration, overridable through ``SKY_*`` environment variables or ``backend/.env``."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class LocalBlinkProfileSettings(BaseModel):
    """One named, fixed pair of local SPHEREx exposures."""

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    label: str = Field(min_length=1, max_length=80)
    files: tuple[Path, Path]


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

    # --- Local SPHEREx exposures for the blink viewer ------------------------------------------
    # Fixed, server-side paths (never taken from a request). The two files are two exposures of the same
    # sky; frames are ordered by the observation time in their headers, not by this order.
    blink_fits_files: list[Path] = [
        Path("~/Downloads/spherex_D5_2025_05_full.fits"),
        Path("~/Downloads/spherex_D5_2025_12_full.fits"),
    ]
    # Extra named pairs extend the default local region instead of replacing it.
    blink_local_profiles: list[LocalBlinkProfileSettings] = Field(default_factory=list)
    blink_pixel_scale_arcsec: float = Field(default=6.15, gt=0, le=60)
    blink_default_size: int = Field(default=256, ge=16)
    blink_min_size: int = Field(default=32, ge=16)
    blink_max_size: int = Field(default=512, ge=32)
    # A frame with less than this fraction of valid pixels in the cutout counts as "no coverage".
    blink_min_coverage_fraction: float = Field(default=0.10, gt=0, le=1)
    # Below this fraction the viewer is warned that coverage is partial.
    blink_full_coverage_fraction: float = Field(default=0.95, gt=0, le=1)
    blink_cache_entries: int = Field(default=24, ge=1)
    blink_cache_ttl_seconds: int = 3600

    # --- Dynamic blink viewer: SPHEREx observations discovered through NASA/IPAC IRSA ------------
    blink_dynamic_enabled: bool = True
    irsa_sia_url: str = "https://irsa.ipac.caltech.edu/SIA"
    irsa_collection: str = "spherex_dr1"
    # access_url values come from the archive's response; only these hosts are ever contacted.
    irsa_allowed_hosts: list[str] = ["irsa.ipac.caltech.edu"]
    irsa_connect_timeout: float = 10.0
    irsa_sia_read_timeout: float = 60.0
    irsa_download_read_timeout: float = 180.0
    irsa_max_retries: int = Field(default=3, ge=0, le=6)
    irsa_backoff_base: float = Field(default=1.0, ge=0)
    irsa_max_download_bytes: int = 400 * 1024 * 1024
    sia_cache_ttl_seconds: int = 3600
    sia_cache_entries: int = Field(default=64, ge=1)
    # On-disk cache of FITS cutouts and detector calibrations (git-ignored). Bounded; oldest files evicted first.
    blink_cache_dir: Path = BACKEND_ROOT / ".cache" / "blink"
    blink_cache_max_bytes: int = 1024 * 1024 * 1024
    # Optional local full-detector images used only to seed the per-detector wavelength calibration without a download.
    blink_calibration_seed_files: list[Path] = [
        Path("~/Downloads/spherex_D3_2025_05_full.fits"),
        Path("~/Downloads/spherex_D5_2025_05_full.fits"),
    ]
    dynamic_fov_default: float = Field(default=0.1, gt=0)
    dynamic_fov_min: float = Field(default=0.02, gt=0)
    dynamic_fov_max: float = Field(default=0.5, gt=0)
    dynamic_overscan: float = Field(default=1.5, ge=1.0, le=3.0)
    dynamic_detector_buffer_px: float = Field(default=20.0, ge=0)
    # Pair selection. These are provisional engineering heuristics, NOT established scientific thresholds.
    epoch_gap_days: float = 30.0            # observations closer than this belong to one survey epoch
    min_epoch_separation_days: float = 60.0
    max_pair_gap_nm: float = 30.0
    max_gap_over_bandwidth: float = 0.75    # |delta lambda| / mean bandwidth at the target
    max_field_gap_over_bandwidth: float = 1.5  # worst |delta lambda| / mean bandwidth anywhere in the field
    max_bandwidth_difference_fraction: float = 0.25
    top_pairs_to_try: int = Field(default=5, ge=1, le=20)
    # Exact-verification limits.
    min_geometric_coverage: float = Field(default=0.98, gt=0, le=1)
    min_common_good_fraction: float = Field(default=0.85, gt=0, le=1)
    max_position_error_px: float = 25.0     # SIA-polygon prediction vs exact detector position: a larger gap is reported as a warning
    max_footprint_error_px: float = 400.0   # ...and a gap this large (about 0.7 deg) rejects the observation: the footprint or WCS is wrong
    max_pairs_to_try: int = Field(default=12, ge=1, le=40)  # shortlist is extended to this many when failures are metadata/geometry problems
    dynamic_interp_min_weight: float = Field(default=0.99, gt=0, le=1)
    dynamic_result_cache_entries: int = Field(default=12, ge=1)

    # --- Request limits --------------------------------------------------------
    max_name_length: int = 100
    max_nearby_radius_arcsec: float = 120.0
    max_nearby_limit: int = 50

    @model_validator(mode="after")
    def unique_local_profile_ids(self) -> "Settings":
        ids = [profile.id for profile in self.blink_local_profiles]
        if "default" in ids or len(ids) != len(set(ids)):
            raise ValueError("Local FITS profile IDs must be unique and cannot be 'default'.")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
