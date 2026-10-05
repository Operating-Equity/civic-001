// The server's clock: real time, unless the guard set CIVIC_CLOCK, and then the instant it names, running from boot.
// One clock for the prices and tiers (server/economics.js), the accounts (server/accounts.js) and the credit
// (server/credit.js), so a test of a tier change, a reset link's end or a month's limit sees one time.
import { config } from './config.js';

const bootReal = Date.now();
const offset = (() => { const t = config.clock ? Date.parse(config.clock) : NaN; return Number.isFinite(t) ? t - bootReal : 0; })();
export function now() { return Date.now() + offset; }
