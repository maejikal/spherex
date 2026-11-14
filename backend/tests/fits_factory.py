"""Builds small synthetic SPHEREx-like FITS exposures with a known WCS and known sources.

Sources are placed with astropy's *forward* sky-to-pixel transform of the exposure's own WCS (SIP
included), so the sky position of every star is known independently of the code under test.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, Sip

PIXEL_SCALE_ARCSEC = 6.15
FLAG_BITS = {"NONFUNC": 6, "SOURCE": 21, "SNOWBALL": 27}


def make_wcs(centre: tuple[float, float], size: int, *, roll_deg: float = 0.0, sip: bool = False) -> WCS:
    """TAN (optionally TAN-SIP) WCS, north-up/east-left rotated by ``roll_deg`` about the centre."""
    step = PIXEL_SCALE_ARCSEC / 3600.0
    c, s = math.cos(math.radians(roll_deg)), math.sin(math.radians(roll_deg))
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"] if sip else ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = list(centre)
    wcs.wcs.crpix = [(size + 1) / 2.0 + 3.0, (size + 1) / 2.0 - 2.0]  # deliberately not the array centre
    wcs.wcs.cd = np.array([[-step * c, step * s], [step * s, step * c]])
    wcs.wcs.cunit = ["deg", "deg"]
    if sip:
        # Strong distortion (several pixels within ~30 px of the reference point) so ignoring it is detectable.
        a = np.zeros((3, 3))
        b = np.zeros((3, 3))
        a[2, 0], a[1, 1] = 1.5e-2, -1.0e-2
        b[0, 2], b[1, 1] = -1.2e-2, 8.0e-3
        wcs.sip = Sip(a, b, None, None, wcs.wcs.crpix)
    return wcs


def make_exposure(
    path: Path,
    *,
    centre: tuple[float, float] = (150.0, 40.0),
    size: int = 200,
    roll_deg: float = 0.0,
    sip: bool = False,
    sources: tuple[tuple[float, float, float], ...] = (),  # (ra, dec, peak amplitude MJy/sr)
    background: float = 0.15,
    sigma_px: float = 1.6,
    date_obs: str = "2025-05-24T21:54:42.018",
    mjd: float = 60819.912986319,
    obsid: str = "TEST_A",
    bunit: str = "MJy / sr",
    nan_box: tuple[int, int, int, int] | None = None,  # (y0, y1, x0, x1)
    flag_boxes: tuple[tuple[str, tuple[int, int, int, int]], ...] = (),
    wave_by_row: tuple[float, float] | None = None,  # (wavelength at row 1, at last row), µm
    include_flags: bool = True,
) -> WCS:
    """Write the exposure and return its WCS (the ground truth for placing/locating sources)."""
    wcs = make_wcs(centre, size, roll_deg=roll_deg, sip=sip)
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    image = np.full((size, size), background, dtype=np.float32)
    for ra, dec, amplitude in sources:
        x, y = wcs.all_world2pix(ra, dec, 0)
        image += (amplitude * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma_px**2))).astype(np.float32)
    if nan_box:
        y0, y1, x0, x1 = nan_box
        image[y0:y1, x0:x1] = np.nan

    header = wcs.to_header(relax=True)
    header["BUNIT"] = bunit
    header["DETECTOR"] = 5
    header["OBSID"] = obsid
    header["DATE-OBS"] = date_obs
    header["MJD-OBS"] = mjd
    header["RADESYS"] = "ICRS"
    hdus: list[fits.hdu.base.ExtensionHDU | fits.PrimaryHDU] = [fits.PrimaryHDU()]
    hdus.append(fits.ImageHDU(image, header=header, name="IMAGE"))

    if include_flags:
        flags = np.zeros((size, size), dtype=np.int32)
        flag_header = fits.Header()
        for name, bit in FLAG_BITS.items():
            flag_header[f"MSKN{bit:04d}"] = name
        for name, (y0, y1, x0, x1) in flag_boxes:
            flags[y0:y1, x0:x1] |= 1 << FLAG_BITS[name]
        hdus.append(fits.ImageHDU(flags, header=flag_header, name="FLAGS"))

    if wave_by_row:
        grid = np.linspace(1, size, 11).round().astype(np.int32)
        values = np.zeros((11, 11, 2), dtype=np.float32)
        values[..., 0] = np.linspace(wave_by_row[0], wave_by_row[1], 11)[:, None]
        values[..., 1] = 0.04
        table = fits.BinTableHDU.from_columns(
            [
                fits.Column(name="X", format="11J", array=grid[None, :]),
                fits.Column(name="Y", format="11J", array=grid[None, :]),
                fits.Column(name="VALUES", format="242E", dim="(2,11,11)", array=values[None, ...].reshape(1, 11, 11, 2)),
            ],
            name="WCS-WAVE",
        )
        hdus.append(table)

    fits.HDUList(hdus).writeto(path, overwrite=True)
    return wcs


def offset_sky(centre: tuple[float, float], east_arcsec: float, north_arcsec: float) -> tuple[float, float]:
    """Sky position displaced from ``centre`` (small offsets; exact enough for sub-0.1 px at arcmin scales)."""
    dec = centre[1] + north_arcsec / 3600.0
    ra = centre[0] + east_arcsec / 3600.0 / math.cos(math.radians(centre[1]))
    return ra, dec
