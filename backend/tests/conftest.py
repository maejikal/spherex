from __future__ import annotations

import sys
from pathlib import Path

import pytest
import respx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

HIPS = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
PROPERTIES_URL = f"{HIPS}/properties"
SIMBAD_PRIMARY = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"
SIMBAD_MIRROR = "https://simbad.harvard.edu/simbad/sim-tap/sync"
SESAME = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV"

# The real IRSA wavelength table (fetched 2026-11-14).
WAVELENGTHS = (
    "0.753 0.771 0.790 0.809 0.828 0.848 0.868 0.889 0.910 0.932 0.955 0.978 1.001 1.025 1.050 1.075 1.102 1.113 "
    "1.139 1.167 1.195 1.224 1.254 1.284 1.315 1.346 1.378 1.412 1.446 1.481 1.517 1.554 1.592 1.631 1.656 1.695 "
    "1.735 1.775 1.818 1.861 1.905 1.949 1.995 2.041 2.089 2.139 2.189 2.240 2.292 2.345 2.399 2.445 2.506 2.575 "
    "2.646 2.719 2.794 2.871 2.951 3.033 3.118 3.204 3.293 3.383 3.476 3.570 3.667 3.768 3.833 3.867 3.901 3.935 "
    "3.970 4.005 4.040 4.076 4.112 4.148 4.184 4.220 4.257 4.294 4.331 4.368 4.405 4.435 4.467 4.500 4.533 4.566 "
    "4.600 4.635 4.669 4.704 4.739 4.773 4.808 4.843 4.879 4.915 4.951 4.988"
)

PROPERTIES = f"""hips_initial_fov     = 359.620
creator_did          = ivo://IPAC/P/SPHEREx/DR1/cube
#hips_creator        = HiPS creator (institute or person)
obs_title            = SPHEREx DR1 all-sky data cube
hips_version         = 1.4
hips_frame           = equatorial
hips_order           = 5
hips_order_min       = 0
hips_tile_width      = 512
hips_tile_format     = png
dataproduct_type     = cube
hips_cube_depth      = 102
hips_cube_firstframe = 1
obs_collection       = SPHEREx DR1
em_min               = 7.430000e-07
em_max               = 5.009000e-06
hips_initial_ra      = 180.00000
hips_initial_dec     = -57.99462
data_cube_bunit3     = um
data_cube_crval3_arr = {WAVELENGTHS}
t_min                = 60789.75076
t_max                = 61174.49276
obs_description      = SPHEREx DR1 all-sky data cube for visualization: 102 frames in ascending wavelength, one per band (1-6) and channel (1-17), frame index = 17*(band-1) + (channel-1). Frames 50 and 51 (band 3 channel 17, band 4 channel 1, the dichroic channels) are blank. See the SPHEREx Explanatory Supplement.
moc_sky_fraction     = 1.000000
"""


def sesame_xml(oname="M 31", ra="10.6847083", dec="41.26875", otype="AGN", resolver="S=Simbad, IDIA (via url)") -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SNV"><name>x</name>
<Resolver name="{resolver}"><oname>{oname}</oname><otype>{otype}</otype>
<jradeg>{ra}</jradeg><jdedeg>{dec}</jdedeg></Resolver></Target></Sesame>""".encode()


SESAME_NOT_FOUND = b"""<?xml version="1.0"?><Sesame><Target option="SNV"><name>q</name>
<INFO> *** NNNothing found *** </INFO></Target></Sesame>"""


def tap_json(rows: list[list]) -> dict:
    """SIMBAD TAP JSON as returned by the real service (columns match SimbadCatalogue's query)."""
    names = ["main_id", "ra", "dec", "otype", "otype_description", "dist"]
    return {"metadata": [{"name": n} for n in names], "data": rows}


@pytest.fixture
def settings() -> Settings:
    return Settings(_env_file=None, retry_backoff_base=0.0, max_retries=2)


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
