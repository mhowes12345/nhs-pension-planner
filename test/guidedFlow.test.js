// Regression checks for the guided-onboarding layer (steps 2-6 of the rework brief):
//
// 1. Quick-start validity — the three-input quick start, with every other field left
//    at its HTML default, must produce a fully valid projection: no NaN, no undefined,
//    no silent zeroes in figures that should have values. The defaults are parsed
//    straight out of index.html (not duplicated here), so if someone changes a default
//    to something the engine can't digest, this fails.
//
// 2. Guided-layer integrity — every field name in app.js's GUIDED_QUICKSTART_FIELDS /
//    revealFields lists, and every container id in revealContainers, must exist in
//    index.html (or the old-pension template in app.js). Renaming a form field without
//    updating the wizard would otherwise silently stop it being revealed — the guided
//    flow would still "work" while quietly dropping capability.
//
// Guided-vs-advanced output parity needs no runtime check by construction: both modes
// read the literal same <form> through the same readInputs(), so identical underlying
// state cannot produce different outputs. What CAN drift is the reveal wiring, which
// is exactly what check 2 pins down.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runModel } = require('../src/calcEngine.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

// ---- parse the form's default values out of index.html -----------------------

function htmlInputDefaults() {
  const defaults = {};
  const inputRe = /<input[^>]*name="([\w]+)"[^>]*value="([^"]*)"[^>]*>/g;
  let m;
  while ((m = inputRe.exec(html)) !== null) defaults[m[1]] = m[2];
  return defaults;
}

// Selects: the option carrying `selected` is the default.
function htmlSelectDefaults() {
  const defaults = {};
  const selectRe = /<select name="([\w]+)">([\s\S]*?)<\/select>/g;
  let m;
  while ((m = selectRe.exec(html)) !== null) {
    const sel = /<option value="([^"]*)" selected>/.exec(m[2]);
    if (sel) defaults[m[1]] = sel[1];
  }
  return defaults;
}

// Mirrors readInputs() in app.js: which fields are percentages (entered as 4.5,
// consumed as 0.045), yes/no selects, or strings.
const PCT_FIELDS = new Set([
  'legacyRealGrowthRate', 'payRealGrowthRate', 'careRevaluationRealRate',
  'sippGrowthRate', 'lisaGrowthRate', 'isaGrowthRate', 'avcGrowthRate',
  'earlyRetirementReductionRate', 'giaGrowthRateGross', 'targetSavingsGrowthRate',
]);
const STR_FIELDS = new Set(['dateOfBirth', 'drawdownStrategy', 'householdType']);
const YESNO_FIELDS = new Set(['legacyContinuousService', 'isHighEarner']);
const GIA_TAX_DRAG = { Basic: 0.005, Higher: 0.01, Additional: 0.011, None: 0 };

function buildInputsFromDefaults(overrides = {}) {
  const raw = { ...htmlInputDefaults(), ...htmlSelectDefaults(), ...overrides };
  const inputs = {};
  Object.entries(raw).forEach(([name, value]) => {
    if (STR_FIELDS.has(name)) inputs[name] = value;
    else if (YESNO_FIELDS.has(name)) inputs[name] = value === 'Yes';
    else if (PCT_FIELDS.has(name)) inputs[name] = (parseFloat(value) || 0) / 100;
    else inputs[name] = parseFloat(value) || 0;
  });
  inputs.giaTaxDrag = GIA_TAX_DRAG[raw.marginalTaxBand] ?? 0;
  inputs.sippAccessAge = 57;
  inputs.lisaAccessAge = 60;
  // Old-pension rows are injected by app.js at runtime; their defaults are Blank/inert.
  inputs.oldPensions = [1, 2, 3].map(() => ({
    type: 'Blank', dbAmount: 0, dbAge: 65, dcBalance: 0, dcGrowthRate: 0.045, dcAccessAge: 57,
  }));
  inputs.scenarios = [
    { retirementAge: inputs.scenarioAAge, nhsClaimAge: inputs.scenarioAClaimAge },
    { retirementAge: inputs.scenarioBAge, nhsClaimAge: inputs.scenarioBClaimAge },
    { retirementAge: inputs.scenarioCAge, nhsClaimAge: inputs.scenarioCClaimAge },
  ];
  return inputs;
}

function assertFiniteDeep(value, label) {
  if (value === null) return; // engine uses null for legitimately-unavailable values
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${label} should be a finite number, got ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertFiniteDeep(v, `${label}[${i}]`));
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      assert.notEqual(v, undefined, `${label}.${k} should not be undefined`);
      assertFiniteDeep(v, `${label}.${k}`);
    });
  }
}

test('three-input quick start with all defaults produces a valid projection', (t) => {
  // The three quick-start entries a first-time user makes; everything else defaulted.
  const inputs = buildInputsFromDefaults({
    currentPensionablePay: '95000',
    carePotLastStatement: '25000',
    carePotStatementTaxYearEnd: '2024',
  });
  // The guided headline runs the same engine with a 2-entry scenario list
  // (retire = claim at each derived age) — replicate that shape here too.
  const headlineInputs = {
    ...inputs,
    scenarios: [
      { retirementAge: 55, nhsClaimAge: 55 },
      { retirementAge: 68, nhsClaimAge: 68 },
    ],
  };

  for (const [label, inp] of [['default 3-scenario', inputs], ['headline 2-scenario', headlineInputs]]) {
    const model = runModel(inp, new Date('2026-07-17'));

    assertFiniteDeep(model.personal, `${label}: personal`);
    assertFiniteDeep(model.scenarioSummary, `${label}: scenarioSummary`);
    assertFiniteDeep(model.care.years, `${label}: care.years`);
    assertFiniteDeep(model.privatePensions.years, `${label}: privatePensions.years`);
    assertFiniteDeep(model.annualAllowance, `${label}: annualAllowance`);
    assertFiniteDeep(model.targetIncomeCalculator, `${label}: targetIncomeCalculator`);

    // No silent zeroes: with pay entered, the CARE pension and the totals must be
    // real positive numbers, and the State Pension must appear from SPA.
    model.scenarioSummary.scenarios.forEach((s) => {
      assert.ok(s.nhs2015AfterReduction > 0, `${label}: NHS 2015 pension should be > 0 at age ${s.retirementAge}`);
      assert.ok(s.totalIncomeFromClaimAge > 0, `${label}: total income should be > 0 at age ${s.retirementAge}`);
      assert.ok(
        s.totalIncomeFromStatePensionAge >= s.totalIncomeFromClaimAge,
        `${label}: from-SPA total should never be below the from-claim total at age ${s.retirementAge}`
      );
      if (s.nhsClaimAge >= s.statePensionAge) {
        assert.ok(s.statePension > 0, `${label}: State Pension should be included when claiming at ${s.nhsClaimAge} (SPA ${s.statePensionAge})`);
      }
    });
  }
});

test('wizard reveal lists reference only fields and containers that exist', (t) => {
  // Names available for revealing: every named field in index.html plus the
  // old-pension template fields injected by app.js.
  const available = new Set();
  const nameRe = /name="([\w$]+)"/g;
  let m;
  while ((m = nameRe.exec(html)) !== null) available.add(m[1]);
  // The old-pension template uses `oldPension${n}Xxx` — register the expanded names.
  const tmplRe = /name="oldPension\$\{n\}(\w+)"/g;
  while ((m = tmplRe.exec(appJs)) !== null) {
    [1, 2, 3].forEach((n) => available.add(`oldPension${n}${m[1]}`));
  }

  const listRe = /(GUIDED_QUICKSTART_FIELDS = |revealFields: )\[([^\]]*)\]/g;
  let checkedFields = 0;
  while ((m = listRe.exec(appJs)) !== null) {
    for (const nameMatch of m[2].matchAll(/'([\w]+)'/g)) {
      assert.ok(available.has(nameMatch[1]), `wizard references form field '${nameMatch[1]}' which does not exist in index.html`);
      checkedFields += 1;
    }
  }
  assert.ok(checkedFields >= 20, `expected to statically find at least 20 wizard field references, found ${checkedFields} — has the wizard definition moved?`);

  const containerRe = /revealContainers: \[([^\]]*)\]/g;
  let checkedContainers = 0;
  while ((m = containerRe.exec(appJs)) !== null) {
    for (const idMatch of m[1].matchAll(/'([\w]+)'/g)) {
      assert.ok(html.includes(`id="${idMatch[1]}"`), `wizard references container '#${idMatch[1]}' which does not exist in index.html`);
      checkedContainers += 1;
    }
  }
  assert.ok(checkedContainers >= 2, `expected at least 2 wizard container references, found ${checkedContainers}`);
});
