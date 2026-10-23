# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-18

### Added

- Shark robot vacuums through the Shark cloud (SharkNinja Auth0 and Ayla
  Networks, unofficial API ported from sharkiq 1.5.1), Europe and North
  America accounts.
- Sign-in with the e-mail and the password of the SharkClean app, used only
  when the user saves them or clicks "Sign in to Shark": a refused password,
  a verification, a blocked account or an expired session stops the
  integration without any new try by itself, across restarts.
- The Ayla token is renewed from the refresh token by a timer, 10 minutes
  before it expires; the tokens are kept in `/data` so a restart does not
  sign in again.
- Per robot: state (cleaning, paused, returning, charging, docked, stopped,
  error), battery, suction power (Eco, Normal, Max), error text.
- Start, Pause, Stop, Return to the dock and Locate buttons (no switch). Start,
  pause, dock and suction read the robot again just before acting; every
  command is refused when it cannot leave within 3.5 s; one command at a time
  per robot; a stop cancels a waiting start and lands after one in flight.
- The robots are read every 60 s (30 to 900); a 429 pauses every path,
  commands included, for 60 s to 6 h; a 5xx pauses the reads; both kept
  across restarts. One unreadable or offline robot only gets a degraded badge.
- "Sign in to Shark" and "Test the connection" buttons; the status and the
  Discovery list are sent again at each reconnection to Gladys.
- Feature names and texts in French or English.

### Fixed

- The password is never sent again by itself after a server error, a timeout
  or a "too many requests" of the sign-in: the allowance is used up and saved
  before it leaves, only a failure proved to come before the send is tried
  again (twice at most), and anything else is an "interrupted" or
  "unfinished" sign-in that waits for a click on "Sign in to Shark". After an
  accepted password, only the Ayla exchange is tried again, without the
  password.
- A configuration event before the first connection no longer lifts a stop;
  an unreadable `/data` stops the integration instead of signing in again.
- A short Ayla token is renewed at half its life, and two renewals are at
  least a minute apart.
- The US sign-in reads the code only from the exact link of the app, and its
  code exchange sends only its Content-Type.
- A "too many requests" during any step of the sign-in, after the password
  too, now pauses every path, the "Sign in to Shark" button included, for its
  Retry-After; when Shark stays unreachable before anything was sent, the
  status says so ("nothing was sent") and asks for a click to try again.
- The docs say the European sign-in is the direct Auth0 password grant, which
  the SharkNinja bot detection may refuse with no way around it.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sharkiq/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-sharkiq/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-sharkiq/releases/tag/v0.1.1
