# NHS + Private Pension Retirement Modeller

A client-side retirement income calculator for NHS pension members, combining the legacy 1995/2008 Section, the 2015 CARE scheme, and private pensions/savings (SIPP, LISA, S&S ISA, AVC, GIA) into combined income projections at different retirement ages.

Live app: https://mhowes12345.github.io/nhs-pension-planner/

**This is a projection tool, not financial advice.** Figures are based on the assumptions you enter — see the Assumptions & Sources section in the app for defaults and sources. Speak to a regulated financial adviser before making retirement decisions.

## Stack

Plain HTML/CSS/JS — no framework, no build step, no backend. `index.html` loads `src/calcEngine.js` and `src/app.js` directly. All calculation happens in the browser; nothing is sent to a server.

## Running locally

```
node serve.js
```

Serves the app at http://localhost:5588/.

## Running tests

```
npm test
```

Validates `src/calcEngine.js` against exact numeric ground truth extracted from the source spreadsheet (via Excel COM automation) for three scenarios: the default case, an edge case exercising less-common inputs, and a deferred NHS pension claim age scenario. See `test/calcEngine.test.js`.
