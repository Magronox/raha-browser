// Minimal structured logging to stderr (picked up by `npm start` terminals,
// e2e test output, and OS crash logs). No log files, no telemetry — ever.
// Raha sends nothing anywhere; this is local stderr only.

/**
 * @param {string} area short subsystem tag ('tabs', 'governor', 'persist', ...)
 * @param {string} msg
 */
export function log(area, msg) {
  console.error(`[raha:${area}] ${msg}`);
}
