# gladys-sharkiq

[Gladys Assistant](https://gladysassistant.com) external integration for
**Shark robot vacuums** (Shark IQ, Shark AI…), through the Shark cloud: the
SharkNinja Auth0 sign-in and Ayla Networks, the unofficial API of the
SharkClean app, EU and North American accounts. State, battery, suction power,
error, and the Start, Pause, Stop, Return to the dock and Locate buttons.
Unofficial, not affiliated with SharkNinja.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Unofficial API, tested against a fake
> Shark cloud only, never with a real robot or account.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SharkApp) ⇄ src/ayla.js ⇄ user-/ads-*.aylanetworks.com
                                   │                       └─ src/auth0.js ⇄ login(eu).sharkninja.com
                                   ├─ src/model.js      Ayla properties -> robots (pure)
                                   ├─ src/devices.js    -> Gladys devices and states (pure)
                                   ├─ src/store.js      /data: tokens, sign-in allowance, pauses, stops
                                   └─ src/publisher.js  300 states/min
```

- **Sign-in** (as sharkiq 1.5.1): EU, the Auth0 password grant
  (`POST /oauth/token`); US, the cross-origin flow (`/co/authenticate`,
  `/authorize` with PKCE, the consent page, `/authorize/resume`, the code
  exchange), with the Auth0 cookies of the sign-in only and no redirect
  followed outside the Auth0 origin. The id token is exchanged at Ayla
  `token_sign_in` (app id and secret of the region) for an access token
  (`Authorization: auth_token …`, about 24 h) and a refresh token. Unlike
  sharkiq, one flow per sign-in, never a second one on failure.
- **The password only on a click**: one sign-in is allowed per saved
  credentials (persisted as `signIn` in `/data`), then only "Sign in to
  Shark". A refusal (`invalid_grant`, `access_denied`…), a verification
  (`requires_verification`, `mfa_required`), a lockout
  (`too_many_attempts`), an unknown answer or a refused refresh token is a
  stop kept in `/data`, never lifted by itself (a reconnection to Gladys
  neither). Only network errors, timeouts, 5xx and 429 keep the allowance.
- **Renewal**: a timer refreshes the Ayla token 10 minutes before it expires
  (`/users/refresh_token.json`), whatever the poll interval; failures retried
  after 1, 5, 15, 60 min; a 429 of the sign-in service delays it. An API 401
  renews at most every 10 minutes and retries once.
- **Reading**: `devices.json` every 10 min (names, models, online), then
  `properties.json` of each robot every 60 s (30 to 900). `GET_` (reported)
  wins over `SET_` (last order); the operating mode is never read from an
  order. Per-robot errors mark that robot only (degraded badge). 429: a pause
  of Retry-After between 60 s and 6 h for every path, commands included; 5xx:
  a backoff (1 to 15 min) for the reads; both kept in `/data`, capped when
  read back.
- **Devices**: `ext:<selector>:sharkiq:<dsn>`. Features by role: `state`
  (vacuum-cleaner/state, read only), `battery` (battery/integer, percent),
  `suction` (vacuum-cleaner/clean-mode: Eco = quiet 2, Normal = auto 0, Max =
  deep clean 4), `error` (text), `start`, `pause`, `stop`, `dock`, `locate`
  (button/push). No switch, no writable binary.
- **Commands** (`POST …/properties/SET_<name>/datapoints.json`): refused when
  they cannot leave within 3.5 s of their arrival (sent by 3.4 s, answered by
  4.6 s). Start, pause, dock and suction read the properties again first
  (2.5 s at most) and are refused without the operating mode; "already done"
  sends nothing unless another order left in the last minute. Stop and locate
  read nothing. One command at a time per robot; stop never waits behind the
  chain, only behind a start request in flight, and is sent once more if a
  start it overtook settles after it. Stop, pause and dock count at their
  arrival: a start that sees the count change is refused before it sends. A
  command that may have left is "sent, without a confirmation", followed by
  reads at 5, 15 and 45 s.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/shark.js` holds made-up robots; `test/helpers/fakeShark.js` is a
fake Auth0 (EU password grant, US cross-origin flow with cookies, consent and
a real PKCE check) and a fake Ayla cloud behind the transport.

## Credits

- [sharkiqlibs/sharkiq](https://github.com/sharkiqlibs/sharkiq) 1.5.1 (MIT):
  the sign-in, the Ayla API, the properties and the commands are ported to
  JavaScript. Notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store
(added at the first real release).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the ported logic is MIT (sharkiq), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Shark, Shark IQ and
SharkClean are trademarks of SharkNinja; this project is not affiliated with
SharkNinja.
