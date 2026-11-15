"""Per-detector SPHEREx wavelength calibration (the ``WCS-WAVE`` table) and full-detector coordinates.

SPHEREx uses linear variable filters, so the central wavelength and bandwidth seen at a pixel depend on
where on the detector that pixel is. The table maps *original full-image* pixel positions to
(wavelength, bandwidth) in micrometres. IRSA cutouts carry the same table but use *cutout-local* pixel
coordinates, so cutout positions must be converted to full-image positions before looking anything up.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits

log = logging.getLogger("skyexplorer.calibration")

_VERSION_RE = re.compile(r"\[CALIB\]\s+spectral_wcs\s+(\S+)")


class CalibrationError(ValueError):
    """The wavelength table is missing, malformed, or inconsistent with the detector."""


@dataclass(frozen=True, eq=False)
class DetectorCalibration:
    detector: str  # "D3"
    version: str  # the header's `[CALIB] spectral_wcs <id>`, or a content fingerprint if absent
    x: np.ndarray  # 1-based full-image columns of the control points
    y: np.ndarray  # 1-based full-image rows
    wavelength_um: np.ndarray  # (len(y), len(x))
    bandwidth_um: np.ndarray  # (len(y), len(x))

    @property
    def fingerprint(self) -> str:
        h = hashlib.sha256()
        for a in (self.x, self.y, self.wavelength_um, self.bandwidth_um):
            h.update(np.ascontiguousarray(a, dtype=np.float64).tobytes())
        return h.hexdigest()[:16]

    def lookup(self, x0: np.ndarray, y0: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(wavelength, bandwidth) in µm at *zero-based full-image* pixel coordinates; NaN outside the grid."""
        x0, y0 = np.asarray(x0, dtype=float), np.asarray(y0, dtype=float)
        xs, ys = x0 + 1.0, y0 + 1.0  # the table is indexed in FITS (one-based) pixels
        inside = np.isfinite(xs) & np.isfinite(ys) & (xs >= self.x[0]) & (xs <= self.x[-1]) & (ys >= self.y[0]) & (ys <= self.y[-1])
        cols = np.interp(np.where(inside, xs, self.x[0]), self.x, np.arange(self.x.size))
        rows = np.interp(np.where(inside, ys, self.y[0]), self.y, np.arange(self.y.size))
        # Bilinear in float64 (the table is tiny); float32 would cost ~1e-7 µm of precision.
        r0 = np.clip(np.floor(rows).astype(int), 0, self.y.size - 2)
        c0 = np.clip(np.floor(cols).astype(int), 0, self.x.size - 2)
        fr, fc = rows - r0, cols - c0
        out = []
        for table in (self.wavelength_um, self.bandwidth_um):
            v = (table[r0, c0] * (1 - fr) * (1 - fc) + table[r0, c0 + 1] * (1 - fr) * fc
                 + table[r0 + 1, c0] * fr * (1 - fc) + table[r0 + 1, c0 + 1] * fr * fc)
            out.append(np.where(inside, v, np.nan))
        return out[0], out[1]


def calibration_from_hdul(hdul: fits.HDUList, *, expected_detector: str | None = None) -> DetectorCalibration:
    names = [str(h.name).upper() for h in hdul]
    if "WCS-WAVE" not in names or "IMAGE" not in names:
        raise CalibrationError("file has no IMAGE / WCS-WAVE extension")
    det = hdul["IMAGE"].header.get("DETECTOR")
    if not isinstance(det, (int, float)) or not 1 <= int(det) <= 6:
        raise CalibrationError(f"missing or invalid DETECTOR header ({det!r})")
    detector = f"D{int(det)}"
    if expected_detector and detector != expected_detector:
        raise CalibrationError(f"file is detector {detector}, expected {expected_detector}")
    try:
        row = hdul["WCS-WAVE"].data[0]
        x = np.asarray(row["X"], dtype=float)
        y = np.asarray(row["Y"], dtype=float)
        values = np.asarray(row["VALUES"], dtype=float)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise CalibrationError(f"unreadable WCS-WAVE table ({exc})") from exc
    if values.shape != (y.size, x.size, 2) or x.size < 2 or y.size < 2:
        raise CalibrationError(f"unexpected WCS-WAVE shape {values.shape} for {y.size} rows x {x.size} columns")
    if not (np.all(np.diff(x) > 0) and np.all(np.diff(y) > 0)):
        raise CalibrationError("control points are not strictly increasing")
    wavelength, bandwidth = values[..., 0], values[..., 1]
    if not (np.all(np.isfinite(wavelength)) and np.all(np.isfinite(bandwidth))):
        raise CalibrationError("non-finite calibration values")
    if not (0.3 < wavelength.min() and wavelength.max() < 6.0 and bandwidth.min() > 0):
        raise CalibrationError("calibration values are outside the SPHEREx range (0.75-5 µm, positive bandwidth)")
    history = [str(h) for h in hdul["IMAGE"].header.get("HISTORY", [])]
    match = next((m for m in map(_VERSION_RE.search, history) if m), None)
    cal = DetectorCalibration(detector, match.group(1) if match else "", x, y, wavelength, bandwidth)
    if not cal.version:
        object.__setattr__(cal, "version", f"sha-{cal.fingerprint}")
    return cal


def full_frame_offset(cutout_header: fits.Header, full_nx: int, full_ny: int) -> tuple[float, float]:
    """(dx, dy) to add to a zero-based cutout-local pixel position to get the zero-based full-image position,
    **assuming the full image's CRPIX is its geometric centre** ((n+1)/2, 1020.5 for 2040 pixels).

    That holds for most SPHEREx images but NOT all: reprocessed "retry" images (``WCSRETRY = T``) have a
    different reference pixel, e.g. (1017.2, 905.4). A cutout does not record the original CRPIX, so this
    assumption is only a fallback; the pipeline uses :func:`header_frame_offset` with the archive's own full
    header instead.
    """
    for key in ("CRPIX1", "CRPIX2"):
        if not isinstance(cutout_header.get(key), (int, float)):
            raise CalibrationError(f"cutout header has no {key}")
    if full_nx < 2 or full_ny < 2:
        raise CalibrationError("unknown full-detector size")
    return (full_nx + 1) / 2.0 - float(cutout_header["CRPIX1"]), (full_ny + 1) / 2.0 - float(cutout_header["CRPIX2"])


def header_frame_offset(cutout_header: fits.Header, full_header: fits.Header, tolerance: float = 1e-3) -> tuple[float, float]:
    """(dx, dy) between a cutout's pixels and the full image's, from the full image's *actual* CRPIX.

    ``dx = CRPIX_full - CRPIX_cutout``. The result must be an integer (the crop origin); otherwise the two
    headers do not describe the same image and the mapping is rejected.
    """
    try:
        dx = float(full_header["CRPIX1"]) - float(cutout_header["CRPIX1"])
        dy = float(full_header["CRPIX2"]) - float(cutout_header["CRPIX2"])
    except (KeyError, TypeError, ValueError) as exc:
        raise CalibrationError(f"missing CRPIX in a header ({exc})") from exc
    if not (np.isfinite(dx) and np.isfinite(dy)) or abs(dx - round(dx)) > tolerance or abs(dy - round(dy)) > tolerance:
        raise CalibrationError(f"cutout offset ({dx:.3f}, {dy:.3f}) is not a whole-pixel crop origin")
    return float(round(dx)), float(round(dy))


class CalibrationRegistry:
    """Thread-safe per-detector calibration store with an on-disk copy.

    Calibrations are keyed by detector and version, never shared between detectors. ``current`` returns the
    most recently registered version for a detector; exact verification always uses the table inside the
    downloaded cutout, so a newer calibration release is detected rather than silently ignored.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory
        self._lock = threading.Lock()
        self._items: dict[str, dict[str, DetectorCalibration]] = {}
        self._latest: dict[str, str] = {}
        if directory is not None:
            self._load_disk()

    def register(self, cal: DetectorCalibration) -> None:
        with self._lock:
            self._items.setdefault(cal.detector, {})[cal.version] = cal
            self._latest[cal.detector] = cal.version
        self._save_disk(cal)

    def current(self, detector: str) -> DetectorCalibration | None:
        with self._lock:
            version = self._latest.get(detector)
            return self._items[detector][version] if version else None

    def get(self, detector: str, version: str) -> DetectorCalibration | None:
        with self._lock:
            return self._items.get(detector, {}).get(version)

    def detectors(self) -> list[str]:
        with self._lock:
            return sorted(self._items)

    def seed_from_file(self, path: Path) -> bool:
        """Register the calibration of a local full-detector image. Missing/invalid files are skipped (logged)."""
        path = path.expanduser()
        if not path.is_file():
            return False
        try:
            with fits.open(path, memmap=True, lazy_load_hdus=True) as hdul:
                self.register(calibration_from_hdul(hdul))
            return True
        except (OSError, CalibrationError) as exc:
            log.warning("calibration seed %s ignored: %s", path.name, exc)
            return False

    # -- persistence ---------------------------------------------------------------------------
    def _save_disk(self, cal: DetectorCalibration) -> None:
        if self._dir is None:
            return
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            target = self._dir / f"{cal.detector}_{re.sub(r'[^A-Za-z0-9_.-]', '_', cal.version)}.npz"
            tmp = target.with_suffix(f".{threading.get_ident()}.tmp")
            with tmp.open("wb") as fh:
                np.savez(fh, detector=cal.detector, version=cal.version, x=cal.x, y=cal.y, wl=cal.wavelength_um, bw=cal.bandwidth_um)
            tmp.replace(target)
        except OSError as exc:
            log.warning("could not persist calibration %s %s: %s", cal.detector, cal.version, exc)

    def _load_disk(self) -> None:
        assert self._dir is not None
        for path in sorted(self._dir.glob("D?_*.npz")) if self._dir.is_dir() else []:
            try:
                with np.load(path, allow_pickle=False) as z:
                    cal = DetectorCalibration(str(z["detector"]), str(z["version"]), z["x"], z["y"], z["wl"], z["bw"])
                if cal.wavelength_um.shape != (cal.y.size, cal.x.size) or not np.all(np.isfinite(cal.wavelength_um)):
                    raise ValueError("inconsistent arrays")
                self._items.setdefault(cal.detector, {})[cal.version] = cal
                self._latest[cal.detector] = cal.version
            except (OSError, ValueError, KeyError) as exc:
                log.warning("discarding unreadable calibration cache %s: %s", path.name, exc)
