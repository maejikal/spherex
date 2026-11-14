"""Application error types and the single JSON error envelope used by every route."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    error: ErrorBody


class AppError(Exception):
    """Base class: carries a machine-readable code, a safe message and an HTTP status."""

    code = "internal_error"
    status_code = 500

    def __init__(self, message: str, *, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.headers = headers

    def envelope(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message}}


class InvalidParameters(AppError):
    code = "invalid_parameters"
    status_code = 422


class UnsupportedSurvey(AppError):
    code = "unsupported_survey"
    status_code = 400


class NoCoverage(AppError):
    code = "no_coverage"
    status_code = 404


class FitsNoCoverage(AppError):
    """The local SPHEREx exposures do not usefully cover the requested sky region."""

    code = "no_fits_coverage"
    status_code = 404


class FitsUnavailable(AppError):
    """A configured FITS file is missing or is not a usable SPHEREx image."""

    code = "fits_unavailable"
    status_code = 503


class FitsProcessingError(AppError):
    code = "fits_processing_error"
    status_code = 500


class ObjectNotFound(AppError):
    code = "object_not_found"
    status_code = 404


class UpstreamTimeout(AppError):
    code = "upstream_timeout"
    status_code = 504


class UpstreamUnavailable(AppError):
    code = "upstream_unavailable"
    status_code = 502


class UpstreamInvalidResponse(AppError):
    code = "upstream_invalid_response"
    status_code = 502


class CatalogueUnavailable(AppError):
    code = "catalogue_unavailable"
    status_code = 502


class InternalError(AppError):
    code = "internal_error"
    status_code = 500
