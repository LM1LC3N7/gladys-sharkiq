# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It brings the Shark robot vacuums into Gladys through the Shark cloud
(SharkNinja Auth0 + Ayla Networks, unofficial API, ported from sharkiq 1.5.1,
MIT). Read `TODO.md` "Decisions" before touching the sign-in (the password
only on a click, stops never lifted by themselves) or a command (no switch, a
fresh read before acting, the 3.5 s deadline, stop never queued).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   the SDK handlers -> SharkApp (shared with the tests)
src/app.js                        SharkApp: sign-in rules, polling, stops/pauses, commands
src/ayla.js                       Ayla: token_sign_in, refresh, devices, properties, datapoints
src/auth0.js                      SharkNinja Auth0: EU password grant, US cross-origin flow
src/model.js                      Ayla properties -> robots, Gladys state (pure)
src/devices.js                    -> Gladys devices and states (pure)
src/store.js                      /data: tokens, sign-in allowance, pauses, stops
src/publisher.js                  states within the Gladys limits
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys + a fake Shark cloud
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here the Ayla DSN), never a label. The same goes
  for every key users store: manifest `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`. Never log
  tokens, passwords, e-mails, app secrets or whole serial numbers. A `secret`
  field is kept in clear by Gladys, in its database and its backups: say so.
- **The password only on a click.** Never add an automatic sign-in with the
  password (Auth0 lockout, verification codes).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French), docs kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
