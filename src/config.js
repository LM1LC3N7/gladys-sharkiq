// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { POLL_INTERVAL, REGIONS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  region: 'eu',
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];
export const REGION_KEYS = Object.keys(REGIONS);

/**
 * The key of an account in /data: a hash of the region and the e-mail, never
 * the e-mail itself. Only tells whether what is kept there belongs to this
 * account.
 */
export const accountKey = (region, email) =>
  email
    ? createHash('sha256')
        .update(`sharkiq:${region}:${email.toLowerCase()}`, 'utf8')
        .digest('hex')
        .slice(0, 32)
    : '';

export function normalizeConfig(raw = {}) {
  const given = raw?.poll_interval;
  const interval = given === undefined || given === null || given === '' ? NaN : Number(given);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const regionKey = String(raw?.region ?? DEFAULTS.region)
    .trim()
    .toLowerCase();
  const region = REGION_KEYS.includes(regionKey) ? regionKey : DEFAULTS.region;
  // The e-mail is sent as typed but for the spaces around it.
  const email = String(raw?.email ?? '').trim();
  // The password is kept as typed: spaces may be part of it.
  const password = typeof raw?.password === 'string' ? raw.password : String(raw?.password ?? '');
  return {
    region,
    email,
    password,
    account: accountKey(region, email),
    pollInterval: Number.isFinite(interval)
      ? Math.round(Math.max(POLL_INTERVAL.min, Math.min(POLL_INTERVAL.max, interval)))
      : DEFAULTS.poll_interval,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
