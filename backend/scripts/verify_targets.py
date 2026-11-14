"""Regenerate ``app/data/verified_targets.json`` from live services.

Usage (from ``backend/``)::

    ../.venv/bin/python scripts/verify_targets.py [--random-fields 50] [--seed 18]

Method
------
* Suggested targets: the object name is resolved through CDS Sesame (coordinates are never typed in
  by hand). Coverage is then checked with the live SDSS DR18 cutout service, which answers HTTP 404
  ("outside the SDSS footprint") where no imaging exists.
* Random fields: positions are drawn uniformly on the sphere inside two broad regions that are
  known to contain SDSS imaging (northern contiguous footprint; Stripe 82). A position is kept only if
  the centre *and* four points offset by ~0.15 degrees all return real imagery, so a default-scale view
  centred there is fully inside the footprint.

A target that fails verification is reported and omitted; it is never kept "because it is famous".
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.main import build_services  # noqa: E402
from app.models.errors import AppError, NoCoverage  # noqa: E402
from app.providers.base import CutoutRequest  # noqa: E402
from app.services.target_service import DEFAULT_DATA_FILE  # noqa: E402

SUGGESTED_CANDIDATES = [
    ("m31", "Andromeda Galaxy (M31)", "M31", "Nearest large spiral galaxy; spans several degrees on the sky."),
    ("m51", "Whirlpool Galaxy (M51)", "M51", "Face-on spiral galaxy interacting with its companion NGC 5195."),
    ("m87", "Virgo A (M87)", "M87", "Giant elliptical galaxy at the centre of the Virgo Cluster."),
    ("ngc891", "NGC 891", "NGC 891", "Edge-on spiral galaxy with a prominent dust lane."),
    ("cosmos", "COSMOS field", "COSMOS field", "Well-studied extragalactic survey field in Sextans."),
    ("lockman", "Lockman Hole", "Lockman Hole", "Sky region with very low Galactic hydrogen column density, used for deep extragalactic surveys."),
    ("m101", "Pinwheel Galaxy (M101)", "M101", "Large face-on spiral galaxy in Ursa Major."),
    ("m13", "Hercules Cluster (M13)", "M13", "Bright globular cluster in Hercules."),
]


def offsets(ra: float, dec: float, delta_deg: float) -> list[tuple[float, float]]:
    cos_dec = max(math.cos(math.radians(dec)), 1e-3)
    d_ra = delta_deg / cos_dec
    pts = [(ra, dec)]
    for dr, dd in ((d_ra, 0), (-d_ra, 0), (0, delta_deg), (0, -delta_deg)):
        pts.append(((ra + dr) % 360.0, max(-90.0, min(90.0, dec + dd))))
    return pts


async def covered(sdss, points) -> tuple[bool, str]:
    for ra, dec in points:
        try:
            await sdss.get_cutout(CutoutRequest(ra=ra, dec=dec, scale=1.0, width=64, height=64))
        except NoCoverage:
            return False, f"no SDSS imaging at ({ra:.4f}, {dec:.4f})"
        except AppError as exc:
            raise RuntimeError(f"coverage could not be determined: {exc.code}: {exc.message}") from exc
    return True, "all points returned SDSS imagery"


def sample_sphere(rng: random.Random, ra_lo: float, ra_hi: float, dec_lo: float, dec_hi: float) -> tuple[float, float]:
    ra = rng.uniform(ra_lo, ra_hi) % 360.0
    s_lo, s_hi = math.sin(math.radians(dec_lo)), math.sin(math.radians(dec_hi))
    return ra, math.degrees(math.asin(rng.uniform(s_lo, s_hi)))


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--random-fields", type=int, default=50)
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument("--out", type=Path, default=DEFAULT_DATA_FILE)
    args = parser.parse_args()

    # build_services needs a targets file only to construct TargetService; avoid the chicken-and-egg.
    settings = get_settings()
    tmp = Path(args.out).with_suffix(".bootstrap.json")
    tmp.write_text(json.dumps({"suggested": [], "random_fields": [{"id": "x", "name": "x", "ra": 0, "dec": 0}]}))
    services = build_services(settings, tmp)
    tmp.unlink()
    sdss, sesame = services.sdss, services.sesame

    suggested, report = [], []
    try:
        for tid, display, query, description in SUGGESTED_CANDIDATES:
            try:
                resolved = await sesame.resolve(query)
                ok, detail = await covered(sdss, offsets(resolved.ra, resolved.dec, 0.05))
            except (AppError, RuntimeError) as exc:
                report.append(f"SKIP {tid}: {exc}")
                continue
            if not ok:
                report.append(f"OMIT {tid}: {detail}")
                continue
            suggested.append(
                {"id": tid, "name": display, "ra": round(resolved.ra, 6), "dec": round(resolved.dec, 6), "description": description}
            )
            report.append(f"KEEP {tid}: {resolved.source} -> ({resolved.ra:.5f}, {resolved.dec:.5f}); {detail}")

        rng = random.Random(args.seed)
        regions = [(110, 260, -5, 65)] * 4 + [(310, 410, -1.0, 1.0)]  # weighted toward the main footprint
        fields, attempts = [], 0
        while len(fields) < args.random_fields and attempts < args.random_fields * 40:
            attempts += 1
            ra, dec = sample_sphere(rng, *rng.choice(regions))
            try:
                ok, _ = await covered(sdss, offsets(ra, dec, 0.15))
            except RuntimeError as exc:
                report.append(f"upstream problem while sampling: {exc}")
                break
            if ok:
                fields.append(
                    {"id": f"field-{len(fields) + 1:02d}", "name": "Random SDSS field", "ra": round(ra, 5), "dec": round(dec, 5)}
                )
        report.append(f"random fields: kept {len(fields)} of {attempts} candidates")
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
            "coordinates": "Suggested targets resolved via CDS Sesame; random fields sampled uniformly on the sphere in known-footprint regions.",
            "coverage_method": "Live SDSS DR18 ImgCutout/getjpeg; HTTP 404 'outside the SDSS footprint' means no imaging. "
            "Suggested targets checked at centre and 4 points 0.05 deg away; random fields at centre and 4 points 0.15 deg away.",
            "limitations": "Coverage means SDSS DR18 returned imagery for the point; it does not imply deep or high-S/N data. "
            "The footprint can change between data releases; re-run this script after upgrading the release.",
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
