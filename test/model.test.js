// -----------------------------------------------------------------------------
// The pure parts: Ayla answers -> robots, robots -> Gladys states, the
// configuration, the persisted state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountKey, normalizeConfig } from '../src/config.js';
import { statesOf } from '../src/devices.js';
import { integerOf, parseDevices, parseRobot, stateOf } from '../src/model.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreError, fileStore, normalizeMemory } from '../src/store.js';
import { HOUR, NOW } from './fixtures/shark.js';

const prop = (name, value) => ({ property: { name, value } });

test('integers are strict: null, "", 1.5, "abc" are unknown, never 0', () => {
  assert.equal(integerOf(3), 3);
  assert.equal(integerOf('42'), 42);
  assert.equal(integerOf(true), 1);
  for (const value of [null, undefined, '', ' ', 1.5, 'abc', {}, [], NaN]) {
    assert.equal(integerOf(value), undefined, String(value));
  }
});

test('the reported GET_ value wins over the last SET_ order, whatever the order', () => {
  const robot = parseRobot([
    prop('GET_Operating_Mode', 0),
    prop('SET_Operating_Mode', 2),
    prop('SET_Power_Mode', 2),
    prop('GET_Power_Mode', 1),
  ]);
  assert.equal(robot.operatingMode, 0);
  assert.equal(robot.powerMode, 'eco');
});

test('an operating mode is never read from an order; the suction power may be', () => {
  const robot = parseRobot([prop('SET_Operating_Mode', 2), prop('SET_Power_Mode', 2)]);
  assert.equal(robot.operatingMode, undefined);
  assert.equal(robot.powerMode, 'max');
});

test('values out of range or unknown are dropped', () => {
  const robot = parseRobot([
    prop('GET_Operating_Mode', 5),
    prop('GET_Battery_Capacity', 140),
    prop('GET_Charging_Status', 3),
    prop('GET_Error_Code', -1),
    prop('GET_Power_Mode', 7),
    { property: { name: 42 } },
    null,
  ]);
  assert.deepEqual(robot, {
    operatingMode: undefined,
    powerMode: undefined,
    battery: undefined,
    charging: undefined,
    docked: undefined,
    errorCode: undefined,
  });
  assert.equal(stateOf(robot), undefined);
  assert.deepEqual(statesOf(robot, 'fr'), []);
});

test('the Gladys state: error first, then the operating mode, then charging and docked', () => {
  const s = (props) => stateOf({ ...props });
  assert.equal(s({ operatingMode: 2, errorCode: 4 }), 3);
  assert.equal(s({ operatingMode: 2, errorCode: 0 }), 1);
  assert.equal(s({ operatingMode: 7 }), 1, 'mopping');
  assert.equal(s({ operatingMode: 1 }), 2);
  assert.equal(s({ operatingMode: 3 }), 4);
  assert.equal(s({ operatingMode: 0, charging: true, docked: true }), 5);
  assert.equal(s({ operatingMode: 0, charging: false, docked: true }), 6);
  assert.equal(s({ operatingMode: 0 }), 0);
  assert.equal(s({ charging: true }), 5);
  assert.equal(s({}), undefined);
});

test('the robot list: valid serial numbers only, no duplicates, online read', () => {
  const robots = parseDevices([
    {
      device: {
        dsn: 'AC000W1',
        product_name: 'Salon',
        oem_model: 'RV1',
        connection_status: 'Online',
      },
    },
    { device: { dsn: 'AC000W1', product_name: 'Twice' } },
    { device: { dsn: 'bad:dsn' } },
    { device: { dsn: 'AC000W2', connection_status: 'Offline' } },
    { nothing: true },
  ]);
  assert.deepEqual(robots, [
    { dsn: 'AC000W1', name: 'Salon', model: 'RV1', online: true },
    { dsn: 'AC000W2', name: undefined, model: '', online: false },
  ]);
});

test('the configuration: region, interval bounds, language, account hash', () => {
  const config = normalizeConfig({
    region: 'US',
    email: ' Me@Example.com ',
    password: ' pass ',
    poll_interval: '5',
    language: 'EN',
  });
  assert.equal(config.region, 'us');
  assert.equal(config.email, 'Me@Example.com');
  assert.equal(config.password, ' pass ', 'spaces kept in a password');
  assert.equal(config.pollInterval, 30);
  assert.equal(config.language, 'en');
  assert.equal(config.account, accountKey('us', 'me@example.com'));
  assert.notEqual(accountKey('eu', 'me@example.com'), config.account);
  assert.ok(!config.account.includes('example'));
  const defaults = normalizeConfig({ region: 'mars', poll_interval: '' });
  assert.deepEqual([defaults.region, defaults.pollInterval, defaults.language], ['eu', 60, 'fr']);
});

test('the /data file: none yet is null; a corrupt one throws, never read as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sharkiq-'));
  try {
    const path = join(dir, 'state.json');
    const store = fileStore(path);
    assert.equal(await store.load(), null, 'ENOENT: nothing saved yet');
    await store.save({ account: 'abc' });
    assert.deepEqual(await store.load(), { account: 'abc' });
    await writeFile(path, '{"account": "ab', 'utf8');
    await assert.rejects(store.load(), (err) => err instanceof StoreError);
    const folder = fileStore(dir);
    await assert.rejects(folder.load(), (err) => err instanceof StoreError, 'EISDIR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the persisted state is repaired and its pauses capped', () => {
  const memory = normalizeMemory(
    {
      account: 'abc',
      tokens: { accessToken: 'access-token-1', refreshToken: 'refresh-token-1', expiresAt: 5 },
      pause: { kind: 'rate', source: 'auth', until: NOW + 100 * HOUR },
      block: { kind: 'verification', detail: 'requires_verification' },
      signIn: true,
    },
    NOW,
  );
  assert.equal(memory.pause.until, NOW + 6 * HOUR);
  assert.equal(memory.pause.source, 'auth');
  assert.deepEqual(memory.block, { kind: 'verification', detail: 'requires_verification' });
  assert.equal(memory.signIn, true);
  const unavailable = normalizeMemory(
    { account: 'abc', pause: { kind: 'unavailable', until: NOW + HOUR } },
    NOW,
  );
  assert.equal(unavailable.pause.until, NOW + 15 * 60_000);
  const junk = normalizeMemory(
    {
      account: 'abc',
      tokens: { accessToken: 'x' },
      block: { kind: 'whatever', detail: 'Some <text>' },
      pause: { kind: 'other', until: NOW + HOUR },
    },
    NOW,
  );
  assert.deepEqual([junk.tokens, junk.block, junk.pause, junk.signIn], [null, null, null, false]);
  assert.deepEqual(normalizeMemory(null), {
    account: '',
    tokens: null,
    pause: null,
    block: null,
    signIn: false,
    preSend: 0,
  });
});
