import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import {
  adjacentChannel,
  allChannels,
  channelForFrame,
  channelLabel,
  formatWavelength,
} from '../sky/spherex/channels.ts';
import type { SphereXChannel } from '../sky/spherex/channels.ts';
import type { SphereXSurveyInfo } from '../sky/spherex/properties.ts';

interface WavelengthSelectorProps {
  survey: SphereXSurveyInfo | undefined;
  surveyPending: boolean;
  surveyError: Error | null;
  /** Effective 0-based cube frame currently shown. */
  frame: number | null;
  loading: boolean;
  disabled: boolean;
  onChange: (frame: number) => void;
}

const SLIDER_COMMIT_MS = 180;

export function WavelengthSelector({ survey, surveyPending, surveyError, frame, loading, disabled, onChange }: WavelengthSelectorProps) {
  const [sliderFrame, setSliderFrame] = useState<number | null>(frame);
  const commitTimer = useRef<number | null>(null);

  useEffect(() => {
    setSliderFrame(frame);
  }, [frame]);
  useEffect(() => () => {
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
  }, []);

  if (!survey) {
    return (
      <section className="panel-section" aria-labelledby="wavelength-heading">
        <div className="section-heading">
          <h3 id="wavelength-heading">Wavelength</h3>
        </div>
        {surveyPending && <p className="inline-status" role="status"><LoaderCircle className="spin" aria-hidden="true" size={15} /> Reading channel list…</p>}
        {surveyError && <p className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={15} />Wavelength channels unavailable: {surveyError.message}</p>}
      </section>
    );
  }

  const channels = allChannels(survey);
  const current = frame === null ? null : channelForFrame(survey, frame);
  const usable = channels.filter((channel) => channel.hasData).length;
  const bands = [...new Set(channels.map((channel) => channel.band))];
  const commitSlider = (value: number, direction: 1 | -1) => {
    setSliderFrame(value);
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      const target = channelForFrame(survey, value);
      // A blank channel has no tiles; continue to the nearest channel that has data.
      const chosen = target?.hasData ? target : adjacentChannel(survey, value, direction);
      if (chosen) onChange(chosen.frame);
    }, SLIDER_COMMIT_MS);
  };

  return (
    <section className="panel-section" aria-labelledby="wavelength-heading">
      <div className="section-heading view-section-heading">
        <h3 id="wavelength-heading">Wavelength</h3>
        <p>{usable} of {survey.depth} channels have imagery</p>
      </div>

      <label className="field">
        <span>Choose channel</span>
        <select
          className="select-input"
          value={frame ?? ''}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-describedby="wavelength-status"
        >
          {bands.map((band) => {
            const inBand = channels.filter((channel) => channel.band === band);
            return (
              <optgroup key={band} label={`Band ${band} · ${formatWavelength(inBand[0]!.wavelengthUm)} – ${formatWavelength(inBand.at(-1)!.wavelengthUm)}`}>
                {inBand.map((channel) => (
                  <option key={channel.frame} value={channel.frame} disabled={!channel.hasData}>
                    {optionText(channel)}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>

      <input
        type="range"
        className="wavelength-slider"
        min={0}
        max={survey.depth - 1}
        step={1}
        value={sliderFrame ?? 0}
        disabled={disabled}
        aria-label="SPHEREx wavelength channel"
        aria-valuetext={sliderFrame === null ? undefined : sliderText(survey, sliderFrame)}
        onChange={(event) => {
          const value = Number(event.target.value);
          commitSlider(value, sliderFrame !== null && value < sliderFrame ? -1 : 1);
        }}
      />

      <p id="wavelength-status" className="wavelength-readout" role="status">
        {current ? (
          <>
            <strong>{formatWavelength(current.wavelengthUm)}</strong>
            <span>{channelLabel(current)}</span>
          </>
        ) : 'No channel selected'}
        {loading && <span className="wavelength-loading"><LoaderCircle className="spin" aria-hidden="true" size={12} /> Loading…</span>}
      </p>
      <p className="field-hint wavelength-note">Combined-cube channels, not observation dates.</p>
    </section>
  );
}

function optionText(channel: SphereXChannel): string {
  const base = `Ch ${channel.bandChannel}`;
  return channel.hasData ? base : `${base} — no imagery`;
}

function sliderText(survey: SphereXSurveyInfo, frame: number): string {
  const channel = channelForFrame(survey, frame);
  return channel ? `${formatWavelength(channel.wavelengthUm)}, ${channelLabel(channel)}` : '';
}
