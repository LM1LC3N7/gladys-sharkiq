// -----------------------------------------------------------------------------
// Made-up accounts and robots, shaped like the answers sharkiq reads (Ayla
// devices.json and properties.json). No real account, serial number or token.
// -----------------------------------------------------------------------------

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);

export const EMAIL = 'robot.owner@example.com';
export const PASSWORD = 'correct horse battery 42';

export const DSNS = { salon: 'AC000W000000001', upstairs: 'AC000W000000002' };

/** The two regions, on test hosts (same shape as REGIONS of src/constants.js). */
export const TEST_REGIONS = {
  eu: {
    auth0: 'https://auth-eu.test',
    clientId: 'eu-test-client',
    flow: 'password',
    login: 'https://user-eu.test',
    device: 'https://ads-eu.test',
    appId: 'eu-test-app-id',
    appSecret: 'eu-test-app-secret-0123456789',
  },
  us: {
    auth0: 'https://auth-us.test',
    clientId: 'us-test-client',
    flow: 'cross_origin',
    login: 'https://user-us.test',
    device: 'https://ads-us.test',
    appId: 'us-test-app-id',
    appSecret: 'us-test-app-secret-0123456789',
  },
};

/** The robots of the account, as the fake cloud holds them. */
export function robots() {
  return {
    [DSNS.salon]: {
      name: 'Shark du salon',
      model: 'RV2001WDEU',
      online: true,
      props: {
        Operating_Mode: 0,
        Power_Mode: 0,
        Battery_Capacity: 87,
        Charging_Status: 1,
        DockedStatus: 1,
        Error_Code: 0,
      },
    },
    [DSNS.upstairs]: {
      name: 'Shark étage',
      model: 'AV2501AEEU',
      online: true,
      props: {
        Operating_Mode: 2,
        Power_Mode: 2,
        Battery_Capacity: 54,
        Charging_Status: 0,
        DockedStatus: 0,
        Error_Code: 0,
      },
    },
  };
}

/** The settable properties: listed twice (GET_ reported, SET_ last order). */
const SETTABLE = new Set(['Operating_Mode', 'Power_Mode', 'Find_Device']);

/** The properties.json answer of one robot (Ayla `[{ property }]`). */
export function propertyList(robot) {
  const list = [];
  let key = 1000;
  for (const [name, value] of Object.entries(robot.props)) {
    if (value === undefined) {
      continue;
    }
    key += 1;
    const base = {
      base_type: typeof value === 'string' ? 'string' : 'integer',
      data_updated_at: '2026-10-18T09:59:00Z',
      device_key: 4242,
      key,
    };
    list.push({ property: { ...base, name: `GET_${name}`, value, read_only: true } });
    if (SETTABLE.has(name)) {
      list.push({
        property: {
          ...base,
          key: key + 500,
          name: `SET_${name}`,
          value: robot.orders?.[name] ?? value,
          read_only: false,
        },
      });
    }
  }
  list.push({
    property: {
      base_type: 'integer',
      name: 'SET_Find_Device',
      value: 0,
      read_only: false,
      key: 1999,
    },
  });
  return list;
}
