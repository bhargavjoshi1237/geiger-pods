/**
 * Alarm evaluation (S10 §7, CloudWatch-alarm equivalent).
 *
 * "M out of N" semantics over per-minute datapoints: the last
 * `evaluationPeriods` periods are compared against `threshold`; the alarm is
 * ALARM when at least `datapointsToAlarm` breach. `treatMissingData`
 * (`missing|notBreaching|breaching|ignore`) decides how null datapoints count.
 * State changes notify exactly once per transition via the idempotency key
 * `alarmId:stateUpdatedAt` (claimed in `pods.alarm_history`).
 *
 * @module lib/gateway/core/observe/alarms
 */

export const COMPARISONS = ["<", "<=", ">", ">="];
export const TREAT_MISSING_DATA = ["missing", "notBreaching", "breaching", "ignore"];
export const ALARM_STATES = ["OK", "ALARM", "INSUFFICIENT_DATA"];

/**
 * Compares one datapoint against the threshold.
 *
 * @param {string} comparison - One of `<|<=|>|>=`.
 * @param {number} value
 * @param {number} threshold
 * @returns {boolean}
 */
export function compare(comparison, value, threshold) {
  switch (comparison) {
    case ">": return value > threshold;
    case ">=": return value >= threshold;
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    default: throw new Error(`Unknown comparison: ${comparison}`);
  }
}

/**
 * Evaluates M-of-N datapoints (oldest → newest, `null` = missing).
 *
 * - `missing`: any missing period forces INSUFFICIENT_DATA unless M
 *   breaches are already decided among present points... (CloudWatch keeps the
 *   prior state; without prior state this pure function reports
 *   INSUFFICIENT_DATA when missing points could change the outcome).
 * - `notBreaching` / `breaching`: missing counts as not-breaching/breaching.
 * - `ignore`: missing periods are excluded from N; with no usable points the
 *   state is INSUFFICIENT_DATA.
 *
 * @param {{ values: Array<number|null>, comparison: string, threshold: number,
 *   evaluationPeriods: number, datapointsToAlarm: number,
 *   treatMissingData?: string }} config
 * @returns {{ state: "OK"|"ALARM"|"INSUFFICIENT_DATA", breaching: number, missing: number, evaluated: number }}
 */
export function evaluateAlarm({
  values = [],
  comparison,
  threshold,
  evaluationPeriods,
  datapointsToAlarm,
  treatMissingData = "missing",
} = {}) {
  const window = values.slice(-evaluationPeriods);
  while (window.length < evaluationPeriods) window.unshift(null);
  const missing = window.filter((value) => value === null || value === undefined).length;

  if (treatMissingData === "ignore") {
    const present = window.filter((value) => value !== null && value !== undefined);
    if (present.length === 0) {
      return { state: "INSUFFICIENT_DATA", breaching: 0, missing, evaluated: 0 };
    }
    const breaching = present.filter((value) => compare(comparison, value, threshold)).length;
    // M-of-N over the usable points: missing periods are excluded from N.
    return {
      state: breaching >= Math.min(datapointsToAlarm, present.length) ? "ALARM" : "OK",
      breaching,
      missing,
      evaluated: present.length,
    };
  }

  if (treatMissingData === "missing" && missing > 0) {
    const breaching = window
      .filter((value) => value !== null && value !== undefined)
      .filter((value) => compare(comparison, value, threshold)).length;
    // Already decided regardless of the missing points: M breaches with at
    // most (N - M) missing, or (N - M + 1) non-breaches.
    if (breaching >= datapointsToAlarm) {
      return { state: "ALARM", breaching, missing, evaluated: window.length - missing };
    }
    const notBreaching = window.length - missing - breaching;
    if (notBreaching > window.length - datapointsToAlarm) {
      return { state: "OK", breaching, missing, evaluated: window.length - missing };
    }
    return { state: "INSUFFICIENT_DATA", breaching, missing, evaluated: window.length - missing };
  }

  const effective = window.map((value) => {
    if (value === null || value === undefined) return treatMissingData === "breaching";
    return compare(comparison, value, threshold);
  });
  const breaching = effective.filter(Boolean).length;
  return {
    state: breaching >= datapointsToAlarm ? "ALARM" : "OK",
    breaching,
    missing,
    evaluated: window.length,
  };
}

/**
 * Idempotency key for one state transition (notify exactly once).
 *
 * @param {string} alarmId
 * @param {string} stateUpdatedAt - ISO timestamp of the transition.
 * @returns {string}
 */
export function transitionKey(alarmId, stateUpdatedAt) {
  return `${alarmId}:${stateUpdatedAt}`;
}
