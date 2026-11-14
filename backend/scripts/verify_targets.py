"""Regenerate ``app/data/verified_targets.json`` from live services.

Usage (from ``backend/``; needs ``pip install -r requirements-scripts.txt``)::

    ../.venv/bin/python scripts/verify_targets.py [--random-fields 40] [--seed 7]

Method
------
* Suggested targets: the name is resolved through CDS Sesame (coordinates are never typed by hand).
  SIMBAD proper motion is then used to move the position from its J2000 catalogue value to the
  mid-epoch of the SPHEREx cube (from ``t_min``/``t_max`` in the HiPS properties), when the object
  has moved more than 20 arcsec by then. The adjustment is stated in the target description.
* Coverage: the HEALPix NESTED index of the position is computed (``astropy-healpix``) and the real
  tiles of the SPHEREx HiPS are fetched for a spread of cube frames (one per detector band). A
  position passes only if every tile exists (HTTP 200), decodes as a PNG and is not all zero. This is
  the same file Aladin Lite requests, so "verified" means "tiles that exist and contain signal".
* Random fields: positions are drawn uniformly on the sphere (z = sin(dec) uniform) and kept only if
  they pass the same tile check, so any missing-data regions are excluded rather than assumed away.

A target that fails verification is reported and omitted.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import astropy.units as u  # noqa: E402
from astropy_healpix import HEALPix  # noqa: E402
from PIL import Image  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.main import build_services  # noqa: E402
from app.models.errors import AppError  # noqa: E402
from app.services.target_service import DEFAULT_DATA_FILE  # noqa: E402

VERIFY_ORDERS = (3, 5)
# One frame in each of the six detector bands (0-based frame = 17 * (band - 1) + channel - 1).
VERIFY_FRAMES = (5, 22, 40, 60, 76, 95)
PM_NOTE_THRESHOLD_ARCSEC = 20.0

# (id, display name, Sesame query, description)
SUGGESTED_CANDIDATES = [
    ("barnards-star", "Barnard's Star", "Barnard's Star", "Nearest single star system after the Alpha Centauri system; red dwarf with the largest known proper motion."),
    ("eps-indi-b", "Epsilon Indi B", "eps Ind B", "Binary brown-dwarf system (Ba and Bb) orbiting the star Epsilon Indi A."),
    ("wise-0855", "WISE 0855-0714", "WISEA J085510.74-071442.5", "Among the coldest known brown dwarfs (roughly 250-285 K), extremely faint at near-infrared wavelengths."),
    ("rw-aur", "RW Aurigae", "RW Aur", "Young, variable T Tauri star system in the Taurus-Auriga star-forming region."),
    ("r-dra", "R Draconis", "R Dra", "Mira-type pulsating red giant, strongly variable in the infrared."),
    ("m31", "Andromeda Galaxy (M31)", "M31", "Nearest large spiral galaxy; spans several degrees on the sky."),
    ("m42", "Orion Nebula (M42)", "M42", "Bright star-forming nebula in Orion."),
]

TAP = "https://simbad.harvard.edu/simbad/sim-tap/sync"


def mjd_to_year(mjd: float) -> float:
    return 2000.0 + (mjd - 51544.5) / 365.25


async def simbad_pm(services, name_query: str, ra: float, dec: float):
    """Proper motion (mas/yr) of the SIMBAD object nearest the resolved position, or None."""
    adql = (
        "SELECT TOP 1 pmra, pmdec, (pmra*pmra + pmdec*pmdec) AS pm2 FROM basic "
        f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.9f}, {dec:.9f}, 0.0003)) = 1 "
        "AND pmra IS NOT NULL AND pmdec IS NOT NULL ORDER BY pm2 DESC"
    )
    for endpoint in services_settings.simbad_tap_urls:
        try:
            r = await services.sesame._upstream.get(  # reuse the shared bounded HTTP client
                endpoint,
                params={"request": "doQuery", "lang": "adql", "format": "json", "query": adql},
                max_bytes=1_000_000,
                accept="application/json",
            )
            rows = json.loads(r.body)["data"]
            return (float(rows[0][0]), float(rows[0][1])) if rows else None
        except (AppError, ValueError, KeyError, IndexError):
            continue
    return None


def propagate(ra: float, dec: float, pm: tuple[float, float], years: float) -> tuple[float, float, float]:
    """Linear proper-motion propagation (pmra already includes cos dec). Returns (ra, dec, shift")."""
    d_dec = pm[1] * years / 3.6e6
    d_ra = pm[0] * years / 3.6e6 / max(math.cos(math.radians(dec)), 1e-6)
    shift = math.hypot(pm[0], pm[1]) * years / 1000.0
    return (ra + d_ra) % 360.0, max(-90.0, min(90.0, dec + d_dec)), shift


async def tile_ok(spherex, healpix: dict, ra: float, dec: float, order: int, frame: int) -> tuple[bool, str]:
    npix = int(healpix[order].lonlat_to_healpix(ra * u.deg, dec * u.deg))
    url = spherex.tile_url(order, npix, frame)
    try:
        r = await spherex._upstream.get(url, max_bytes=2_000_000, accept="image/png")
    except AppError as exc:
        raise RuntimeError(f"upstream failure: {exc.code}") from exc
    if r.status != 200 or r.content_type != "image/png":
        return False, f"{url.split('cube/')[1]} -> HTTP {r.status}"
    try:
        with Image.open(io.BytesIO(r.body)) as image:
            image.load()
            if image.getextrema()[1] <= 0:
                return False, f"{url.split('cube/')[1]} is blank"
    except OSError:
        return False, f"{url.split('cube/')[1]} is not a valid PNG"
    return True, url.split("cube/")[1]


async def covered(spherex, healpix, ra: float, dec: float) -> tuple[bool, str]:
    for order in VERIFY_ORDERS:
        for frame in VERIFY_FRAMES:
            ok, detail = await tile_ok(spherex, healpix, ra, dec, order, frame)
            if not ok:
                return False, detail
    return True, f"orders {VERIFY_ORDERS} x frames {VERIFY_FRAMES}: all tiles present and non-blank"


async def main() -> int:
    global services_settings
    parser = argparse.ArgumentParser()
    parser.add_argument("--random-fields", type=int, default=40)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=DEFAULT_DATA_FILE)
    args = parser.parse_args()

    services_settings = get_settings()
    bootstrap = Path(args.out).with_suffix(".bootstrap.json")
    bootstrap.write_text(json.dumps({"suggested": [], "random_fields": [{"id": "x", "name": "x", "ra": 0, "dec": 0}]}))
    services = build_services(services_settings, bootstrap)
    bootstrap.unlink()
    spherex, sesame = services.spherex, services.sesame
    healpix = {order: HEALPix(nside=2**order, order="nested") for order in VERIFY_ORDERS}

    report: list[str] = []
    suggested, fields = [], []
    try:
        info = await spherex.describe()
        window = info.observation_window_mjd
        epoch = mjd_to_year(sum(window) / 2) if window else 2025.9
        years = epoch - 2000.0
        report.append(f"SPHEREx cube: {len(info.channels)} frames, window MJD {window}, epoch used for proper motion: {epoch:.2f}")

        for tid, display, query, description in SUGGESTED_CANDIDATES:
            try:
                resolved = await sesame.resolve(query)
                ra, dec, note = resolved.ra, resolved.dec, ""
                pm = await simbad_pm(services, query, resolved.ra, resolved.dec)
                if pm is None:
                    report.append(f"note {tid}: no SIMBAD proper motion available; using the J2000 position as resolved")
                if pm:
                    p_ra, p_dec, shift = propagate(resolved.ra, resolved.dec, pm, years)
                    if shift >= PM_NOTE_THRESHOLD_ARCSEC:
                        ra, dec = p_ra, p_dec
                        note = (
                            f" Proper motion ({math.hypot(*pm) / 1000:.2f}\"/yr, SIMBAD) has moved it {shift / 60:.1f}' from its J2000 "
                            f"catalogue position; the position here is propagated to epoch {epoch:.1f}."
                        )
                ok, detail = await covered(spherex, healpix, ra, dec)
            except (AppError, RuntimeError) as exc:
                report.append(f"SKIP {tid}: {exc}")
                continue
            if not ok:
                report.append(f"OMIT {tid}: {detail}")
                continue
            suggested.append({"id": tid, "name": display, "ra": round(ra, 6), "dec": round(dec, 6), "description": description + note})
            report.append(f"KEEP {tid}: {resolved.source} -> J2000 ({resolved.ra:.5f}, {resolved.dec:.5f}); using ({ra:.5f}, {dec:.5f}); {detail}")

        rng = random.Random(args.seed)
        attempts = 0
        while len(fields) < args.random_fields and attempts < args.random_fields * 6:
            attempts += 1
            ra = rng.uniform(0.0, 360.0)
            dec = math.degrees(math.asin(rng.uniform(-1.0, 1.0)))  # uniform on the sphere
            try:
                ok, detail = await covered(spherex, healpix, ra, dec)
            except RuntimeError as exc:
                report.append(f"upstream problem while sampling: {exc}")
                break
            if ok:
                fields.append({"id": f"sky-{len(fields) + 1:02d}", "name": "Random SPHEREx sky position", "ra": round(ra, 5), "dec": round(dec, 5)})
            else:
                report.append(f"reject random ({ra:.3f}, {dec:.3f}): {detail}")
        report.append(f"random fields: kept {len(fields)} of {attempts} sampled positions")
    finally:
        await services.http.aclose()

    if not suggested or not fields:
        print("\n".join(report))
        print("Refusing to write an empty target file.", file=sys.stderr)
        return 1

    payload = {
        "provenance": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "script": "backend/scripts/verify_targets.py",
            "survey": "SPHEREx DR1 all-sky cube HiPS (NASA/IPAC IRSA)",
            "coordinates": "Suggested targets resolved via CDS Sesame (SIMBAD); proper-motion objects propagated to the cube's mid-epoch. "
            "Random positions drawn uniformly on the sphere.",
            "coverage_method": f"Real HiPS tiles fetched for HEALPix orders {list(VERIFY_ORDERS)} and cube frames {list(VERIFY_FRAMES)} "
            "(one per band); each must return HTTP 200, decode as PNG and be non-blank.",
            "limitations": "Verification shows tiles exist with signal, not that an object is detected or well measured. "
            "The cube is a combined all-sky product, so it cannot show motion; a high-proper-motion object appears at an "
            "epoch-averaged position. Re-run after any new data release.",
            "seed": args.seed,
        },
        "suggested": suggested,
        "random_fields": fields,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2) + "\n")
    print("\n".join(report))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
