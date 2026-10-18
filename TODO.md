# TODO — Shark IQ v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-18): EU Auth0 password grant and US
      cross-origin sign-in (cookies, consent page, PKCE), Ayla
      `token_sign_in`, refresh by a timer, tokens in `/data`; the password
      only once per saved credentials, then only on "Sign in to Shark";
      persisted stops (refused, verification, locked, unsupported, session
      expired) never lifted by themselves; robots from `devices.json` (10 min)
      and `properties.json` (60 s, 30–900); features state, battery,
      suction, error and five buttons; command safety (fresh read, 3.5 s
      deadline, one at a time, stop never queued and cancelling a waiting
      start, "sent without a confirmation"); 429 and 5xx pauses persisted and
      capped; badges; test and sign-in buttons; en/fr; docs; cover. Tested
      against a fake cloud only (Node 22 and 24). Store validator: its only
      error expected is the `docker_image` not yet pullable from GHCR (no
      release yet). No Docker on this PC: the image build is left to the CI.
- [x] **Review fixes** (2026-10-18, review of d5cd79c): the password never
      leaves again by itself after a transient error (allowance used up and
      saved before sending, 2 retries only for a failure proved before the
      send, "interrupted"/"incomplete" stops, id token kept for the Ayla
      exchange only); no config event before the first connection; unreadable
      /data stops; renewal at half life for short tokens and 1 min apart;
      exact deep link; bare code exchange; EU bot detection documented.
- [ ] **Milestone 2 — real robot**: run against a real EU and a real US
      account (see "To check"); turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: room cleaning (`Areas_To_Clean`, the room list
      encoding of sharkiq), mopping modes, recharge and resume, firmware and
      RSSI as params, a scene trigger on a new error.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real account

- EU: does the Auth0 password grant still pass the bot detection
  (`requires_verification`)? sharkiq 1.5.1 uses it for EU; the US switched to
  the cross-origin flow for that reason. If it does not, the EU sign-in has no
  way around it (documented in the Limits of the docs).
- EU User-Agent: sharkiq's EU grant goes through auth0-python, which sends
  its own User-Agent ("Python/3.x") and an `Auth0-Client` header; here the
  desktop browser one is sent. Which one the bot detection prefers is
  unknown.
- US code exchange (`POST /oauth/token`, authorization_code): sent with only
  `Content-Type` (and its length), no cookie, no Origin, as auth0.py does;
  check that Auth0 accepts it so.
- US: the consent page form (`name="state"`), the redirects, the cookies
  needed, the code in the deep link.
- Ayla: `expires_in` (about 86400 s?), the refresh token lifetime and
  whether it rotates, the 401 body of a refused refresh.
- The property names really listed: `GET_Operating_Mode`, `GET_Power_Mode`,
  `GET_Battery_Capacity`, `GET_Charging_Status`, `GET_DockedStatus` (or a
  plain `DockedStatus`?), `GET_Error_Code`, `SET_Find_Device`; values of
  `Charging_Status` while cleaning (recharge and resume); how fast
  `GET_Operating_Mode` follows a `SET_` datapoint.
- What a robot does with RETURN when already docked, PAUSE when stopped (the
  integration skips both), and with a datapoint while offline.
- Rate limits: none documented; a 429 may come.

## Decisions

- **Not a duplicate** (lot 7, 2026-10-18): no Shark service in the Gladys
  core, none in the integration store; reserved in post 262 of the forum
  thread 10385.
- **Reference reused: sharkiq 1.5.1** (MIT, sharkiqlibs, the library of the
  Home Assistant integration), cloned read-only in `_ref/sharkiq` (tag
  v1.5.1). Ported, credited in the README and `THIRD_PARTY_NOTICES.md` (full
  MIT notice, copied into the image). Only runtime dependency: the SDK.
- **Neighbour modules**: LM1LC3N7/gladys-bosch-indego (cloud robot, the
  vacuum-cleaner category), gladys-edilkamin (persisted stops and pauses,
  publisher, command safety), and callemand/gladys-roborock (a robot vacuum
  of the store) for the core categories.
- **The core has a dedicated category**: `vacuum-cleaner` (Matter, core
  4.79+), types `state`, `run-mode`, `clean-mode`, `dock`. Used: `state`
  (read only) and `clean-mode` (the suction select). Not used: `run-mode`
  and `dock` (the brief: commands as buttons, never a switch or a binary;
  `dock` is a binary command).
- **Suction power = `vacuum-cleaner/clean-mode`** with three of its values
  labelled Eco (quiet, 2), Normal (auto, 0), Max (deep clean, 4), as
  gladys-roborock labels its suction levels on that type; a `text/select`
  was the alternative, but the core keeps enum-like capabilities on their own
  integer type. Values from Gladys are strict (0, 2, 4 only).
- **No switch** (lot 6 lesson): five `button/push` features (value 1 only).
  An "everything on/off" of a scene, Google Home, Alexa, HomeKit or MCP never
  starts or stops a robot.
- **The password only on a click** (brief, lot 6 lesson "jamais de code sans
  clic"): one sign-in per saved credentials (`signIn` in `/data`, set when the
  account hash is new or the credentials changed), then only "Sign in to
  Shark". The test button never uses it. Lost tokens for credentials already
  used = "session expired", no sign-in. A refused refresh token is never
  retried and ends the same way.
- **Stops never lifted by themselves**: refused, verification
  (`requires_verification`, `mfa_required`), locked (`too_many_attempts`,
  `blocked_user`), unsupported (any unknown sign-in answer), interrupted,
  incomplete, unreadable /data (`store`, in memory only), session expired.
  Unlike edilkamin, no spaced retry for a refused password: each attempt
  counts against the Auth0 lockout. A reconnection to Gladys never lifts
  them.
- **The allowance is used up before the password leaves** (review B1: the
  first version sent it again after each 5xx, timeout or 429, 27 times in
  6 h): `signIn: false` and a provisional "interrupted" stop are saved to
  /data with a save that must succeed (else nothing is sent, "store" stop).
  Only a failure proved to come before the send, on the first Auth0
  request (ENOTFOUND, EAI_AGAIN, ECONNREFUSED, ENETUNREACH, EHOSTUNREACH: no
  byte left), gives the allowance back, twice at most (`preSend`, kept in
  /data, reset by a success, a click or new credentials). A 429 or 5xx of
  Auth0, a timeout, ECONNRESET or any other failure is the "interrupted"
  stop (a 429 also pauses). A failure after Auth0 accepted the password (a
  US step after the login ticket, a 200 without an id token, the Ayla
  exchange) is "incomplete" ("connexion inachevée", never "mot de passe
  refusé", review M1).
- **Id token kept for the Ayla exchange only**: in memory, never written. A
  network error, timeout, 5xx or 429 of token_sign_in is tried again on the
  next runs (the backoff spaces them), three attempts in all, then
  "incomplete". While it waits, /data holds the "incomplete" stop, so a
  restart never signs in by itself.
- **No configuration event before the first connection** (review I1):
  `configUpdated` is ignored until `connected` (which reads `getConfig()`);
  taken earlier, it looked like new credentials and lifted a persisted stop.
- **/data unreadable** (review I2): `load()` returns null only for ENOENT;
  EACCES, a corrupt file or any other failure is a `StoreError`: no sign-in
  by itself, no write (the file is left as it is), status "état /data
  illisible", the "Sign in" click replaces it.
- **One Auth0 flow per sign-in**: sharkiq retries a failed flow with the
  password grant at once; here never (each try is an attempt). The US code
  exchange sends only its Content-Type, as auth0.py (review M5).
- **EU = the direct password grant** (review I3): the Auth0 bot detection
  (`requires_verification`, CAPTCHA) may refuse it with no way around it;
  sharkiq left this flow in the US for that reason. Said in the manifest, the
  docs (Limits), the README and the changelog.
- **Region select** (default Europe): EU = password grant (as sharkiq with
  `europe=True`), US = cross-origin flow. A region change is new credentials.
- **Short tokens** (review I4): the margin is min(10 min, lifetime / 2) (the
  lifetime is kept with the tokens), also as the validity a read asks for; a
  300 s token is renewed every 150 s, not at every call. Two renewals are at
  least 1 min apart on every path (timer, read, 401, command): inside that
  minute the current token is used, or the call fails as `unauthorized`.
- **Exact deep link** (review M2): the code is read only from a Location
  that is exactly the app's redirect URI followed by `?` (or nothing); a
  look-alike scheme, host, path or another host ends the sign-in.
- **EU User-Agent** (review M3): the comment no longer says it copies
  sharkiq: auth0-python sends its own; kept the browser one, to check.
- **Logs** (review M4): the error of a feature that cannot be set shows the
  last 4 characters of the DSN only.
- **Renewal by a timer** 10 min before expiry (sharkiq's 600 s); failures
  retried after 1, 5, 15, 60 min; an Auth0/Ayla-login 429 delays it, an API
  429 does not. Commands need a token valid 60 s more (no renewal inside the
  3.5 s).
- **Commands** (lesson "les commandes décident sur un état relu"): start,
  pause, dock and suction read `properties.json` within the deadline (2.5 s
  at most), never decide on memory, refuse without the operating mode.
  "Already done" (start while cleaning, pause when not cleaning nor
  returning, dock when returning or docked/charging and not cleaning,
  suction equal) sends nothing, unless a different order left in the last
  60 s (lot 3 lesson: the start state may still show). Stop and locate decide
  nothing and read nothing (more of the budget left).
- **Stop never queued** (lot 6 lesson): it waits only for a start request in
  flight (until its own deadline), and a start that settles after a stop left
  is followed by a second stop. Stop, pause and dock are counted at their
  arrival; a start compares the count before its read, after it and right
  before sending.
- **Never after the failure shown**: every command is refused unless it
  leaves 3.4 s after its arrival at the latest (answer by 4.6 s); a timeout,
  a network error or a 5xx on a datapoint is "sent, without a confirmation"
  (never "not sent") with reads at 5, 15 and 45 s.
- **429 for every path** (wave 2 lesson): reads, renewals from the login
  service, buttons and every command, stop included (unlike edilkamin's turn
  off: a vacuum stop is not a safety stop). 60 s to 6 h, Retry-After or
  5 min, kept in `/data`, capped when read back. **5xx**: the reads back off
  1–15 min, kept in `/data` (capped at 15 min); commands still go (a single
  click, refused by the cloud if it is down).
- **State mapping** (as the Home Assistant integration): an error code > 0 is
  ERROR; START/EXPLORE/MOP/VACUUM_AND_MOP RUNNING; PAUSE PAUSED; RETURN
  RETURNING; otherwise CHARGING, DOCKED or STOPPED from `Charging_Status` /
  `DockedStatus`. `GET_` values win over `SET_` (sharkiq keeps whichever comes
  last); the operating mode is never read from an order, the suction power
  may be when no `GET_` exists.
- **Units**: `percent` on the battery, the only one the core lists for the
  battery category; the other features carry none.
- **External id**: the Ayla DSN (`[A-Za-z0-9_-]{1,40}`), stable for the robot;
  device name from `product_name` (the name in the app). Every robot gets the
  same nine features, so a republished device never loses one.
- **Tokens in /data** (`/data/sharkiq-state.json`, 0600): a hash of region and
  e-mail, never the e-mail nor the password; the refresh token gives control
  of the robots (said in the docs). The password field is kept by Gladys in
  its database (in clear), never shown again.
- **App constants**: the Auth0 clients and the Ayla app ids and secrets of the
  SharkClean app are in `src/constants.js`, as in sharkiq: public constants
  of the app, not secrets of the user; never logged.
- **User-Agents** as sharkiq (a browser UA): the SharkNinja Auth0 tenant runs
  a bot detection.
- **Logs**: never a password, token, e-mail, app secret or whole DSN (last 4
  characters); Auth0 errors keep only a checked `error` code, never
  `error_description`.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the one-time exception (the template's
  1.0.0 had to be replaced); the first patch release gives 0.1.1.
- **LICENSE**: the standard Apache-2.0 text, no personal name.
