# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below. The ported parts were rewritten
in JavaScript; they are changed from the original (another language, another
structure, only what this integration needs). None of the original code is
copied as is.

## sharkiq

- Project: [sharkiqlibs/sharkiq](https://github.com/sharkiqlibs/sharkiq),
  version 1.5.1, the Python library for the Shark IQ robots (Shark cloud:
  SharkNinja Auth0 and Ayla Networks), the one the Home Assistant Shark IQ
  integration uses.
- What is ported (in `src/constants.js`, `src/auth0.js`, `src/ayla.js` and
  `src/model.js`): the Auth0 domains, clients, scopes and redirect of each
  region, the Ayla hosts, app ids and app secrets of each region, the EU
  password grant and the US cross-origin sign-in (login ticket, `/authorize`
  with PKCE, consent page, code exchange), the Ayla `token_sign_in` and
  refresh, the device list, the property list and its `GET_`/`SET_` names,
  the datapoint command, the operating modes, the power modes, the property
  names used (operating mode, power mode, battery, charging, docked, error,
  find device) and the error messages.
- Licence: MIT. Its full notice:

```text
MIT License

Copyright (c) 2022 sharkiqlibs maintainers, & original authors of https://github.com/ajmarks/sharkiq/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Shark, Shark IQ and SharkClean are trademarks of SharkNinja; Ayla Networks is
a trademark of its owner. This project is not affiliated with them.
