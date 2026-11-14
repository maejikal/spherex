"""Bounded retry with exponential backoff and jitter for transient upstream failures."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

import httpx

T = TypeVar("T")

RETRYABLE_STATUS = frozenset({502, 503, 504})
# Read timeouts are deliberately *not* retried: they already consumed the full read budget.
RETRYABLE_EXCEPTIONS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError, httpx.PoolTimeout)


class RetryableStatus(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"retryable upstream status {status}")
        self.status = status


async def with_retries(
    operation: Callable[[], Awaitable[T]],
    *,
    retries: int,
    backoff_base: float,
) -> T:
    attempt = 0
    while True:
        try:
            return await operation()
        except (*RETRYABLE_EXCEPTIONS, RetryableStatus):
            if attempt >= retries:
                raise
            delay = backoff_base * (2**attempt) * (0.5 + random.random())
            attempt += 1
            if delay > 0:
                await asyncio.sleep(delay)
