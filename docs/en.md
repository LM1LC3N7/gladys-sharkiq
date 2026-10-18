# Shark IQ

Unofficial integration, not affiliated with SharkNinja. It brings the **Shark
robot vacuums** of the **SharkClean** app into Gladys, through the Shark cloud
(the SharkNinja sign-in service and Ayla Networks), the one the app uses.

> **Warning: unofficial API, this integration has never been tested with a
> real robot or account.** It was written from the sharkiq library and tested
> against a fake Shark cloud only. SharkNinja may change its API at any time.
> Feedback is welcome.

## What you get

For each robot of the account:

| Feature            | Details                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| State              | Read only: cleaning, paused, returning, charging, docked, stopped, error. |
| Battery            | In %.                                                                     |
| Suction power      | A list: Eco, Normal, Max.                                                 |
| Error              | A text, for example "Brushroll stuck (4)" or "No error".                  |
| Start cleaning     | Button.                                                                   |
| Pause              | Button.                                                                   |
| Stop               | Button.                                                                   |
| Return to the dock | Button.                                                                   |
| Locate (beep)      | Button: the robot beeps.                                                  |

The badge of each robot shows "cloud", or "unreachable" (with an orange dot)
when the cloud says the robot is offline or it cannot be read.

## Installation

1. Your robots must work in the **SharkClean** app.
2. In Gladys, install the Shark IQ integration, choose the **region** of the
   account (Europe, or North America), enter the **e-mail** and the
   **password** of the SharkClean app, and save.
3. Add the robots from the **Discovery** tab.

## Signing in: never without your click

The SharkNinja sign-in service blocks an account after a few refused attempts,
and may ask for a verification (a code, a check against robots). So the
integration sends **the password only when you ask**:

- once when you save the e-mail and the password (or at the first start with
  them);
- then only when you click **Sign in to Shark**.

A refused password, a verification asked, a blocked account or an expired
session stop the integration, and the stop is kept across restarts: it never
tries again by itself. Fix what the status says (in the SharkClean app if
needed), then click **Sign in to Shark**. **Test the connection** reads the
robots with the current session and never uses the password.

Meanwhile, the session (about 24 hours) is renewed by a timer, 10 minutes
before it ends, with the refresh token: without the password.

## Password, tokens and privacy

- The password is **kept by Gladys in its database, never shown again, and
  sent only to the SharkNinja sign-in service** (Auth0), in the cases above.
- The Ayla tokens are kept in the `/data` volume of the integration so that a
  restart does not sign in again. On the Gladys host, this volume is the
  folder `<Gladys base folder>/external-integrations/<selector>`: readable by
  root and uid 1000 (the container user), not in the Gladys backups, removed
  when the integration is uninstalled. **The refresh token gives control of
  the robots** while it is valid: protect this host. The e-mail and the
  password are never written there.
- Nothing reaches the logs: no password, token, e-mail, nor whole serial
  number (its last 4 characters only).
- Everything goes over HTTPS to `logineu.sharkninja.com` (or
  `login.sharkninja.com`), then `user-field-eu.aylanetworks.com` and
  `ads-eu.aylanetworks.com` (or `user-sharkue1` and `ads-sharkue1` in North
  America).

## Commands

- **No switch**: the state is read only and the commands are buttons. An
  "everything on" or "everything off" of a scene or a voice assistant never
  starts nor stops a robot.
- Start, Pause, Return to the dock and the suction power **read the robot
  again** in the cloud right before acting: the command is refused when that
  read fails or lacks the mode of the robot. "Already done" sends nothing (a
  start on a cleaning robot, a pause on a docked one), unless another order
  just left (within a minute): the cloud may still show the state from
  before.
- Stop and Locate decide nothing: they leave without a read.
- The commands of one robot run one at a time. Stop never waits behind them,
  only behind a start already on its way, so it lands after it. A waiting
  start is cancelled when a stop, a pause or a return to the dock arrives
  meanwhile.
- A command that cannot leave within **3.5 seconds** of its arrival is
  refused: Gladys shows a failure after 5 seconds, and nothing leaves after
  that failure.
- When Shark does not confirm a command that left, Gladys shows "sent,
  without a confirmation": check the state of the robot, read again in the
  next seconds.

## Refresh and errors

- The robots are read every 60 seconds by default (30 to 900), one request
  per robot, plus the account list every 10 minutes and three reads in the
  minute after a command.
- **Shark asks to slow down** (HTTP 429): a pause of at least 1 minute
  (Retry-After when given, 6 h at most), for every path, commands included,
  kept across restarts.
- **Server error** (5xx): a pause of 1, 2, 5, 10 then 15 minutes, never
  shorter than the interval, kept across restarts.
- **Network**: new try after 1, 2, 5, 10 then every 15 minutes.
- An unreadable robot (404, error) marks only itself; the others are read.

## Limits

- Never tested with a real robot or account: the property names, their values
  and the sign-in come from sharkiq 1.5.1.
- The North American sign-in goes through an Auth0 consent page read
  automatically: if SharkNinja changes it, the sign-in fails (a stop, no new
  try).
- No room cleaning, no map, no mopping for now.

## Credits

- [sharkiq](https://github.com/sharkiqlibs/sharkiq) 1.5.1 (MIT): the sign-in,
  the Ayla API, the properties and the commands are ported to JavaScript. See
  `THIRD_PARTY_NOTICES.md`.

Shark, Shark IQ and SharkClean are trademarks of SharkNinja; this project is
not affiliated with SharkNinja.
