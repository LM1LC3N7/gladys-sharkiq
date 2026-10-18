// -----------------------------------------------------------------------------
// The integration: the Shark account (e-mail, password, region), the robots
// of the account, one read of each robot per cycle (60 s by default), the
// Gladys devices and their states, the transport badges and the commands.
//
// The password is used only when the user acts: once after the credentials
// are saved (or at the first start with them), then only on a click on
// "Sign in to Shark". The allowance is used up and saved BEFORE the password
// leaves; only a failure proved to come before it left (no name, no
// connection) gives it back, twice at most. A refused password, a
// verification asked (a code, a CAPTCHA), a blocked account, an interrupted
// or unfinished sign-in, an unreadable /data or an expired session is a stop
// kept in /data, never retried by itself: each attempt counts against the
// Auth0 lockout, and could send a code. The Ayla token (about 24 h) is
// renewed from the refresh token by a timer of its own, 10 minutes before it
// expires (half its lifetime for a short one), never twice within a minute.
//
// Commands (five buttons and the suction select):
// - every command is refused when it cannot be sent within 3.5 s of its
//   arrival (Gladys shows a failure after 5 s: nothing must leave after it);
// - start, pause, return to the dock and the suction power read the robot
//   again just before acting (never a state in memory), and are refused when
//   that read fails or lacks the operating mode; "already done" sends
//   nothing, unless a different order was sent in the last minute (the cloud
//   may still show the state from before);
// - stop and locate decide nothing, so they read nothing;
// - one command at a time per robot (a promise chain), but stop: it never
//   waits behind the chain, only behind a start request already in flight
//   (so it lands after it). A stop, a pause or a return to the dock counts at
//   its arrival: a start queued or reading that sees the count change is
//   refused, up to the moment it sends;
// - a command that may have reached the cloud is never said "not sent":
//   "sent, without a confirmation", and the robot is read again soon.
//
// The pauses (429 for every path, commands included; 5xx for the reads) and
// the stops are kept in /data. index.js only wires the SDK handlers to this
// class (src/handlers.js).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { AylaClient } from './ayla.js';
import { normalizeConfig } from './config.js';
import { GLADYS, OPERATING_MODE, PROPERTY, REGIONS, SUCTION, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  parseFeatureId,
  statesOf,
  suctionOf,
} from './devices.js';
import { SharkError, errorReason } from './http.js';
import { T, age, join, reasonOf, word } from './i18n.js';
import { isCleaning, parseDevices, parseRobot } from './model.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/**
 * Stops never lifted by themselves: only "Sign in to Shark" or new
 * credentials. `interrupted`: the password may have left but no answer
 * says how it went; `incomplete`: Auth0 accepted the password, the end of
 * the sign-in failed; `store`: /data cannot be read or written.
 */
const STOPS = new Set([
  'refused',
  'verification',
  'locked',
  'unsupported',
  'session_expired',
  'interrupted',
  'incomplete',
  'store',
]);

/** Auth0 answers that judged the password: a stop of their own kind. */
const JUDGED = new Set(['refused', 'verification', 'locked', 'unsupported', 'no_credentials']);

/** Failures of the Ayla exchange (no password involved) worth another try. */
const EXCHANGE_TRANSIENT = new Set(['network', 'timeout', 'unavailable', 'rate_limited']);

/** Errors after which the cloud did not answer usefully: every robot is unreachable. */
const OFFLINE = new Set(['network', 'timeout', 'unavailable']);

/** Errors of one robot only: the others are still read. */
const PER_ROBOT = new Set([
  'not_found',
  'forbidden',
  'bad_response',
  'size',
  'http',
  'unavailable',
  'timeout',
]);

/** Per-robot errors that say nothing about the robot itself (the cloud did not answer). */
const TRANSIENT = new Set(['unavailable', 'timeout', 'http']);

/** Command errors after which Ayla may have executed it anyway. */
const MAYBE_SENT = new Set(['timeout', 'network', 'unavailable', 'bad_response', 'size']);

/** The commands that end a cleaning: one arriving cancels a start not sent yet. */
const HALTS = new Set(['stop', 'pause', 'dock']);

/** A refusal shown in the ack of the command (Gladys shows the message). */
class Refusal extends Error {}

/** The last 4 characters of a serial number, for the logs (never the whole DSN). */
const short = (dsn) => `…${String(dsn).slice(-4)}`;

export class SharkApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sharkiq' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    random,
    regions = REGIONS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.regions = regions;
    this.client = new AylaClient({ transport, now, random });
    this.client.onChange = () => this.persist();
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** dsn -> { dsn, name, model, online, props, seenAt } */
    this.robots = new Map();
    /** dsn -> the kind of the error of its last read, while it fails */
    this.unreadable = new Map();
    this.listAt = undefined;
    this.readAt = undefined;
    this.published = undefined;
    /** deviceId -> badge last published (JSON) */
    this.badges = new Map();
    this.timer = undefined;
    this.renewTimer = undefined;
    this.followUpTimers = new Set();
    this.running = undefined;
    this.generation = 0;
    /** undefined | a kind of STOPS */
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.offline = false;
    this.failures = 0;
    this.renewFailures = 0;
    this.pausedUntil = 0;
    /** 'rate' (429: every path), 'unavailable' (5xx: the reads), 'backoff' (the reads). */
    this.pauseKind = undefined;
    /** 'auth' | 'api': where the current 429 pause comes from. */
    this.pauseSource = undefined;
    /** dsn -> tail of its command chain: one command at a time per robot */
    this.commandChains = new Map();
    /** dsn -> how many stop, pause or dock commands arrived (a start compares it). */
    this.haltCounts = new Map();
    /** dsn -> how many stop requests left (a start in flight compares it). */
    this.stopSends = new Map();
    /** dsn -> the start request in flight (settles, never rejects). */
    this.starts = new Map();
    /** dsn -> { mode, at }: the last operating mode sent (or maybe sent). */
    this.sentModes = new Map();
    /** dsn -> when a suction power was last sent. */
    this.sentPower = new Map();
    this.lastStatus = undefined;
    this.lastTestAt = -Infinity;
    this.lastSignInAt = -Infinity;
    /** An Auth0 id token whose Ayla exchange failed: kept in memory only, never the password. */
    this.idToken = undefined;
    this.exchangeFailures = 0;
    /** The password is on its way: a save now records the "interrupted" stop. */
    this.signingIn = false;
    /** /data could not be read: no sign-in without a click. */
    this.storeBroken = false;
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** `fresh`: the user saved new credentials: their one sign-in is allowed, the stops lifted. */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    let saved = null;
    this.storeBroken = false;
    try {
      saved = await this.store.load();
    } catch (err) {
      // Not "no file yet" (EACCES, a corrupt file): what it held is unknown,
      // so no sign-in by itself, and the file is left as it is.
      this.storeBroken = true;
      this.logger.warn(`Shark: /data cannot be read (${err.message})`);
    }
    const loaded = normalizeMemory(saved, this.now());
    const { account } = this.config;
    let memory = loaded;
    if (loaded.account !== account) {
      // Credentials never used here (the first save, another e-mail or region):
      // their tokens and stops are not these, and one sign-in is allowed. A 429 pause stays.
      memory = {
        account,
        tokens: null,
        pause: loaded.pause,
        block: null,
        signIn: account !== '',
        preSend: 0,
      };
    }
    if (fresh) {
      memory = { ...memory, tokens: null, block: null, signIn: account !== '', preSend: 0 };
    }
    if (!this.config.email || !this.config.password || this.storeBroken) {
      memory = { ...memory, tokens: null, signIn: false };
    }
    this.memory = memory;
    const { pause, block } = memory;
    if (pause && pause.until > this.now()) {
      this.pausedUntil = pause.until;
      this.pauseKind = pause.kind;
      this.pauseSource = pause.source;
    }
    if (block) {
      this.blocked = block.kind;
      this.blockDetail = block.detail;
    }
    this.client.configure({
      region: this.regions[this.config.region],
      email: this.config.email,
      password: this.config.password,
      tokens: memory.tokens,
    });
    if (this.storeBroken && this.client.hasCredentials) {
      this.blocked = 'store';
    } else if (
      this.client.hasCredentials &&
      !this.client.tokens &&
      !memory.signIn &&
      !this.blocked
    ) {
      // Signed in before with these credentials, but the session is gone: a click is needed.
      this.blocked = 'session_expired';
    }
    if (!this.storeBroken) {
      await this.persist();
    }
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (this.blocked) {
      await this.setStatus(false, this.blockedMessage());
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.connecting);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.clearRenewTimer();
    for (const handle of this.followUpTimers) {
      this.timers.clearTimeout(handle);
    }
    this.followUpTimers.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearRenewTimer() {
    if (this.renewTimer) {
      this.timers.clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /** Forgets the robots and the failures: a new account, or a restart. A 429 pause stays. */
  reset() {
    this.robots.clear();
    this.unreadable.clear();
    this.sentModes.clear();
    this.sentPower.clear();
    this.listAt = undefined;
    this.readAt = undefined;
    this.published = undefined;
    this.badges.clear();
    this.blocked = undefined;
    this.blockDetail = undefined;
    this.offline = false;
    this.failures = 0;
    this.renewFailures = 0;
    this.idToken = undefined;
    this.exchangeFailures = 0;
    this.signingIn = false;
    if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
      this.pauseSource = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (Discovery list,
   * status, badges). The pauses, the stops and the tokens stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges.clear();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New credentials restart (their sign-in is allowed); the rest applies at once. */
  async configUpdated(raw = {}) {
    if (!this.started) {
      // Before the first connection: `connected` reads the configuration
      // itself. Taken now, it would look like new credentials and lift a stop.
      return undefined;
    }
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (
      next.email !== previous.email ||
      next.password !== previous.password ||
      next.region !== previous.region
    ) {
      return this.start(raw, { fresh: true });
    }
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.timer) {
      this.scheduleNext();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
      this.queueAll();
      await this.flush();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  /** A 429 pause holds now: every path waits, the commands included. */
  get hardPaused() {
    return this.pauseKind === 'rate' && this.now() < this.pausedUntil;
  }

  /** A 429 of the sign-in service holds now: the renewals wait for its end. */
  get authPaused() {
    return this.hardPaused && this.pauseSource === 'auth';
  }

  /**
   * The tokens, the pause, the stop and the sign-in allowance, with their
   * account. `strict`: a failed save throws (before the password leaves).
   */
  async persist({ strict = false } = {}) {
    const persisted = this.now() < this.pausedUntil && this.pauseKind !== 'backoff';
    this.memory = {
      account: this.config.account,
      tokens: this.client.tokens ? { ...this.client.tokens } : null,
      pause: persisted
        ? { kind: this.pauseKind, until: this.pausedUntil, source: this.pauseSource ?? 'api' }
        : null,
      // While the password is on its way, or an id token waits for its
      // exchange, a restart must find a stop: never a new sign-in by itself.
      block: this.blocked
        ? { kind: this.blocked, detail: this.blockDetail }
        : this.idToken
          ? { kind: 'incomplete' }
          : this.signingIn
            ? { kind: 'interrupted' }
            : null,
      signIn: this.memory.signIn === true,
      preSend: this.memory.preSend ?? 0,
    };
    if (strict) {
      await this.store.save(this.memory);
    } else {
      await this.store
        .save(this.memory)
        .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
    }
    // New tokens, a new pause or a stop: the renewal follows.
    this.scheduleRenew();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Token renewal -----------------------------------------------------------

  /**
   * The renewal of the Ayla token, at its expiry minus the margin, whatever
   * the poll interval: a command never meets an expired token. It waits for
   * the end of a 429 pause of the sign-in service and never runs during a stop.
   */
  scheduleRenew(delay) {
    this.clearRenewTimer();
    const renewAt = this.client.renewAt;
    if (!this.client.hasCredentials || this.blocked || renewAt === undefined) {
      return;
    }
    let at = delay === undefined ? renewAt : this.now() + delay;
    // A floor: a token shorter than the margin, or a host clock ahead, would
    // otherwise renew at once again and again.
    at = Math.max(at, this.client.lastRenewAt + TIMINGS.renewMinGap);
    if (this.authPaused) {
      at = Math.max(at, this.pausedUntil);
    }
    const generation = this.generation;
    this.renewTimer = this.timers.setTimeout(
      () => {
        this.renewTimer = undefined;
        if (generation !== this.generation || this.blocked || !this.client.tokens) {
          return;
        }
        if (this.authPaused) {
          this.scheduleRenew();
          return;
        }
        // A success persists the new tokens, which schedules the next renewal.
        this.client
          .token({ force: true })
          .then(() => {
            this.renewFailures = 0;
          })
          .catch((err) => this.renewFailed(err, generation));
      },
      Math.max(0, at - this.now()),
    );
  }

  /** A renewal failed: a pause, a stop (refused refresh token), or a new try later. */
  async renewFailed(err, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    this.logger.info(`Shark: token renewal failed (${errorReason(err)})`);
    if (err.kind === 'rate_limited') {
      this.pause(err);
      await this.persist();
      return;
    }
    if (STOPS.has(err.kind)) {
      await this.failed(err);
      return;
    }
    const wait = TIMINGS.renewRetry[Math.min(this.renewFailures, TIMINGS.renewRetry.length - 1)];
    this.renewFailures += 1;
    this.scheduleRenew(wait);
  }

  // --- Polling ---------------------------------------------------------------

  /** The next read: after the pause, never faster than the interval. */
  scheduleNext() {
    this.clearTimer();
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    const now = this.now();
    const interval = this.config.pollInterval * 1000;
    const delay = now < this.pausedUntil ? Math.max(this.pausedUntil - now, interval) : interval;
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Shark refresh failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /** One run at a time: a tick during a run joins it. `quick`: for a button. */
  tick({ quick = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false } = {}) {
    const generation = this.generation;
    if (!this.client.hasCredentials) {
      return;
    }
    if (this.blocked || this.now() < this.pausedUntil) {
      this.scheduleNext();
      return;
    }
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    try {
      if (!this.client.tokens) {
        if (this.idToken) {
          // Auth0 already accepted the password: only the Ayla exchange again.
          await this.exchange();
        } else if (this.memory.signIn) {
          await this.signIn();
        } else {
          throw new SharkError('session_expired', 'no session');
        }
      }
      if (generation !== this.generation) {
        return;
      }
      if (this.listAt === undefined || this.now() - this.listAt >= TIMINGS.listInterval) {
        await this.readList(generation);
      }
      const { read, transient } = await this.readAll(generation);
      if (generation !== this.generation) {
        return;
      }
      const total = this.robots.size;
      if (total > 0 && read === 0 && transient) {
        // No robot answered at all: the cloud is unreachable, the backoff follows.
        throw transient;
      }
      this.readAt = this.now();
      const hadPause = this.pauseKind !== undefined;
      this.failures = 0;
      this.offline = false;
      // A 429 met meanwhile by a command (its read) still holds.
      if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
        this.pauseKind = undefined;
        this.pausedUntil = 0;
        this.pauseSource = undefined;
      }
      if (hadPause || this.memory.pause || this.memory.block) {
        await this.persist();
      }
      await this.setStatus(true, total === 0 ? T.noRobot : T.connected(read, total));
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.timeout = undefined;
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.scheduleNext();
    }
  }

  /**
   * The one sign-in with the password these credentials (or this click)
   * allow. The allowance is used up, and saved to /data, BEFORE the password
   * leaves: a failed save sends nothing. Only a failure proved to come
   * before the password left (the name did not resolve, no connection, on
   * the first Auth0 request) gives it back, twice at most (count kept in
   * /data). Anything else is a stop that waits for a click: a timeout, a
   * reset, a 5xx or a 429 of Auth0 ("interrupted"), or a failure after Auth0
   * accepted the password ("incomplete"). The id token of an accepted
   * password is kept in memory, so only its Ayla exchange is tried again.
   */
  async signIn() {
    this.memory.signIn = false;
    this.signingIn = true;
    try {
      await this.persist({ strict: true });
    } catch (err) {
      this.signingIn = false;
      throw new SharkError('store', `cannot save the state before signing in (${err.message})`);
    }
    let idToken;
    try {
      idToken = await this.client.auth0();
    } catch (err) {
      this.signingIn = false;
      throw this.signInError(err);
    }
    this.signingIn = false;
    this.idToken = idToken;
    this.exchangeFailures = 0;
    await this.exchange();
  }

  /** What a failed Auth0 step becomes (see signIn). */
  signInError(err) {
    if (err.beforeSend && (this.memory.preSend ?? 0) < TIMINGS.preSendRetries) {
      this.memory.preSend = (this.memory.preSend ?? 0) + 1;
      this.memory.signIn = true;
      this.logger.info('Shark: the sign-in failed before the password left; one more try later');
      return err;
    }
    if (err.afterPassword) {
      return new SharkError('incomplete', 'the sign-in did not finish', {
        status: err.status,
        code: err.code ?? err.kind,
      });
    }
    if (JUDGED.has(err.kind)) {
      return err;
    }
    if (err.kind === 'rate_limited') {
      this.pause(err);
    }
    return new SharkError('interrupted', 'the sign-in was interrupted', {
      status: err.status,
      code: err.kind,
    });
  }

  /**
   * The Ayla exchange of the id token (no password): a network error, a
   * timeout, a 5xx or a 429 is tried again on the next runs (spaced by the
   * backoff), three times in all; then, or on any other failure,
   * "incomplete".
   */
  async exchange() {
    try {
      await this.client.exchange(this.idToken);
    } catch (err) {
      this.exchangeFailures += 1;
      if (EXCHANGE_TRANSIENT.has(err.kind) && this.exchangeFailures < TIMINGS.exchangeAttempts) {
        throw err;
      }
      this.idToken = undefined;
      throw new SharkError('incomplete', 'the sign-in did not finish', {
        status: err.status,
        code: err.kind,
      });
    }
    this.idToken = undefined;
    this.exchangeFailures = 0;
    this.memory.preSend = 0;
    this.blocked = undefined;
    await this.persist();
    this.logger.info('Shark: signed in');
  }

  /** The robots of the account (names, models, online). */
  async readList(generation) {
    const robots = parseDevices(await this.client.devices());
    if (generation !== this.generation) {
      return;
    }
    this.listAt = this.now();
    const seen = new Set();
    for (const { dsn, name, model, online } of robots) {
      seen.add(dsn);
      const robot = this.robots.get(dsn) ?? { dsn, props: undefined, seenAt: undefined };
      this.robots.set(dsn, { ...robot, name, model, online });
    }
    for (const dsn of [...this.robots.keys()]) {
      if (!seen.has(dsn)) {
        this.robots.delete(dsn);
        this.unreadable.delete(dsn);
      }
    }
    await this.publishDevices();
  }

  /**
   * Every robot, one after the other. An error of one robot (404, 403, 5xx, a
   * timeout, a bad answer) marks only that robot; any other error (network,
   * 429, the session) ends the cycle. `transient`: the last
   * 5xx/timeout/other HTTP error, when no robot answered.
   */
  async readAll(generation) {
    let read = 0;
    let transient;
    for (const dsn of [...this.robots.keys()]) {
      try {
        const list = await this.client.properties(dsn);
        if (generation !== this.generation) {
          return { read };
        }
        this.unreadable.delete(dsn);
        this.ingest(dsn, parseRobot(list));
        read += 1;
      } catch (err) {
        if (!PER_ROBOT.has(err.kind)) {
          throw err;
        }
        if (TRANSIENT.has(err.kind)) {
          transient = err;
        }
        if (!this.unreadable.has(dsn)) {
          this.logger.warn(`Shark robot ${short(dsn)}: ${errorReason(err)}`);
        }
        this.unreadable.set(dsn, err.kind);
      }
    }
    return { read, transient: read === 0 ? transient : undefined };
  }

  /** The message of a stop. */
  blockedMessage() {
    switch (this.blocked) {
      case 'verification':
        return T.verification;
      case 'locked':
        return T.locked;
      case 'unsupported':
        return T.unsupported(this.blockDetail);
      case 'session_expired':
        return T.sessionExpired;
      case 'interrupted':
        return T.interrupted;
      case 'incomplete':
        return T.incomplete;
      case 'store':
        return T.storeBroken;
      default:
        return T.refused;
    }
  }

  /** A stop: kept in /data, never lifted by itself. */
  async block(kind, detail) {
    this.blocked = kind;
    this.blockDetail = detail;
    this.memory.signIn = false;
    this.clearTimer();
    this.logger.warn(`Shark stopped (${kind}${detail ? `, ${detail}` : ''}): waiting for the user`);
    await this.persist();
    await this.setStatus(false, this.blockedMessage());
    await this.publishBadges();
  }

  /** A failure: a stop, a pause, or a backoff. Never a dead integration but for a stop. */
  async failed(err) {
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (STOPS.has(err.kind)) {
      await this.block(err.kind, err.code);
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited') {
      wait = this.pause(err);
      message = T.rateLimited(age(wait));
    } else {
      // Never read again faster than the poll interval.
      wait = Math.max(
        this.config.pollInterval * 1000,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      if (this.pauseKind !== 'rate' || this.now() >= this.pausedUntil) {
        this.pauseKind = err.kind === 'unavailable' ? 'unavailable' : 'backoff';
        this.pauseSource = undefined;
      }
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.offline = OFFLINE.has(err.kind) || err.kind === 'unauthorized' || this.offline;
      message =
        err.kind === 'unavailable'
          ? T.unavailable(age(wait))
          : T.unreachable(reasonOf(err), age(wait));
    }
    this.failures += 1;
    await this.persist();
    const connected = err.kind === 'rate_limited' && this.readAt !== undefined;
    await this.setStatus(connected, message);
    this.logger.warn(`Shark: ${errorReason(err)}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** 429: a pause of Retry-After, between 60 s and 6 h, for every path (kept in /data). */
  pause(err) {
    const asked = err.retryAfter ?? TIMINGS.rateLimitDefault;
    const wait = Math.max(TIMINGS.rateLimitMin, Math.min(TIMINGS.rateLimitMax, asked));
    if (this.pauseKind !== 'rate' || this.now() + wait > this.pausedUntil) {
      // The source of the longest pause: the sign-in service (renewals wait) or the API.
      this.pauseSource = err.source === 'auth' ? 'auth' : 'api';
    }
    this.pausedUntil = Math.max(
      this.pauseKind === 'rate' ? this.pausedUntil : 0,
      this.now() + wait,
    );
    this.pauseKind = 'rate';
    return wait;
  }

  /** One robot as read: its values kept and its states queued. */
  ingest(dsn, props, created = this.createdFeatures()) {
    const robot = this.robots.get(dsn);
    if (!robot) {
      return props;
    }
    robot.props = props;
    robot.seenAt = this.now();
    this.queue(robot, created);
    return props;
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices() {
    if (this.listAt === undefined) {
      return;
    }
    const devices = [...this.robots.values()].map((robot) =>
      buildDevice(this.gladys, robot, this.config.language),
    );
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** Queues the states of one robot (the features created in Gladys only). */
  queue(robot, created = this.createdFeatures()) {
    if (!robot.props) {
      return;
    }
    const ids = deviceIds(this.gladys, robot.dsn);
    for (const { role, ...value } of statesOf(robot.props, this.config.language)) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueAll(created = this.createdFeatures()) {
    for (const robot of this.robots.values()) {
      this.queue(robot, created);
    }
  }

  badge(dsn) {
    if (this.blocked || this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (this.unreadable.has(dsn)) {
      return {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
        degraded: true,
        message: TRANSIENT.has(this.unreadable.get(dsn)) ? T.robotNoAnswer : T.robotUnreadable,
      };
    }
    if (this.robots.get(dsn)?.online === false) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.offline };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }

  async publishBadges() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    for (const dsn of this.robots.keys()) {
      const externalId = deviceIds(this.gladys, dsn).device;
      if (!created.has(externalId)) {
        continue;
      }
      const entry = { external_id: externalId, ...this.badge(dsn) };
      const json = JSON.stringify(entry);
      if (this.badges.get(externalId) !== json) {
        entries.push([externalId, json, entry]);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries.map(([, , entry]) => entry));
      for (const [externalId, json] of entries) {
        this.badges.set(externalId, json);
      }
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueAll(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: a fresh read of the account if the last one is old enough. */
  async scan() {
    if (
      this.client.tokens &&
      !this.blocked &&
      this.now() >= this.pausedUntil &&
      (this.readAt === undefined || this.now() - this.readAt >= TIMINGS.testCooldown)
    ) {
      this.listAt = undefined;
      await this.tick({ quick: true });
      return;
    }
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  refusal(text, cause) {
    return new Refusal(word(text, this.config.language), cause ? { cause } : undefined);
  }

  /** The value of a command, strictly. Throws a refusal when it is not valid. */
  commandValue(role, value) {
    if (role === 'suction') {
      // Strict: null, '', ' ', true or 2.5 never read as a clean mode.
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^\s*\d{1,2}\s*$/.test(value)
            ? Number(value)
            : NaN;
      const key = Number.isInteger(number) ? suctionOf(number) : undefined;
      if (key === undefined) {
        throw this.refusal(T.denied.badSuction);
      }
      return key;
    }
    if (value === GLADYS.PRESSED || value === String(GLADYS.PRESSED)) {
      return GLADYS.PRESSED;
    }
    throw this.refusal(T.denied.badButton);
  }

  async setValue(_gladysDevice, feature, value) {
    // The ack deadline counts from the arrival of the command, before any wait.
    const receivedAt = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      // Never the whole external id (it holds the serial number).
      throw new Error(
        target ? `The ${target.role} of ${short(target.dsn)} cannot be set` : 'Not a Shark command',
      );
    }
    const { dsn, role } = target;
    if (role === 'suction') {
      // Gladys shows the chosen option at once: the real one is sent again after.
      return this.serialized(dsn, () =>
        this.setSuction(dsn, this.commandValue(role, value), receivedAt),
      ).finally(() => this.republish(dsn, feature.external_id));
    }
    this.commandValue(role, value);
    if (HALTS.has(role)) {
      // Counted at once (synchronously): a start queued or reading now sees it.
      this.haltCounts.set(dsn, (this.haltCounts.get(dsn) ?? 0) + 1);
    }
    if (role === 'stop') {
      // A stop never waits behind the chain of the robot.
      return this.stopRobot(dsn, receivedAt);
    }
    const haltSeen = this.haltCounts.get(dsn) ?? 0;
    return this.serialized(dsn, () => this.command(dsn, role, receivedAt, haltSeen));
  }

  /** The value of a feature sent again to Gladys (after it showed the requested one). */
  republish(dsn, featureId) {
    this.gladys.forgetPublishedStates?.(featureId);
    const robot = this.robots.get(dsn);
    if (robot) {
      this.queue(robot);
      this.flush();
    }
  }

  /** Runs `task` after the previous task of the same key (a promise chain per key). */
  serialized(key, task) {
    const previous = this.commandChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.commandChains.set(key, tail);
    tail.then(() => {
      if (this.commandChains.get(key) === tail) {
        this.commandChains.delete(key);
      }
    });
    return run;
  }

  /** Time left before the deadline of a command that arrived at `receivedAt`. */
  remaining(receivedAt) {
    return receivedAt + TIMINGS.commandDeadline - this.now();
  }

  /** A stop, a pause or a return to the dock of this robot arrived after `haltSeen` was taken. */
  halted(dsn, haltSeen) {
    return (this.haltCounts.get(dsn) ?? 0) !== haltSeen;
  }

  /** The last operating mode sent to this robot, while it is recent. */
  recentMode(dsn) {
    const sent = this.sentModes.get(dsn);
    return sent && this.now() - sent.at < TIMINGS.recentCommand ? sent : undefined;
  }

  /** The checks every command shares, before anything is read or sent. */
  checkCommand(dsn, receivedAt) {
    if (!this.client.hasCredentials) {
      throw this.refusal(T.denied.noConfig);
    }
    if (!this.robots.has(dsn)) {
      throw this.refusal(T.denied.unknownDevice);
    }
    if (this.blocked || !this.client.tokens) {
      throw this.refusal(T.denied.stopped);
    }
    if (this.hardPaused) {
      throw this.refusal(T.denied.paused);
    }
    if (!this.client.tokenValidFor(TIMINGS.commandTokenValidity)) {
      // A renewal inside the 3.5 s would leave too little time: renewed now, refused.
      // (The renewal timer makes this rare: the token is renewed 10 min before its end.)
      this.renewSoon();
      throw this.refusal(T.denied.session);
    }
    if (this.remaining(receivedAt) <= TIMINGS.minRequestTimeout) {
      throw this.refusal(T.denied.late);
    }
  }

  /** A renewal outside any command (its failure goes through renewFailed). */
  renewSoon() {
    const generation = this.generation;
    this.client
      .token({ validity: TIMINGS.commandTokenValidity })
      .catch((err) => this.renewFailed(err, generation));
  }

  /**
   * The properties of a robot within the command deadline (2.5 s at most); a
   * refusal on any failure (nothing is sent then).
   */
  async readRobot(dsn, receivedAt) {
    let list;
    try {
      list = await this.client.properties(dsn, {
        retry: false,
        validity: 10_000,
        startBy: receivedAt + TIMINGS.commandDeadline - TIMINGS.minRequestTimeout,
        timeout: () =>
          Math.max(
            TIMINGS.minRequestTimeout,
            Math.min(TIMINGS.commandReadTimeout, this.remaining(receivedAt)),
          ),
      });
    } catch (err) {
      if (err.kind === 'late') {
        throw this.refusal(T.denied.late, err);
      }
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      if (err.kind === 'unauthorized') {
        this.renewSoon();
      }
      this.logger.info(
        `Shark robot ${short(dsn)}: no state before the command (${errorReason(err)})`,
      );
      throw this.refusal(T.denied.unreadable, err);
    }
    const props = this.ingest(dsn, parseRobot(list));
    this.unreadable.delete(dsn);
    this.flush();
    return props;
  }

  /** The checks after the read, right before sending. */
  checkAfterRead(receivedAt, generation) {
    if (generation !== this.generation || this.blocked || !this.client.tokens) {
      throw this.refusal(T.denied.stopped);
    }
    if (this.hardPaused) {
      throw this.refusal(T.denied.paused);
    }
    if (this.remaining(receivedAt) <= 0) {
      throw this.refusal(T.denied.late);
    }
  }

  /** Start, pause, return to the dock, locate: in the chain of the robot. */
  async command(dsn, role, receivedAt, haltSeen) {
    const generation = this.generation;
    if (role === 'start' && this.halted(dsn, haltSeen)) {
      throw this.refusal(T.denied.stopMeanwhile);
    }
    this.checkCommand(dsn, receivedAt);
    if (role === 'locate') {
      // A beep decides nothing: nothing to read.
      await this.send(dsn, PROPERTY.FIND, 1, receivedAt);
      this.logger.info(`Shark robot ${short(dsn)}: locate sent`);
      return;
    }
    // The state just before acting, never the one in memory.
    const props = await this.readRobot(dsn, receivedAt);
    if (role === 'start' && this.halted(dsn, haltSeen)) {
      throw this.refusal(T.denied.stopMeanwhile);
    }
    this.checkAfterRead(receivedAt, generation);
    const mode = props.operatingMode;
    if (mode === undefined) {
      throw this.refusal(T.denied.unknown);
    }
    const target = {
      start: OPERATING_MODE.START,
      pause: OPERATING_MODE.PAUSE,
      dock: OPERATING_MODE.RETURN,
    }[role];
    const recent = this.recentMode(dsn);
    // A different order sent a moment ago may not show yet: never "already done" then.
    const unsettled = recent !== undefined && recent.mode !== target;
    const busy = isCleaning(mode) || mode === OPERATING_MODE.RETURN;
    const done = {
      start: isCleaning(mode),
      // Nothing to pause on a robot neither cleaning nor returning.
      pause: mode === OPERATING_MODE.PAUSE || !busy,
      dock:
        mode === OPERATING_MODE.RETURN ||
        ((props.docked === true || props.charging === true) && !isCleaning(mode)),
    }[role];
    if (done && !unsettled) {
      this.logger.info(`Shark robot ${short(dsn)}: ${role} skipped, nothing to change`);
      return;
    }
    // Synchronous with the start of the request: no stop can slip in between.
    if (role === 'start' && this.halted(dsn, haltSeen)) {
      throw this.refusal(T.denied.stopMeanwhile);
    }
    await this.send(dsn, PROPERTY.OPERATING_MODE, target, receivedAt, { start: role === 'start' });
    this.logger.info(`Shark robot ${short(dsn)}: ${role} sent`);
  }

  /** The suction power: in the chain, on a fresh read. */
  async setSuction(dsn, option, receivedAt) {
    const generation = this.generation;
    this.checkCommand(dsn, receivedAt);
    const props = await this.readRobot(dsn, receivedAt);
    this.checkAfterRead(receivedAt, generation);
    const sentAt = this.sentPower.get(dsn);
    const recent = sentAt !== undefined && this.now() - sentAt < TIMINGS.recentCommand;
    if (props.powerMode === option && !recent) {
      return;
    }
    await this.send(dsn, PROPERTY.POWER_MODE, SUCTION[option].ayla, receivedAt);
    this.logger.info(`Shark robot ${short(dsn)}: suction power sent`);
  }

  /**
   * Stop: decides nothing, so it reads nothing; never waits behind the chain,
   * only behind a start request already in flight (until its own deadline),
   * so it lands after it.
   */
  async stopRobot(dsn, receivedAt) {
    this.checkCommand(dsn, receivedAt);
    const start = this.starts.get(dsn);
    if (start) {
      const wait = receivedAt + TIMINGS.commandStartBy - TIMINGS.minRequestTimeout - this.now();
      await this.withDeadline(start, wait).catch(() => {});
    }
    await this.send(dsn, PROPERTY.OPERATING_MODE, OPERATING_MODE.STOP, receivedAt);
    this.logger.info(`Shark robot ${short(dsn)}: stop sent`);
  }

  /** `promise`, or a timeout error after `ms` (the promise itself goes on). */
  withDeadline(promise, ms) {
    let handle;
    const deadline = new Promise((_, reject) => {
      handle = this.timers.setTimeout(
        () => reject(new SharkError('timeout', 'no answer within the command')),
        Math.max(0, ms),
      );
    });
    return Promise.race([promise, deadline]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * The SET_<name> datapoint within the deadline: sent 3.4 s after the
   * arrival at the latest, answered by 4.6 s. `start`: the request is kept
   * while in flight (a stop waits for it), and a stop that left meanwhile is
   * sent once more after it.
   */
  async send(dsn, name, value, receivedAt, { start = false } = {}) {
    const startBy = receivedAt + TIMINGS.commandStartBy;
    const isMode = name === PROPERTY.OPERATING_MODE;
    try {
      if (this.now() > startBy) {
        throw new SharkError('late', 'the command deadline passed');
      }
      if (isMode && value === OPERATING_MODE.STOP) {
        // Counted when the stop leaves: a start still in flight sees it.
        this.stopSends.set(dsn, (this.stopSends.get(dsn) ?? 0) + 1);
      }
      const stopsBefore = this.stopSends.get(dsn) ?? 0;
      const request = this.client.setProperty(dsn, name, value, {
        startBy,
        // The token must last until the answer: renewals are done before.
        validity: TIMINGS.commandAnswerBy,
        timeout: () =>
          Math.max(TIMINGS.minRequestTimeout, receivedAt + TIMINGS.commandAnswerBy - this.now()),
      });
      if (start) {
        const settled = request.catch(() => {});
        this.starts.set(dsn, settled);
        settled.then(() => {
          if (this.starts.get(dsn) === settled) {
            this.starts.delete(dsn);
          }
          if ((this.stopSends.get(dsn) ?? 0) !== stopsBefore) {
            // A stop left while this start was still in flight: the cloud may
            // apply the start last. Stopped once more, after it.
            this.logger.warn(`Shark robot ${short(dsn)}: stopping again after a start`);
            this.send(dsn, PROPERTY.OPERATING_MODE, OPERATING_MODE.STOP, this.now()).catch((err) =>
              this.logger.warn(
                `Shark robot ${short(dsn)}: stopping again failed (${errorReason(err.cause ?? err)})`,
              ),
            );
          }
        });
      }
      await request;
    } catch (err) {
      if (err instanceof Refusal) {
        throw err;
      }
      if (err.kind === 'late') {
        throw this.refusal(T.denied.late, err);
      }
      if (err.kind === 'unauthorized') {
        // Refused by Ayla, so not executed: renewed at once for the next command.
        this.renewSoon();
        throw this.refusal(T.denied.session, err);
      }
      if (err.kind === 'rate_limited') {
        this.pause(err);
        await this.persist();
      }
      if (MAYBE_SENT.has(err.kind)) {
        // The request may have reached Ayla: the robot may change anyway.
        this.remember(dsn, name, value);
        this.followUp();
        throw new Error(word(T.maybeSent(reasonOf(err)), this.config.language), { cause: err });
      }
      throw new Error(word(T.commandFailed(reasonOf(err)), this.config.language), { cause: err });
    }
    this.remember(dsn, name, value);
    this.followUp();
  }

  /** An order sent (or maybe sent): no "already done" on it for a minute. */
  remember(dsn, name, value) {
    if (name === PROPERTY.OPERATING_MODE) {
      this.sentModes.set(dsn, { mode: value, at: this.now() });
    } else if (name === PROPERTY.POWER_MODE) {
      this.sentPower.set(dsn, this.now());
    }
  }

  /** A few reads after a command, to show its effect. */
  followUp() {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        this.followUpTimers.delete(handle);
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.warn(`Shark refresh failed: ${err.message}`));
        }
      }, delay);
      this.followUpTimers.add(handle);
    }
  }

  // --- Configuration buttons -------------------------------------------------

  /** The pause message (429: every path; 5xx: the reads), or undefined. */
  pauseMessage() {
    const left = this.pausedUntil - this.now();
    if (left <= 0) {
      return undefined;
    }
    if (this.pauseKind === 'rate') {
      return T.rateLimited(age(left));
    }
    return this.pauseKind === 'unavailable' ? T.unavailable(age(left)) : undefined;
  }

  /** Lifts a 5xx or network backoff (a button asks for a read now); a 429 pause stays. */
  liftBackoff() {
    if (this.pauseKind !== 'rate') {
      this.pausedUntil = 0;
      this.pauseKind = undefined;
      this.pauseSource = undefined;
    }
  }

  /** "Test the connection": one read, never the password. */
  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked) {
      return this.blockedMessage();
    }
    if (!this.client.tokens) {
      return T.test.noSession;
    }
    if (this.hardPaused) {
      return this.pauseMessage();
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.cooldown, last) : T.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = this.now();
    this.liftBackoff();
    this.listAt = undefined;
    await this.tick({ quick: true });
    return this.lastMessage ?? T.noCredentials;
  }

  /**
   * "Sign in to Shark": the click that allows one sign-in with the password
   * (lifting a stop). With a working session, a plain test (no password).
   */
  async signInAction() {
    if (!this.client.hasCredentials) {
      return T.signIn.noCredentials;
    }
    if (this.hardPaused) {
      return this.pauseMessage();
    }
    if (this.now() - this.lastSignInAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.cooldown, last) : T.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastSignInAt = this.now();
    if (!this.client.tokens || this.blocked) {
      this.logger.info('Shark: sign-in asked by the user');
      this.blocked = undefined;
      this.blockDetail = undefined;
      this.client.tokens = null;
      this.idToken = undefined;
      this.exchangeFailures = 0;
      // The click decides: what /data held (unreadable) is replaced.
      this.storeBroken = false;
      this.memory.signIn = true;
      this.memory.preSend = 0;
    }
    this.liftBackoff();
    this.listAt = undefined;
    await this.persist();
    await this.setStatus(false, T.connecting);
    await this.tick({ quick: true });
    return this.lastMessage ?? T.noCredentials;
  }
}
