import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSurveyInfo, parseBlankFrames, parseHiPSProperties, SphereXMetadataError } from '../src/sky/spherex/properties.ts';
import { adjacentChannel, allChannels, channelForFrame, defaultFrame, frequencyForFrame } from '../src/sky/spherex/channels.ts';
import { clampScale, fovFromScale, scaleFromFov } from '../src/sky/aladin/fov.ts';

// Trimmed copy of the real IRSA document (fetched 2026-11-14) with the full wavelength table.
const WAVELENGTHS = '0.753 0.771 0.790 0.809 0.828 0.848 0.868 0.889 0.910 0.932 0.955 0.978 1.001 1.025 1.050 1.075 1.102 1.113 1.139 1.167 1.195 1.224 1.254 1.284 1.315 1.346 1.378 1.412 1.446 1.481 1.517 1.554 1.592 1.631 1.656 1.695 1.735 1.775 1.818 1.861 1.905 1.949 1.995 2.041 2.089 2.139 2.189 2.240 2.292 2.345 2.399 2.445 2.506 2.575 2.646 2.719 2.794 2.871 2.951 3.033 3.118 3.204 3.293 3.383 3.476 3.570 3.667 3.768 3.833 3.867 3.901 3.935 3.970 4.005 4.040 4.076 4.112 4.148 4.184 4.220 4.257 4.294 4.331 4.368 4.405 4.435 4.467 4.500 4.533 4.566 4.600 4.635 4.669 4.704 4.739 4.773 4.808 4.843 4.879 4.915 4.951 4.988';
const PROPERTIES = `hips_initial_fov     = 359.620
creator_did          = ivo://IPAC/P/SPHEREx/DR1/cube
obs_title            = SPHEREx DR1 all-sky data cube
#hips_copyright      = ignored comment
hips_release_date    = 2026-11-01T01:58Z
hips_frame           = equatorial
hips_order           = 5
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
data_cube_crval3_arr = ${WAVELENGTHS}
obs_description      = SPHEREx DR1 all-sky data cube for visualization: 102 frames in ascending wavelength, one per band (1-6) and channel (1-17), frame index = 17*(band-1) + (channel-1). Frames 50 and 51 (band 3 channel 17, band 4 channel 1, the dichroic channels) are blank. See the Explanatory Supplement.
moc_sky_fraction     = 1.000000`;

const info = () => buildSurveyInfo(parseHiPSProperties(PROPERTIES));

test('properties parser ignores comments and keeps values after the first "="', () => {
  const parsed = parseHiPSProperties('# c\nkey = a = b\n\nother=1');
  assert.deepEqual(parsed, { key: 'a = b', other: '1' });
});

test('real IRSA metadata validates as the SPHEREx cube', () => {
  const s = info();
  assert.equal(s.depth, 102);
  assert.equal(s.wavelengthsUm.length, 102);
  assert.equal(s.tileFormat, 'png');
  assert.equal(s.maxOrder, 5);
  assert.deepEqual(s.blankFrames, [50, 51]);
  assert.equal(s.frame, 'equatorial');
  assert.equal(s.skyFraction, 1);
});

test('blank frames are only taken from the documented sentence', () => {
  assert.deepEqual(parseBlankFrames('Frames 50 and 51 (x) are blank.', 102), [50, 51]);
  assert.deepEqual(parseBlankFrames('Frames 3, 4 and 200 are blank', 102), [3, 4]);
  assert.deepEqual(parseBlankFrames('nothing special', 102), []);
});

test('metadata that is not SPHEREx, not a cube, or inconsistent is rejected', () => {
  const bad = (mutate) => () => {
    const p = parseHiPSProperties(PROPERTIES);
    mutate(p);
    buildSurveyInfo(p);
  };
  assert.throws(bad((p) => { p.creator_did = 'ivo://other/x'; p.obs_collection = 'DSS'; }), SphereXMetadataError);
  assert.throws(bad((p) => { p.dataproduct_type = 'image'; }), SphereXMetadataError);
  assert.throws(bad((p) => { p.hips_frame = 'galactic'; }), SphereXMetadataError);
  assert.throws(bad((p) => { p.data_cube_crval3_arr = '1 2 3'; }), SphereXMetadataError);
  assert.throws(bad((p) => { p.data_cube_bunit3 = 'nm'; }), SphereXMetadataError);
  assert.throws(bad((p) => { delete p.hips_tile_width; }), SphereXMetadataError);
});

test('channels map frame index to band/channel/wavelength from the service table', () => {
  const s = info();
  const c = channelForFrame(s, 17);
  assert.deepEqual([c.band, c.bandChannel, c.wavelengthUm, c.hasData], [2, 1, 1.113, true]);
  const last = channelForFrame(s, 101);
  assert.deepEqual([last.band, last.bandChannel, last.wavelengthUm], [6, 17, 4.988]);
  assert.equal(channelForFrame(s, 50).hasData, false);
  assert.equal(channelForFrame(s, 51).hasData, false);
  assert.equal(channelForFrame(s, 102), null);
  assert.equal(channelForFrame(s, -1), null);
  assert.equal(allChannels(s).filter((x) => x.hasData).length, 100);
});

test('previous/next skip blank channels and stop at the ends', () => {
  const s = info();
  assert.equal(adjacentChannel(s, 49, 1).frame, 52);
  assert.equal(adjacentChannel(s, 52, -1).frame, 49);
  assert.equal(adjacentChannel(s, 0, -1), null);
  assert.equal(adjacentChannel(s, 101, 1), null);
  assert.equal(defaultFrame(s), 1);
});

test('frequency chosen for a frame sits inside that frame\'s interval of Aladin\'s linear mapping', () => {
  const s = info();
  const c = 299792458, lo = c / s.emMaxMeters, hi = c / s.emMinMeters;
  for (const frame of [0, 1, 17, 30, 49, 52, 101]) {
    const f = frequencyForFrame(s, frame);
    assert.equal(Math.floor(((f - lo) / (hi - lo)) * s.depth), frame);
  }
});

test('scale <-> FOV: viewport width x arcsec-per-pixel / 3600', () => {
  assert.equal(fovFromScale(2.5, 1440), 1);
  assert.equal(fovFromScale(3600 / 1000, 1000), 1);
  assert.ok(Math.abs(scaleFromFov(fovFromScale(7.3, 1280), 1280) - 7.3) < 1e-12);
  assert.equal(clampScale(0.01), 0.2);
  assert.equal(clampScale(9999), 500);
});
