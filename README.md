# NHS + Private Pension Retirement Modeller

A client-side retirement income calculator for NHS pension members, combining the legacy 1995/2008 Section, the 2015 CARE scheme, and private pensions/savings (SIPP, LISA, S&S ISA, AVC, GIA) into combined income projections at different retirement ages.

Opens as a **guided flow**: three inputs (date of birth, pensionable pay, and the pension figure from your NHS statement) produce immediate headline projections — the three retirement-age scenarios, pinned at the top and minimised to just their totals — then a short question-by-question flow collects further figures only where they apply, with "Where do I find this?" pointers to the exact lines on your Total Reward Statement / NHSBSA estimate. Completing (or skipping out of) the flow reveals the full form with every input and assumption editable, plus the fully expanded results.

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

Validates `src/calcEngine.js` against exact numeric ground truth extracted from the source spreadsheet (via Excel COM automation) for four scenarios: the default case, an edge case exercising less-common inputs, a deferred NHS pension claim age scenario, and a Bridge-drawdown-before-SPA scenario. See `test/calcEngine.test.js`.

`test/guidedFlow.test.js` additionally checks the guided-onboarding layer: the three-input quick start with all HTML defaults must produce a valid projection (no NaN/undefined/silent zeroes), and every field/container the wizard reveals must actually exist in the form.
