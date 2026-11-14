"""Display processing for aligned cutouts: robust background, one shared stretch, PNG encoding.

This is *display* normalisation only, not photometric calibration. Calibrated arrays from
``fits_cutout`` are never modified; these functions return new 8-bit images.

What is and is not done, deliberately:

* An **additive** background offset (the median of each frame's valid pixels) is removed per frame,
  because the two exposures sit on different zodiacal/sky backgrounds (about 0.15 vs 0.19 MJy/sr in the
  real files) and that offset would otherwise dominate any blink.
* **No multiplicative rescaling** is applied. A source that really brightened between the exposures keeps
  its brightness difference; only the sky level is matched.
* One **common** clip range and asinh stretch is derived from both frames pooled together and applied to
  both, so equal pixel values look identical in both frames.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .fits_cutout import ResampledFrame

LOW_PERCENTILE = 1.0
HIGH_PERCENTILE = 99.7
ASINH_SOFTENING = 10.0
MIN_PIXELS_FOR_STATS = 16


@dataclass(frozen=True)
class DisplayParameters:
    background: tuple[float | None, ...]  # per frame, MJy/sr (None if the frame has too few valid pixels)
    low: float  # MJy/sr above background mapped to black
    high: float  # MJy/sr above background mapped to white
    asinh_softening: float


def robust_background(values: np.ndarray, valid: np.ndarray) -> float | None:
    """Median of the valid pixels: insensitive to the stars and bad pixels in the field."""
    selected = values[valid]
    selected = selected[np.isfinite(selected)]
    if selected.size < MIN_PIXELS_FOR_STATS:
        return None
    return float(np.median(selected))


def compute_display_parameters(frames: tuple[ResampledFrame, ...]) -> DisplayParameters:
    """Background per frame, and one clip range from the pooled background-subtracted pixels."""
    backgrounds = [robust_background(f.values, f.valid) for f in frames]
    pooled = [
        f.values[f.valid].astype(np.float64) - bg
        for f, bg in zip(frames, backgrounds)
        if bg is not None
    ]
    pooled_values = np.concatenate(pooled) if pooled else np.empty(0)
    pooled_values = pooled_values[np.isfinite(pooled_values)]
    if pooled_values.size < MIN_PIXELS_FOR_STATS:
        return DisplayParameters(tuple(backgrounds), -1.0, 1.0, ASINH_SOFTENING)
    low, high = (float(v) for v in np.percentile(pooled_values, [LOW_PERCENTILE, HIGH_PERCENTILE]))
    if not np.isfinite(low) or not np.isfinite(high) or high - low <= 1e-12 * max(1.0, abs(high), abs(low)):
        # A (nearly) constant field has no contrast to stretch: use a symmetric range so it renders as
        # a uniform mid-grey instead of dividing by zero.
        centre = 0.5 * (low + high) if np.isfinite(low) and np.isfinite(high) else 0.0
        half = max(abs(centre) * 1e-3, 1e-6)
        low, high = centre - half, centre + half
    return DisplayParameters(tuple(backgrounds), low, high, ASINH_SOFTENING)


def stretch_to_uint8(values: np.ndarray, valid: np.ndarray, background: float | None, params: DisplayParameters) -> np.ndarray:
    """Background-subtract, clip to the common range and apply an asinh stretch. Invalid pixels -> 0."""
    out = np.zeros(values.shape, dtype=np.uint8)
    if background is None or not valid.any():
        return out
    span = params.high - params.low
    t = np.clip((values.astype(np.float64) - background - params.low) / span, 0.0, 1.0)
    a = params.asinh_softening
    stretched = np.arcsinh(a * t) / np.arcsinh(a)
    out[valid] = np.round(stretched[valid] * 255.0).astype(np.uint8)
    return out


def render_png(gray: np.ndarray, valid: np.ndarray) -> bytes:
    """Greyscale+alpha PNG, north up. Invalid pixels are transparent so they are never mistaken for sky.

    Array row 0 is the southern edge (Dec increases with row), so the image is flipped vertically.
    """
    alpha = np.where(valid, 255, 0).astype(np.uint8)
    pixels = np.dstack([gray, alpha])
    image = Image.fromarray(np.ascontiguousarray(np.flipud(pixels)))  # (H, W, 2) uint8 -> mode "LA"
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=6)
    return buffer.getvalue()


def render_frames(frames: tuple[ResampledFrame, ...]) -> tuple[list[bytes], DisplayParameters]:
    params = compute_display_parameters(frames)
    images = [
        render_png(stretch_to_uint8(f.values, f.valid, bg, params), f.valid)
        for f, bg in zip(frames, params.background)
    ]
    return images, params
