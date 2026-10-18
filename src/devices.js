// -----------------------------------------------------------------------------
// The Shark robots -> Gladys devices, and their states (pure).
//
// One Gladys device per robot, `ext:<selector>:sharkiq:<dsn>`, the Ayla
// device serial number (DSN): the id the cloud knows the robot by. The
// features are keyed by their role (the last part of their external id):
// those keys are published forever, never rename them. Every robot gets the
// same fixed features, so a republished device never loses one.
//
// The state uses the core's `vacuum-cleaner/state` (read only), the category
// the core has for robot vacuums (VACUUM_CLEANER_STATE: stopped, running,
// paused, error, returning, charging, docked). The commands are five
// `button/push` features, never a `switch` nor a writable binary (no
// `vacuum-cleaner/dock` nor `run-mode` either): an "everything on" or
// "everything off" of a scene, a voice assistant or an MCP client can never
// start or stop a robot. The suction power is the core's
// `vacuum-cleaner/clean-mode` select, with three of its values labelled Eco,
// Normal and Max (quiet, auto, deep clean), as callemand/gladys-roborock
// (in the store) labels the suction levels of its robots.
//
// Units: only the one the core lists for the category: the battery is a
// percent (DEVICE_FEATURE_UNITS_BY_CATEGORY).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DSN } from './ayla.js';
import { GLADYS, LIMITS, SUCTION, SUCTION_KEYS } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, SUCTION_LABELS, errorText, word } from './i18n.js';
import { stateOf } from './model.js';

const button = {
  category: C.BUTTON,
  type: TYPES.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role (their order is the order in Gladys). */
export const FEATURES = {
  state: { category: C.VACUUM_CLEANER, type: TYPES.VACUUM_CLEANER.STATE, min: 0, max: 6 },
  battery: {
    category: C.BATTERY,
    type: TYPES.BATTERY.INTEGER,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  },
  suction: {
    category: C.VACUUM_CLEANER,
    type: TYPES.VACUUM_CLEANER.CLEAN_MODE,
    min: 0,
    max: GLADYS.CLEAN_MODE_MAX,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
  error: { category: C.TEXT, type: TYPES.TEXT.TEXT, min: 0, max: 0, keep_history: false },
  start: button,
  pause: button,
  stop: button,
  dock: button,
  locate: button,
};

export const ROLES = Object.keys(FEATURES);
export const BUTTON_ROLES = ['start', 'pause', 'stop', 'dock', 'locate'];
export const COMMAND_ROLES = [...BUTTON_ROLES, 'suction'];

export const deviceIds = (gladys, dsn) => gladys.externalIds('sharkiq', String(dsn));

/** The DSN and the role of a feature external id. */
export function parseFeatureId(externalId) {
  const match = /:sharkiq:([A-Za-z0-9_-]{1,40}):([a-z]+)$/.exec(String(externalId ?? ''));
  return match && DSN.test(match[1]) && ROLES.includes(match[2])
    ? { dsn: match[1], role: match[2] }
    : undefined;
}

/** The name of the robot in the account, else "Robot Shark 5678" (end of the DSN). */
export const deviceName = (robot, language) =>
  robot.name ?? `${word(DEVICE_NAME, language)} ${robot.dsn.slice(-4)}`;

const suctionOptions = (language) =>
  SUCTION_KEYS.map((key, i) => ({
    value: SUCTION[key].gladys,
    label: word(SUCTION_LABELS[key], language),
    sort_order: i,
  }));

/** The suction key ('eco', 'normal', 'max') of a Gladys clean mode value, or undefined. */
export const suctionOf = (value) => SUCTION_KEYS.find((key) => SUCTION[key].gladys === value);

/** The Gladys device of one robot. */
export function buildDevice(gladys, robot, language) {
  const ids = deviceIds(gladys, robot.dsn);
  return {
    name: deviceName(robot, language),
    external_id: ids.device,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...FEATURES[role],
      ...(role === 'suction' ? { supported_options: suctionOptions(language) } : {}),
    })),
    params: [
      { name: 'serial_number', value: robot.dsn },
      { name: 'model', value: robot.model ?? '' },
    ],
  };
}

/** The Gladys states of one robot read: `[{ role, state }]` or `[{ role, text }]`. */
export function statesOf(props, language) {
  const states = [];
  const state = stateOf(props);
  if (state !== undefined) {
    states.push({ role: 'state', state });
  }
  if (props.battery !== undefined) {
    states.push({ role: 'battery', state: props.battery });
  }
  if (props.powerMode !== undefined) {
    states.push({ role: 'suction', state: SUCTION[props.powerMode].gladys });
  }
  if (props.errorCode !== undefined) {
    states.push({
      role: 'error',
      text: word(errorText(props.errorCode), language).slice(0, LIMITS.textLength),
    });
  }
  return states;
}
