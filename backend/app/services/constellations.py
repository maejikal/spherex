"""Local IAU membership and boundary geometry, independent of imagery/catalogues."""
from functools import lru_cache
from itertools import groupby
from math import ceil
from pathlib import Path
from urllib.parse import quote

from astropy import units as u
from astropy.coordinates import PrecessedGeocentric, SkyCoord, get_constellation
from astropy.time import Time

from ..models.responses import ConstellationResponse

DATA_FILE = Path(__file__).resolve().parents[1] / 'data/constellations/bound_18.dat'
BOUNDARY_SOURCE = 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VI/49'
B1875 = PrecessedGeocentric(equinox=Time('B1875'))
# Explicit article titles where the unqualified Latin name is ambiguous.
ARTICLE_TITLES = {
    'Andromeda': 'Andromeda (constellation)', 'Antlia': 'Antlia', 'Apus': 'Apus',
    'Aquarius': 'Aquarius (constellation)', 'Aquila': 'Aquila (constellation)', 'Ara': 'Ara (constellation)',
    'Aries': 'Aries (constellation)', 'Auriga': 'Auriga (constellation)', 'Boötes': 'Boötes',
    'Caelum': 'Caelum', 'Camelopardalis': 'Camelopardalis', 'Cancer': 'Cancer (constellation)',
    'Canes Venatici': 'Canes Venatici', 'Canis Major': 'Canis Major', 'Canis Minor': 'Canis Minor',
    'Capricornus': 'Capricornus', 'Carina': 'Carina (constellation)', 'Cassiopeia': 'Cassiopeia (constellation)',
    'Centaurus': 'Centaurus', 'Cepheus': 'Cepheus (constellation)', 'Cetus': 'Cetus',
    'Chamaeleon': 'Chamaeleon', 'Circinus': 'Circinus', 'Columba': 'Columba (constellation)',
    'Coma Berenices': 'Coma Berenices', 'Corona Australis': 'Corona Australis', 'Corona Borealis': 'Corona Borealis',
    'Corvus': 'Corvus (constellation)', 'Crater': 'Crater (constellation)', 'Crux': 'Crux',
    'Cygnus': 'Cygnus (constellation)', 'Delphinus': 'Delphinus', 'Dorado': 'Dorado',
    'Draco': 'Draco (constellation)', 'Equuleus': 'Equuleus', 'Eridanus': 'Eridanus (constellation)',
    'Fornax': 'Fornax', 'Gemini': 'Gemini (constellation)', 'Grus': 'Grus (constellation)',
    'Hercules': 'Hercules (constellation)', 'Horologium': 'Horologium (constellation)', 'Hydra': 'Hydra (constellation)',
    'Hydrus': 'Hydrus', 'Indus': 'Indus (constellation)', 'Lacerta': 'Lacerta',
    'Leo': 'Leo (constellation)', 'Leo Minor': 'Leo Minor', 'Lepus': 'Lepus (constellation)',
    'Libra': 'Libra (constellation)', 'Lupus': 'Lupus (constellation)', 'Lynx': 'Lynx (constellation)',
    'Lyra': 'Lyra', 'Mensa': 'Mensa (constellation)', 'Microscopium': 'Microscopium',
    'Monoceros': 'Monoceros', 'Musca': 'Musca', 'Norma': 'Norma (constellation)',
    'Octans': 'Octans', 'Ophiuchus': 'Ophiuchus', 'Orion': 'Orion (constellation)',
    'Pavo': 'Pavo (constellation)', 'Pegasus': 'Pegasus (constellation)', 'Perseus': 'Perseus (constellation)',
    'Phoenix': 'Phoenix (constellation)', 'Pictor': 'Pictor', 'Pisces': 'Pisces (constellation)',
    'Piscis Austrinus': 'Piscis Austrinus', 'Puppis': 'Puppis', 'Pyxis': 'Pyxis',
    'Reticulum': 'Reticulum', 'Sagitta': 'Sagitta', 'Sagittarius': 'Sagittarius (constellation)',
    'Scorpius': 'Scorpius', 'Sculptor': 'Sculptor (constellation)', 'Scutum': 'Scutum (constellation)',
    'Serpens': 'Serpens', 'Sextans': 'Sextans', 'Taurus': 'Taurus (constellation)',
    'Telescopium': 'Telescopium', 'Triangulum': 'Triangulum', 'Triangulum Australe': 'Triangulum Australe',
    'Tucana': 'Tucana', 'Ursa Major': 'Ursa Major', 'Ursa Minor': 'Ursa Minor',
    'Vela': 'Vela (constellation)', 'Virgo': 'Virgo (constellation)', 'Volans': 'Volans', 'Vulpecula': 'Vulpecula',
}


@lru_cache(maxsize=1)
def _rings() -> dict[str, list[list[tuple[float, float]]]]:
    rows = [line.split() for line in DATA_FILE.read_text().splitlines() if line.strip()]
    result: dict[str, list[list[tuple[float, float]]]] = {}
    for code, points in groupby(rows, key=lambda row: row[2]):
        # Catalogue adds artificial Octans map seams to the south pole. These are
        # NOT constellation boundaries: discard them, join real endpoints at RA=0.
        ring = [(float(row[0]) * 15, float(row[1])) for row in points if float(row[1]) != -90]
        result.setdefault(code[:3], []).append(ring)
    return result


@lru_cache(maxsize=88)
def constellation_boundary(abbreviation: str) -> list[list[tuple[float, float]]]:
    """Sample B1875 parallels/meridians before transformation, not straight ICRS corners.

    0.25-degree coordinate spacing bounds display tessellation error, not astrometric
    precision. Output is a visualization outline, not a membership test.
    """
    result = []
    for ring in _rings()[abbreviation.upper()]:
        samples = []
        for (ra, dec), (next_ra, next_dec) in zip(ring, ring[1:] + ring[:1]):
            delta_ra = (next_ra - ra + 180) % 360 - 180
            steps = max(1, ceil(max(abs(delta_ra), abs(next_dec - dec)) / 0.25))
            samples.extend(((ra + delta_ra * i / steps) % 360, dec + (next_dec - dec) * i / steps) for i in range(steps))
        position = SkyCoord(ra=[p[0] for p in samples] * u.deg, dec=[p[1] for p in samples] * u.deg, frame=B1875).icrs
        transformed = [(round(float(ra), 8) % 360, round(float(dec), 8)) for ra, dec in zip(position.ra.deg, position.dec.deg)]
        result.append(transformed + [transformed[0]])
    return result


def constellation_at(ra: float, dec: float) -> ConstellationResponse:
    position = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame='icrs')
    name = str(get_constellation(position)).strip()
    # Astropy 6/7 bundled name table contains three historical spelling errors.
    name = {'Ophiucus': 'Ophiuchus', 'Chamaleon': 'Chamaeleon', 'Pisces Austrinus': 'Piscis Austrinus'}.get(name, name)
    abbreviation = str(get_constellation(position, short_name=True))
    return ConstellationResponse(
        ra=ra, dec=dec, name=name, abbreviation=abbreviation,
        learn_url='https://en.wikipedia.org/wiki/' + quote(ARTICLE_TITLES[name].replace(' ', '_')),
        boundary=constellation_boundary(abbreviation), boundary_source=BOUNDARY_SOURCE,
    )
