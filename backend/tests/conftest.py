from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
import respx
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

SDSS_JPEG = "https://skyserver.sdss.org/dr18/SkyServerWS/ImgCutout/getjpeg"
SDSS_SQL = "https://skyserver.sdss.org/dr18/SkyServerWS/SearchTools/SqlSearch"
SESAME = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV"


def make_jpeg(width: int = 64, height: int = 64, color=(20, 40, 90)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, format="JPEG")
    return buffer.getvalue()


def sesame_xml(oname="M 31", ra="10.6847083", dec="41.26875", otype="AGN", resolver="S=Simbad, IDIA (via url)") -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SNV"><name>x</name>
<Resolver name="{resolver}"><oname>{oname}</oname><otype>{otype}</otype>
<jradeg>{ra}</jradeg><jdedeg>{dec}</jdedeg></Resolver></Target></Sesame>""".encode()


SESAME_NOT_FOUND = b"""<?xml version="1.0"?><Sesame><Target option="SNV"><name>q</name>
<INFO> *** NNNothing found *** </INFO></Target></Sesame>"""


def sql_payload(rows: list[dict]) -> list[dict]:
    return [{"TableName": "Table1", "Rows": rows}, {"TableName": "SqlQuery", "Rows": [{"query": "..."}]}]


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        cache_dir=tmp_path / "cache",
        retry_backoff_base=0.0,
        max_retries=2,
    )


@pytest.fixture
def make_client(settings):
    clients = []

    def factory(**overrides) -> TestClient:
        cfg = settings.model_copy(update=overrides) if overrides else settings
        client = TestClient(create_app(cfg), raise_server_exceptions=False)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def upstream():
    """All outbound httpx traffic is intercepted; unmocked requests fail the test."""
    with respx.mock(assert_all_called=False) as mock:
        yield mock
