import type { SphereXSurveyInfo } from './properties.ts';

const SPEED_OF_LIGHT = 299_792_458;
/** SPHEREx has 6 detector bands of 17 channels each; frame = 17 * (band - 1) + (channel - 1). */
export const CHANNELS_PER_BAND = 17;

export interface SphereXChannel {
  /** 0-based cube frame index; also the `channel` URL parameter and the tile-file suffix. */
  frame: number;
  band: number;
  bandChannel: number;
  wavelengthUm: number;
  /** False when the service documents the frame as blank (no tiles exist). */
  hasData: boolean;
}

export function channelForFrame(info: SphereXSurveyInfo, frame: number): SphereXChannel | null {
  if (!Number.isInteger(frame) || frame < 0 || frame >= info.depth) return null;
  return {
    frame,
    band: Math.floor(frame / CHANNELS_PER_BAND) + 1,
    bandChannel: (frame % CHANNELS_PER_BAND) + 1,
    wavelengthUm: info.wavelengthsUm[frame]!,
    hasData: !info.blankFrames.includes(frame),
  };
}

export function allChannels(info: SphereXSurveyInfo): SphereXChannel[] {
  return Array.from({ length: info.depth }, (_, frame) => channelForFrame(info, frame)!);
}

export function channelLabel(channel: SphereXChannel): string {
  return `Band ${channel.band} · Ch ${channel.bandChannel}`;
}

export function formatWavelength(um: number): string {
  return `${um.toFixed(3)} μm`;
}

/** Previous/next channel that has data, or null at the ends of the cube. */
export function adjacentChannel(info: SphereXSurveyInfo, frame: number, direction: 1 | -1): SphereXChannel | null {
  for (let next = frame + direction; next >= 0 && next < info.depth; next += direction) {
    const channel = channelForFrame(info, next);
    if (channel?.hasData) return channel;
  }
  return null;
}

export function defaultFrame(info: SphereXSurveyInfo): number {
  const first = channelForFrame(info, info.firstFrame);
  return first?.hasData ? info.firstFrame : (adjacentChannel(info, info.firstFrame, 1)?.frame ?? 0);
}

/**
 * Frequency (Hz) to hand to Aladin Lite's `HiPS.setFrequency()` so that it displays `frame`.
 * Aladin maps frequency linearly onto frames between c/em_max and c/em_min; IRSA's own landing page
 * passes the middle of each frame's interval. The resulting tile requests are asserted in the
 * browser tests (they must carry the expected `_<frame>` suffix).
 */
export function frequencyForFrame(info: SphereXSurveyInfo, frame: number): number {
  const low = SPEED_OF_LIGHT / info.emMaxMeters;
  const high = SPEED_OF_LIGHT / info.emMinMeters;
  return low + ((frame + 0.5) / info.depth) * (high - low);
}
