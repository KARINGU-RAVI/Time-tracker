/**
 * The live figures on the Today screen, to the second.
 *
 * The server counts whole minutes: an open session contributes floor(now) - floor(IN) minutes. Seconds are shown only for
 * the session that is running: closed time comes from the server's minutes, the open session is counted exactly from its IN.
 * So the clock starts at 0:00:00 on check-in, never runs ahead of the recorded minutes by more than the current minute,
 * and settles on the server's own number the moment the session closes.
 *
 * Every input is a server time (the dashboard's `now` plus the time elapsed since it arrived), so two devices show the same second.
 */
export interface LiveInput {
  workedMinutes: number;
  requiredMinutes: number;
  isInside: boolean;
  /** IN time of the running session (epoch ms), if any. */
  openInMs: number | null;
  /** The server's clock when workedMinutes was calculated (epoch ms). */
  fetchNowMs: number;
  /** The server's clock now (epoch ms). */
  nowMs: number;
}

export interface LiveFigures {
  workedSeconds: number;
  remainingSeconds: number;
  overtimeSeconds: number;
  /** Seconds since the running session's IN, or 0 when not checked in. */
  sessionSeconds: number;
}

const MINUTE = 60_000;

export function liveFigures(i: LiveInput): LiveFigures {
  const requiredSeconds = i.requiredMinutes * 60;
  let workedSeconds = i.workedMinutes * 60;
  let sessionSeconds = 0;

  if (i.isInside && i.openInMs !== null) {
    // Minutes the server had already counted for the running session when it answered.
    const countedForOpen = Math.max(0, Math.floor(i.fetchNowMs / MINUTE) - Math.floor(i.openInMs / MINUTE));
    const closedMinutes = Math.max(0, i.workedMinutes - countedForOpen);
    sessionSeconds = Math.max(0, Math.floor((i.nowMs - i.openInMs) / 1000));
    workedSeconds = closedMinutes * 60 + sessionSeconds;
  }

  return {
    workedSeconds,
    remainingSeconds: requiredSeconds > 0 ? Math.max(0, requiredSeconds - workedSeconds) : 0,
    overtimeSeconds: requiredSeconds > 0 ? Math.max(0, workedSeconds - requiredSeconds) : 0,
    sessionSeconds,
  };
}

/**
 * The server's clock right now, from the last response. Elapsed time is measured on this device's clock against this device's
 * own timestamp for the response, so a device whose clock is wrong (or in another time zone) still gets the right server time.
 */
export function serverClock(serverNowAtResponse: string, responseReceivedMs: number, deviceNowMs: number): number {
  return Date.parse(serverNowAtResponse) + Math.max(0, deviceNowMs - responseReceivedMs);
}
