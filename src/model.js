// -----------------------------------------------------------------------------
// The Ayla answers -> plain robots (pure). Every value is checked: a missing,
// odd or out-of-range value is `undefined`, never 0, and is then not
// published (and refuses a command that needs it).
//
// Ayla lists a property twice when it can be set: `GET_<name>` (what the
// robot reports) and `SET_<name>` (the last order). sharkiq strips both
// prefixes and keeps whichever comes last; here the reported value is always
// preferred, and the last order is used only for the suction power when the
// robot reports none (a setting, not a state). An operating mode is never
// read from an order.
// -----------------------------------------------------------------------------

import { CLEANING_MODES, GLADYS, LIMITS, OPERATING_MODE, PROPERTY, SUCTION } from './constants.js';
import { DSN } from './ayla.js';

/** An integer from a number, a numeric string or a boolean; undefined otherwise. */
export function integerOf(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,9}\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

/** "GET_Battery_Capacity" -> { name: 'Battery_Capacity', kind: 'get' } (sharkiq _clean_property_name). */
export function splitName(raw) {
  const prefix = String(raw).slice(0, 4).toUpperCase();
  if (prefix === 'GET_') {
    return { name: raw.slice(4), kind: 'get' };
  }
  if (prefix === 'SET_') {
    return { name: raw.slice(4), kind: 'set' };
  }
  return { name: raw, kind: 'plain' };
}

const RANK = { get: 3, plain: 2, set: 1 };

/**
 * The values of a property list, by clean name: `{ get, plain, set }` of each
 * (the raw values, unchecked). Malformed entries are skipped.
 */
export function propertyValues(list) {
  const values = new Map();
  if (!Array.isArray(list)) {
    return values;
  }
  for (const entry of list.slice(0, LIMITS.properties)) {
    const property = entry?.property;
    if (!property || typeof property.name !== 'string' || property.name.length > 80) {
      continue;
    }
    const { name, kind } = splitName(property.name);
    const slot = values.get(name) ?? {};
    slot[kind] = property.value;
    values.set(name, slot);
  }
  return values;
}

/** The reported value of a property (GET_, then the plain name), or the order when `orders`. */
function reported(values, name, { orders = false } = {}) {
  const slot = values.get(name);
  if (!slot) {
    return undefined;
  }
  for (const kind of Object.keys(RANK)) {
    if (kind === 'set' && !orders) {
      continue;
    }
    if (slot[kind] !== undefined && slot[kind] !== null) {
      return slot[kind];
    }
  }
  return undefined;
}

const KNOWN_MODES = new Set(Object.values(OPERATING_MODE));
const POWER_BY_VALUE = new Map(Object.entries(SUCTION).map(([key, { ayla }]) => [ayla, key]));

const flag = (value) => {
  const n = integerOf(value);
  return n === 0 || n === 1 ? n === 1 : undefined;
};

/**
 * One robot from its property list: `{ operatingMode, powerMode, battery,
 * charging, docked, errorCode, hasFind }`, each undefined when not reported
 * (or not valid).
 */
export function parseRobot(list) {
  const values = propertyValues(list);
  const mode = integerOf(reported(values, PROPERTY.OPERATING_MODE));
  const power = integerOf(reported(values, PROPERTY.POWER_MODE, { orders: true }));
  const battery = integerOf(reported(values, PROPERTY.BATTERY));
  const error = integerOf(reported(values, PROPERTY.ERROR));
  return {
    operatingMode: KNOWN_MODES.has(mode) ? mode : undefined,
    powerMode: POWER_BY_VALUE.get(power),
    battery: battery !== undefined && battery >= 0 && battery <= 100 ? battery : undefined,
    charging: flag(reported(values, PROPERTY.CHARGING)),
    docked: flag(reported(values, PROPERTY.DOCKED)),
    errorCode: error !== undefined && error >= 0 && error < 100_000 ? error : undefined,
  };
}

export const isCleaning = (mode) => CLEANING_MODES.has(mode);

/**
 * The Gladys vacuum-cleaner state of a robot (VACUUM_CLEANER_STATE), as the
 * Home Assistant integration reads it: an error code first, then the
 * operating mode; stopped, it is charging or docked when the robot says so.
 * Undefined when nothing tells.
 */
export function stateOf(robot) {
  const { STATE } = GLADYS;
  if (robot.errorCode !== undefined && robot.errorCode > 0) {
    return STATE.ERROR;
  }
  const mode = robot.operatingMode;
  if (isCleaning(mode)) {
    return STATE.RUNNING;
  }
  if (mode === OPERATING_MODE.PAUSE) {
    return STATE.PAUSED;
  }
  if (mode === OPERATING_MODE.RETURN) {
    return STATE.RETURNING;
  }
  if (robot.charging) {
    return STATE.CHARGING;
  }
  if (robot.docked) {
    return STATE.DOCKED;
  }
  return mode === OPERATING_MODE.STOP ? STATE.STOPPED : undefined;
}

const text = (value, max) =>
  typeof value === 'string' && value.trim() !== ''
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : undefined;

/**
 * The robots of a devices.json answer: `{ dsn, name, model, online }`,
 * without duplicates, those with a valid DSN only, LIMITS.robots at most.
 */
export function parseDevices(list) {
  const robots = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const device = entry?.device ?? entry;
    const dsn = typeof device?.dsn === 'string' ? device.dsn : '';
    if (!DSN.test(dsn) || seen.has(dsn) || robots.length >= LIMITS.robots) {
      continue;
    }
    seen.add(dsn);
    const status = typeof device.connection_status === 'string' ? device.connection_status : '';
    robots.push({
      dsn,
      name: text(device.product_name, 60) ?? text(device.model, 60),
      model: text(device.oem_model, 40) ?? text(device.model, 40) ?? '',
      online: status === '' ? undefined : status.toLowerCase() === 'online',
    });
  }
  return robots;
}
