"""A synthetic SPHEREx archive: full detectors with known WCS/sources/calibration, served like IRSA (SIA2 + cutouts).

Everything the dynamic pipeline needs exists here with known ground truth, so the real 65 MB images are not
required. Sources are placed with astropy's forward WCS (SIP included) of each detector's own solution.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
from astropy.io import fits
from astropy.io.votable import from_table
from astropy.table import Table
from astropy.wcs import WCS, Sip

SCALE = 6.15
HOST = "https://irsa.ipac.caltech.edu"
FLAG_BITS = {"OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "HOT": 10, "COLD": 11, "OUTLIER": 19, "SOURCE": 21, "STREAK": 25, "HALO": 28, "TRANSIENT": 0}
CALIBRATION_ID = "cal-test-0001"


def rotation_cd(roll_deg: float, sip_free: bool = True) -> np.ndarray:
    step = SCALE / 3600.0
    c, s = math.cos(math.radians(roll_deg)), math.sin(math.radians(roll_deg))
    return np.array([[-step * c, step * s], [step * s, step * c]])


@dataclass
class FakeDetector:
    obs_id: str
    detector: int
    mjd: float
    target: tuple[float, float]  # sky position that lands on `target_pixel`
    target_pixel: tuple[float, float]  # zero-based full-detector pixel
    roll: float = 0.0
    n: int = 400
    sip: bool = False
    sources: tuple[tuple[float, float, float], ...] = ()  # (ra, dec, amplitude)
    background: float = 0.15
    lam: tuple[float, float] = (1.80, 1.96)  # µm at detector row 1 and row n (about 0.4 nm/px, like the real D3 grid)
    bandwidth: float = 0.046
    flag_boxes: tuple[tuple[str, tuple[int, int, int, int]], ...] = ()  # name, (y0, y1, x0, x1)
    nan_box: tuple[int, int, int, int] | None = None
    variance_box: tuple[int, int, int, int] | None = None  # variance forced to 0 here
    calibration_id: str = CALIBRATION_ID
    poison: bool = False  # IRSA "returns" garbage instead of FITS
    wcs: WCS = field(init=False)
    data: np.ndarray = field(init=False)
    flags: np.ndarray = field(init=False)
    variance: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        # Like the real full images, CRPIX is the geometric centre ((n+1)/2); CRVAL is chosen so the requested
        # target lands on `target_pixel`. (A temporary solution anchored on the target gives the centre's sky position.)
        def build(crval, crpix, with_sip):
            w = WCS(naxis=2)
            w.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"] if with_sip else ["RA---TAN", "DEC--TAN"]
            w.wcs.crval = list(crval)
            w.wcs.crpix = list(crpix)
            w.wcs.cd = rotation_cd(self.roll)
            w.wcs.cunit = ["deg", "deg"]
            if with_sip:
                a, b = np.zeros((3, 3)), np.zeros((3, 3))
                a[2, 0], a[1, 1] = 1.5e-4, -1.0e-4
                b[0, 2], b[1, 1] = -1.2e-4, 8.0e-5
                w.sip = Sip(a, b, None, None, w.wcs.crpix)
            return w

        centre = ((self.n - 1) / 2, (self.n - 1) / 2)
        anchor = build(self.target, (self.target_pixel[0] + 1, self.target_pixel[1] + 1), False)
        crval = [float(v) for v in anchor.all_pix2world(*centre, 0)]
        for _ in range(6):  # refine: a different tangent point shifts the target by a fraction of a pixel
            w = build(crval, ((self.n + 1) / 2, (self.n + 1) / 2), self.sip)
            got = [float(v) for v in w.all_world2pix(*self.target, 0)]
            err = (self.target_pixel[0] - got[0], self.target_pixel[1] - got[1])
            crval = [float(v) for v in w.all_pix2world(centre[0] - err[0], centre[1] - err[1], 0)]
        w = build(crval, ((self.n + 1) / 2, (self.n + 1) / 2), self.sip)
        self.wcs = w
        yy, xx = np.mgrid[0:self.n, 0:self.n].astype(float)
        img = np.full((self.n, self.n), self.background, dtype=np.float32)
        for ra, dec, amp in self.sources:
            x, y = w.all_world2pix(ra, dec, 0)
            img += (amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.6**2))).astype(np.float32)
        if self.nan_box:
            y0, y1, x0, x1 = self.nan_box
            img[y0:y1, x0:x1] = np.nan
        self.data = img
        flags = np.zeros((self.n, self.n), dtype=np.int32)
        for name, (y0, y1, x0, x1) in self.flag_boxes:
            flags[y0:y1, x0:x1] |= 1 << FLAG_BITS[name]
        self.flags = flags
        var = np.full((self.n, self.n), 1e-4, dtype=np.float32)
        if self.variance_box:
            y0, y1, x0, x1 = self.variance_box
            var[y0:y1, x0:x1] = 0.0
        self.variance = var

    # -- archive-side views ------------------------------------------------------------------------
    @property
    def corners_sky(self) -> np.ndarray:
        px = np.array([[0, 0], [self.n - 1, 0], [self.n - 1, self.n - 1], [0, self.n - 1]], dtype=float)
        ra, dec = self.wcs.all_pix2world(px[:, 0], px[:, 1], 0)
        return np.column_stack((ra % 360, dec))

    def contains(self, ra: float, dec: float) -> bool:
        x, y = (float(v) for v in self.wcs.all_world2pix(ra, dec, 0))
        return bool(0 <= x <= self.n - 1 and 0 <= y <= self.n - 1)

    def true_wavelength_at(self, x0: float, y0: float) -> float:
        return self.lam[0] + (y0 + 1 - 1) / (self.n - 1) * (self.lam[1] - self.lam[0])

    def calibration_hdu(self) -> fits.BinTableHDU:
        grid_x = np.linspace(1, self.n, 9).round().astype(np.int32)
        grid_y = np.linspace(1, self.n, 14).round().astype(np.int32)
        values = np.zeros((14, 9, 2), dtype=np.float32)
        values[..., 0] = (self.lam[0] + (grid_y - 1) / (self.n - 1) * (self.lam[1] - self.lam[0]))[:, None]
        values[..., 1] = self.bandwidth
        return fits.BinTableHDU.from_columns(
            [fits.Column(name="X", format="9J", array=grid_x[None, :]), fits.Column(name="Y", format="14J", array=grid_y[None, :]),
             fits.Column(name="VALUES", format="252E", dim="(2,9,14)", array=values[None, ...])], name="WCS-WAVE")

    def cutout_bytes(self, ra: float, dec: float, size_deg: float) -> bytes:
        if self.poison:
            return b"<html>definitely not FITS</html>"
        x, y = (float(v) for v in self.wcs.all_world2pix(ra, dec, 0))
        half = int(math.ceil(size_deg * 3600 / SCALE / 2))
        x0, x1 = max(0, int(round(x)) - half), min(self.n, int(round(x)) + half + 1)
        y0, y1 = max(0, int(round(y)) - half), min(self.n, int(round(y)) + half + 1)
        header = self.wcs.to_header(relax=True)
        header["CRPIX1"] = float(self.wcs.wcs.crpix[0]) - x0  # the cutout keeps the full image's sky solution, shifts CRPIX
        header["CRPIX2"] = float(self.wcs.wcs.crpix[1]) - y0
        header["BUNIT"], header["DETECTOR"], header["OBSID"] = "MJy / sr", self.detector, self.obs_id
        header["RADESYS"] = "ICRS"
        header["DATE-OBS"] = f"{_iso(self.mjd)}T01:00:00.000"
        header["MJD-OBS"] = self.mjd
        header["HISTORY"] = f"[CALIB] spectral_wcs {self.calibration_id}"
        flag_header = fits.Header()
        for name, bit in FLAG_BITS.items():
            flag_header[f"MSKN{bit:04d}"] = name
        hdus = fits.HDUList([
            fits.PrimaryHDU(), fits.ImageHDU(self.data[y0:y1, x0:x1], header=header, name="IMAGE"),
            fits.ImageHDU(self.flags[y0:y1, x0:x1], header=flag_header, name="FLAGS"),
            fits.ImageHDU(self.variance[y0:y1, x0:x1], name="VARIANCE"), self.calibration_hdu(),
        ])
        buffer = io.BytesIO()
        hdus.writeto(buffer)
        return buffer.getvalue()


def _iso(mjd: float) -> str:
    from astropy.time import Time
    return Time(mjd, format="mjd").isot[:10]


class FakeArchive:
    """IRSA stand-in. ``install`` registers SIA and cutout routes on a respx router and records every request."""

    def __init__(self) -> None:
        self.detectors: dict[str, FakeDetector] = {}
        self.sia_requests: list[dict] = []
        self.downloads: list[tuple[str, float, float, float]] = []
        self.sia_status: list[int] = []  # popped one per SIA request before answering normally
        self.cutout_status: dict[str, list[int]] = {}
        self.duplicate_rows = True  # the real archive lists every observation twice

    def add(self, **kw) -> FakeDetector:
        det = FakeDetector(**kw)
        self.detectors[det.obs_id] = det
        return det

    def votable(self, ra: float, dec: float) -> bytes:
        rows = []
        for d in self.detectors.values():
            if not d.contains(ra, dec):
                continue
            region = "POLYGON ICRS " + " ".join(f"{v:.10f}" for v in d.corners_sky.ravel()) + f" {d.corners_sky[0, 0]:.10f} {d.corners_sky[0, 1]:.10f}"
            row = dict(s_ra=ra, s_dec=dec, energy_bandpassname=f"SPHEREx-D{d.detector}", obs_id=d.obs_id, em_min=1.6e-6, em_max=2.4e-6,
                       access_url=f"{HOST}/ibe/data/spherex/dr1/level2/{d.obs_id[:9]}/l2b-v27-2026-198/{d.detector}/level2_{d.obs_id}D{d.detector}.fits",
                       s_region=region, s_xel1=d.n, s_xel2=d.n, s_pixel_scale=SCALE, t_min=d.mjd)
            rows.append(row)
            if self.duplicate_rows:
                rows.append(dict(row))
        table = Table(rows=rows, names=list(rows[0])) if rows else Table(names=["obs_id"], dtype=["U10"])
        buffer = io.BytesIO()
        from_table(table).to_xml(buffer)
        return buffer.getvalue()

    def install(self, router) -> None:
        def sia(request: httpx.Request) -> httpx.Response:
            q = parse_qs(urlparse(str(request.url)).query)
            self.sia_requests.append({k: v[0] for k, v in q.items()})
            if self.sia_status:
                status = self.sia_status.pop(0)
                if status:
                    return httpx.Response(status, text="Proxy Error")
            _, ra, dec, _r = q["POS"][0].split()
            return httpx.Response(200, content=self.votable(float(ra), float(dec)), headers={"content-type": "application/x-votable+xml"})

        def ibe(request: httpx.Request) -> httpx.Response:
            url = urlparse(str(request.url))
            q = parse_qs(url.query)
            ra, dec = (float(v.rstrip("d")) for v in q["center"][0].split(","))
            size = float(q["size"][0])
            obs_id = next(o for o in self.detectors if f"level2_{o}D" in url.path)
            self.downloads.append((obs_id, ra, dec, size))
            queue = self.cutout_status.get(obs_id, [])
            if queue:
                status = queue.pop(0)
                if status:
                    return httpx.Response(status, text="unavailable")
            return httpx.Response(200, content=self.detectors[obs_id].cutout_bytes(ra, dec, size))

        router.get(f"{HOST}/SIA").mock(side_effect=sia)
        router.get(url__regex=rf"{HOST}/ibe/.*").mock(side_effect=ibe)
