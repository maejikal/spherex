"""Constellation membership and geometry use local, real astronomical data."""
import math

import pytest
from astropy import units as u
from astropy.coordinates import PrecessedGeocentric, SkyCoord
from astropy.time import Time


@pytest.mark.parametrize('ra,dec,name,abbreviation', [
    (83.822, -5.391, 'Orion', 'Ori'),
    (10.6847, 41.2688, 'Andromeda', 'And'),
    (0, 90, 'Ursa Minor', 'UMi'),
    (359.999, -90, 'Octans', 'Oct'),
    (0, 0, 'Pisces', 'Psc'),
    (359.999, 0, 'Pisces', 'Psc'),
    (239, 8, 'Serpens', 'Ser'),
    (278, 1, 'Serpens', 'Ser'),
])
def test_membership(client, upstream, ra, dec, name, abbreviation):
    response = client.get('/api/constellations/at', params={'ra': ra, 'dec': dec})
    assert response.status_code == 200
    data = response.json()
    assert data['name'] == name
    assert data['abbreviation'] == abbreviation
    assert data['ra'] == ra and data['dec'] == dec
    assert data['coordinate_system'] == 'ICRS'
    assert data['learn_url'].startswith('https://en.wikipedia.org/wiki/')
    assert data['boundary_source'].startswith('https://')
    assert data['boundary']
    for ring in data['boundary']:
        assert len(ring) >= 4
        assert ring[0] == ring[-1]
        for x, y in ring:
            assert math.isfinite(x) and 0 <= x < 360
            assert math.isfinite(y) and -90 <= y <= 90


@pytest.mark.parametrize('ra,dec', [(-1, 0), (360, 0), (0, 90.01), (0, -91), ('nan', 0), (0, 'inf')])
def test_invalid_coordinates(client, ra, dec):
    response = client.get('/api/constellations/at', params={'ra': ra, 'dec': dec})
    assert response.status_code == 422
    assert response.json()['error']['code'] == 'invalid_parameters'


def test_historical_boundary_transform(client):
    # Roman table: at B1875 Dec=0, Pisces ends at RA=0h20m, Cetus starts.
    frame = PrecessedGeocentric(equinox=Time('B1875'))
    for hours, name in [(0.332, 'Pisces'), (0.335, 'Cetus')]:
        position = SkyCoord(ra=hours * u.hourangle, dec=0 * u.deg, frame=frame).icrs
        data = client.get('/api/constellations/at', params={'ra': position.ra.deg, 'dec': position.dec.deg}).json()
        assert data['name'] == name


def test_serpens_keeps_disconnected_boundaries(client):
    data = client.get('/api/constellations/at?ra=239&dec=8').json()
    assert len(data['boundary']) == 2


def test_all_88_constellations_have_local_geometry_and_article_links():
    import numpy as np
    from astropy.coordinates import get_constellation
    from app.services.constellations import constellation_at

    ra, dec = np.meshgrid(np.arange(0, 360, 2), np.arange(-88, 89, 2))
    positions = SkyCoord(ra=ra.ravel() * u.deg, dec=dec.ravel() * u.deg, frame='icrs')
    codes = get_constellation(positions, short_name=True)
    unique, indices = np.unique(codes, return_index=True)
    assert len(unique) == 88
    for index in indices:
        data = constellation_at(float(positions[index].ra.deg), float(positions[index].dec.deg))
        assert data.boundary
        assert data.name not in ('Ophiucus', 'Chamaleon', 'Pisces Austrinus')
        assert data.learn_url.startswith('https://en.wikipedia.org/wiki/')


def test_boundary_matches_transformed_official_vertex():
    from app.services.constellations import constellation_boundary
    # Verify bundled CDS vertex transformation independently.
    from pathlib import Path
    rows = (Path(__file__).parents[1] / 'app/data/constellations/bound_18.dat').read_text().splitlines()
    first = next(row.split() for row in rows if 'ORI' in row)
    expected = SkyCoord(float(first[0]) * u.hourangle, float(first[1]) * u.deg,
                        frame=PrecessedGeocentric(equinox=Time('B1875'))).icrs
    actual = constellation_boundary('Ori')[0][0]
    assert SkyCoord(actual[0] * u.deg, actual[1] * u.deg).separation(expected).arcsec < 0.001


def test_octans_outline_has_no_artificial_meridian_to_south_pole():
    from app.services.constellations import constellation_boundary
    ring = constellation_boundary('Oct')[0]
    # True boundary stays at B1875 Dec >= -85; artificial projection seam reaches -90.
    positions = SkyCoord([p[0] for p in ring] * u.deg, [p[1] for p in ring] * u.deg).transform_to(
        PrecessedGeocentric(equinox=Time('B1875')))
    assert positions.dec.deg.min() > -85.001
