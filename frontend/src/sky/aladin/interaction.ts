/**
 * What the user can do with the sky viewer, kept apart from imagery status.
 *
 * A selected position comes from Aladin's projection of the clicked pixel, which depends only on the
 * current view (centre, field of view, projection), never on whether the tiles under it have arrived.
 * So loading tiles, or a few failed tiles, must not block selecting, the action tray or the cursor
 * readout; they are reported separately by the loading and error pills.
 */
export interface SkyInteractionInput {
  /** Aladin is created and attached. */
  ready: boolean;
  /** The viewer is replaced by an error (survey unavailable or Aladin failed to start). */
  unavailable: boolean;
}

export interface SkyInteraction {
  /** Pan, zoom and keyboard navigation. */
  interactive: boolean;
  /** Click to select, the action tray, Enter-to-select and the cursor readout. */
  canSelect: boolean;
}

export function skyInteraction({ ready, unavailable }: SkyInteractionInput): SkyInteraction {
  const interactive = ready && !unavailable;
  return { interactive, canSelect: interactive };
}
