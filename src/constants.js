// -----------------------------------------------------------------------------
// Constants of the Shark cloud (SharkNinja Auth0 + Ayla Networks) and of the
// integration.
//
// The cloud values come from sharkiq 1.5.1 (MIT, see THIRD_PARTY_NOTICES.md),
// read from the SharkClean app: the Auth0 domains and clients, the Ayla hosts
// and the Ayla app id and app secret of each region. They are the app's own
// public constants, shipped in the app and in the library, not secrets of the
// user. They are never logged all the same.
// -----------------------------------------------------------------------------

/** The manifest action keys (forever: stored in configurations). */
export const ACTIONS = {
  SIGN_IN: 'sign_in',
  TEST_CONNECTION: 'test_connection',
};

/** The scopes the app asks Auth0 for (sharkiq const.AUTH0_SCOPES). */
export const AUTH0_SCOPES = 'openid profile email offline_access';

/** The deep link of the app, where the US authorization code is sent (sharkiq AUTH0_REDIRECT_URI). */
export const AUTH0_REDIRECT_URI =
  'com.sharkninja.shark://login.sharkninja.com/ios/com.sharkninja.shark/callback';

/**
 * The two regions of sharkiq. `flow` is how sharkiq 1.5.1 gets the Auth0 id
 * token there: the EU account goes through the Auth0 password grant
 * (`europe=True` takes the auth0-python `GetToken.login` path), the US one
 * through the cross-origin flow (`/co/authenticate`, `/authorize` with PKCE,
 * the consent page, then the code exchange).
 */
export const REGIONS = {
  eu: {
    auth0: 'https://logineu.sharkninja.com',
    clientId: 'rKDx9O18dBrY3eoJMTkRiBZHDvd9Mx1I',
    flow: 'password',
    login: 'https://user-field-eu.aylanetworks.com',
    device: 'https://ads-eu.aylanetworks.com',
    appId: 'android_shark_prod-lg-id',
    appSecret: 'android_shark_prod-xuf9mlHOo0p3Ty5bboFROSyRBlE',
  },
  us: {
    auth0: 'https://login.sharkninja.com',
    clientId: 'wsguxrqm77mq4LtrTrwg8ZJUxmSrexGi',
    flow: 'cross_origin',
    login: 'https://user-sharkue1.aylanetworks.com',
    device: 'https://ads-sharkue1.aylanetworks.com',
    appId: 'ios_shark_prod-3A-id',
    appSecret: 'ios_shark_prod-74tFWGNg34LQCmR0m45SsThqrqs',
  },
};

/**
 * The User-Agents. sharkiq sends its desktop browser one (BROWSER_USERAGENT)
 * to Ayla, and the Android browser one in the US cross-origin flow
 * (auth0.py). Its EU password grant goes through auth0-python
 * (`GetToken.login`), which sends that library's own User-Agent
 * ("Python/3.x") and an `Auth0-Client` header: here the EU grant sends the
 * desktop browser one instead (a choice, not a copy; to check on a real EU
 * account, see TODO.md).
 */
export const USER_AGENTS = {
  browser:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  mobile:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
};

/** sharkiq OperatingModes: the values of `Operating_Mode`. */
export const OPERATING_MODE = {
  STOP: 0,
  PAUSE: 1,
  START: 2,
  RETURN: 3,
  EXPLORE: 4,
  MOP: 7,
  VACUUM_AND_MOP: 8,
};

/** The operating modes of a robot at work. */
export const CLEANING_MODES = new Set([
  OPERATING_MODE.START,
  OPERATING_MODE.EXPLORE,
  OPERATING_MODE.MOP,
  OPERATING_MODE.VACUUM_AND_MOP,
]);

/**
 * The three suction powers of the app: `ayla` is the value of `Power_Mode`
 * (sharkiq PowerModes), `gladys` the VACUUM_CLEANER_CLEAN_MODE value of the
 * Gladys select (eco ~ quiet, normal ~ auto, max ~ deep clean), as
 * callemand/gladys-roborock maps the suction levels of its robots.
 */
export const SUCTION = {
  eco: { ayla: 1, gladys: 2 },
  normal: { ayla: 0, gladys: 0 },
  max: { ayla: 2, gladys: 4 },
};
export const SUCTION_KEYS = Object.keys(SUCTION);

/** The Ayla property names used (sharkiq Properties, without the GET_/SET_ prefix). */
export const PROPERTY = {
  OPERATING_MODE: 'Operating_Mode',
  POWER_MODE: 'Power_Mode',
  BATTERY: 'Battery_Capacity',
  CHARGING: 'Charging_Status',
  DOCKED: 'DockedStatus',
  ERROR: 'Error_Code',
  FIND: 'Find_Device',
};

/** Gladys values (server/utils/constants.js of the core). */
export const GLADYS = {
  /** BUTTON_PUSH.PRESSED: the value a `button/push` feature sends. */
  PRESSED: 1,
  /** VACUUM_CLEANER_CLEAN_MODE: its range (the select offers three of them). */
  CLEAN_MODE_MAX: 6,
  /** VACUUM_CLEANER_STATE. */
  STATE: {
    STOPPED: 0,
    RUNNING: 1,
    PAUSED: 2,
    ERROR: 3,
    RETURNING: 4,
    CHARGING: 5,
    DOCKED: 6,
  },
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { default: 60, min: 30, max: 900 };

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** A read, a sign-in step. */
  requestTimeout: 15_000,
  /** The buttons and the Discovery scan wait for Gladys; their requests are shorter. */
  quickTimeout: 10_000,
  /**
   * Gladys gives up on a set_value after 5 s and shows a failure: a command
   * not sent 3.5 s after it arrived is refused, never sent after the failure.
   */
  commandDeadline: 3_500,
  /** The command request leaves 3.4 s after the arrival at the latest… */
  commandStartBy: 3_400,
  /** …and is answered by 4.6 s after the arrival (its timeout: receivedAt + 4.6 s - now). */
  commandAnswerBy: 4_600,
  /** The read just before a command: 2.5 s at most. */
  commandReadTimeout: 2_500,
  /** A command uses the current token when it is valid for 60 s more (no renewal inside it). */
  commandTokenValidity: MINUTE,
  /** The shortest timeout worth a request, inside the command deadline. */
  minRequestTimeout: 300,
  /**
   * After an operating mode (or a suction power) was sent, a command is never
   * skipped as "already done" for that long: the cloud may still show the
   * state from before.
   */
  recentCommand: MINUTE,
  /** The re-reads after a command, to show its effect. */
  followUps: [5_000, 15_000, 45_000],
  /**
   * Renew the Ayla token this long before it expires (sharkiq: 600 s), or at
   * half its lifetime when it lasts less than twice that.
   */
  tokenMargin: 10 * MINUTE,
  /** Two renewals are at least this far apart, whatever asks (timer, read, 401, command). */
  renewMinGap: MINUTE,
  /**
   * A sign-in that failed before the password could leave (the name did not
   * resolve, no connection) may be tried again this many times, spaced by the
   * backoff; the count is kept in /data.
   */
  preSendRetries: 2,
  /** The Ayla exchange of an id token already obtained: tried at most this many times. */
  exchangeAttempts: 3,
  /** Lifetime assumed when Ayla gives none. */
  tokenLifetime: HOUR,
  /** The longest lifetime believed (a bigger `expires_in` is capped). */
  tokenLifetimeMax: 30 * 24 * HOUR,
  /** A failed renewal (network, 5xx) is tried again after these delays. */
  renewRetry: [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR],
  /** An API 401 renews the token at most this often (never in a loop). */
  unauthorizedRenewGap: 10 * MINUTE,
  /** Pauses after failures, never shorter than the poll interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** 429: a pause between 60 s and 6 h, Retry-After when given (5 min otherwise). */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** 5xx: the backoff, kept in /data, capped at this when read back. */
  unavailableMax: 15 * MINUTE,
  /** The robot list (names, online) is read again this often. */
  listInterval: 10 * MINUTE,
  /** The buttons and the Discovery scan read the cloud at most every 30 s. */
  testCooldown: 30_000,
  /** States flushed to Gladys every second; unchanged ones again every 30 min. */
  flushInterval: 1_000,
  stateHeartbeat: 30 * MINUTE,
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute. */
  statesPerMinute: 280,
  statesPerRequest: 100,
  sceneEventsPerMinute: 280,
  queuedEvents: 200,
  /** The biggest answer read (the property list of a robot is a few tens of KB). */
  responseBytes: 512 * 1024,
  /** The biggest Auth0 page read (the consent form). */
  pageBytes: 64 * 1024,
  /** Robots of an account, properties of a robot, cookies kept during a sign-in. */
  robots: 20,
  properties: 1_000,
  cookies: 30,
  textLength: 120,
};
