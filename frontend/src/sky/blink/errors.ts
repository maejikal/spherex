/** Turns a failed blink request into what the viewer shows. Structural type: no import of the API client. */

export interface ErrorLike {
  message: string;
  code?: string | null;
  status?: number | null;
}

export type BlinkErrorKind = 'no-coverage' | 'data-unavailable' | 'invalid-coordinates' | 'unreachable' | 'processing' | 'bad-response';

export interface BlinkErrorView {
  kind: BlinkErrorKind;
  title: string;
  message: string;
  retryable: boolean;
}

export function describeBlinkError(error: unknown): BlinkErrorView {
  const { message, code, status } = toErrorLike(error);
  if (code === 'no_fits_coverage') {
    return {
      kind: 'no-coverage',
      title: 'No SPHEREx observations here',
      message: `${message} This prototype uses only two local observations that cover a limited region of the sky.`,
      retryable: false,
    };
  }
  if (code === 'fits_unavailable') {
    return { kind: 'data-unavailable', title: 'SPHEREx image files unavailable', message, retryable: true };
  }
  if (code === 'invalid_parameters') {
    return { kind: 'invalid-coordinates', title: 'Invalid position', message, retryable: false };
  }
  if (code === 'invalid_response' || code === 'invalid_content_type') {
    return { kind: 'bad-response', title: 'Unexpected response', message, retryable: true };
  }
  if (status === null || status === undefined) {
    return { kind: 'unreachable', title: 'Sky Explorer API unavailable', message, retryable: true };
  }
  return { kind: 'processing', title: 'Could not prepare the observations', message, retryable: true };
}

function toErrorLike(error: unknown): ErrorLike {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      message: typeof record.message === 'string' && record.message ? record.message : 'The request failed.',
      code: typeof record.code === 'string' ? record.code : null,
      status: typeof record.status === 'number' ? record.status : null,
    };
  }
  return { message: 'The request failed.', code: null, status: null };
}

/** Compact "partial coverage" decision shared by the warning banner. */
export function isPartialCoverage(coverage: readonly number[], fullAt = 0.95): boolean {
  return coverage.some((value) => value < fullAt);
}
