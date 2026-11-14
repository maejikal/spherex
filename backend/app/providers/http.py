"""Shared bounded, validated upstream HTTP helpers."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

from ..models.errors import UpstreamInvalidResponse, UpstreamTimeout, UpstreamUnavailable
from ..utils.retry import RETRYABLE_STATUS, RetryableStatus, with_retries


@dataclass(frozen=True, slots=True)
class UpstreamResponse:
    status: int
    content_type: str
    headers: httpx.Headers
    body: bytes
    url: str


class UpstreamClient:
    """Wraps ``httpx.AsyncClient``: concurrency cap, retries, response-size limit, error mapping."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        service: str,
        retries: int,
        backoff_base: float,
        semaphore: asyncio.Semaphore,
    ) -> None:
        self._client = client
        self._service = service
        self._retries = retries
        self._backoff = backoff_base
        self._semaphore = semaphore

    async def get(
        self,
        url: str,
        *,
        params: dict[str, str] | None = None,
        max_bytes: int,
        accept: str,
    ) -> UpstreamResponse:
        async def attempt() -> UpstreamResponse:
            async with self._client.stream("GET", url, params=params, headers={"Accept": accept}) as response:
                if response.status_code in RETRYABLE_STATUS:
                    raise RetryableStatus(response.status_code)
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise UpstreamInvalidResponse(f"{self._service} response exceeded the size limit.")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise UpstreamInvalidResponse(f"{self._service} response exceeded the size limit.")
                    chunks.append(chunk)
                content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                return UpstreamResponse(
                    status=response.status_code,
                    content_type=content_type,
                    headers=response.headers,
                    body=b"".join(chunks),
                    url=str(response.url),
                )

        try:
            async with self._semaphore:
                return await with_retries(attempt, retries=self._retries, backoff_base=self._backoff)
        except httpx.TimeoutException as exc:
            raise UpstreamTimeout(f"{self._service} did not respond in time.") from exc
        except RetryableStatus as exc:
            raise UpstreamUnavailable(f"{self._service} is unavailable (HTTP {exc.status}).") from exc
        except httpx.HTTPError as exc:
            raise UpstreamUnavailable(f"Could not reach {self._service}.") from exc
