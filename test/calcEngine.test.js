// Validates calcEngine.js against exact numeric ground truth pulled from the live
// spreadsheet via Excel COM automation (see scratchpad/dump_values.ps1,
// scratchpad/make_scenario2.ps1, scratchpad/make_deferred.ps1,
// scratchpad/make_bridge_expiry_test.ps1). Four cases are checked: the workbook's shipped
// base-case inputs, an edge-case scenario that exercises the paths the base case leaves at
// zero (legacy pensions, AP, AVC, GIA tax drag, DB+DC old pensions, AA taper, ERRBO), a
// deferred-claim scenario (Scenario B: retire at 60, claim the NHS pension at State Pension
// Age) that exercises the private-pot bridging logic, and a Bridge-drawdown-strategy
// scenario where the NHS pension is claimed before SPA — this exercises the fix for the
// ongoing drawdown (itself only sustainable until SPA under that strategy) being wrongly
// carried into the from-SPA-onwards total instead of dropping to zero there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runModel } = require('../src/calcEngine.js');

const TOL = 1e-6; // absolute tolerance in £ / ratio units

function approxEqual(actual, expected, label) {
  const diff = Math.abs((actual ?? NaN) - (expected ?? NaN));
  assert.ok(diff <= TOL, `${label}: expected ${expected}, got ${actual} (diff ${diff})`);
}

const gt1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground_truth.json'), 'utf8'));
const gt2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground_truth_2.json'), 'utf8'));
const gtDeferred = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground_truth_deferred.json'), 'utf8'));
const gtBridgeExpiry = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground_truth_bridge_expiry.json'), 'utf8'));

const ASOF_DATE = new Date(2026, 6, 9); // matches TODAY() at ground-truth extraction time

const defaultInputs = {
  dateOfBirth: '1982-03-15',
  currentTaxYearStart: 2026,
  estimatedStatePensionAnnual: 12547.6,

  legacy1995Pension: 0,
  legacy1995LumpSum: 0,
  legacy2008Pension: 0,
  legacy2008LumpSum: 0,
  legacyContinuousService: true,
  legacyRealGrowthRate: 0.015,

  carePotLastStatement: 18000,
  carePotStatementTaxYearEnd: 2024,
  currentPensionablePay: 80000,
  payRealGrowthRate: 0.01,
  careRevaluationRealRate: 0.015,
  careAccrualRateDenominator: 54,

  sippBalance: 40000,
  sippContribution: 6000,
  sippGrowthRate: 0.045,
  sippAccessAge: 57,

  lisaBalance: 15000,
  lisaContribution: 4000,
  lisaGrowthRate: 0.045,
  lisaAccessAge: 60,

  isaBalance: 25000,
  isaContribution: 8000,
  isaGrowthRate: 0.045,

  apPurchasedAnnual: 0,
  avcBalance: 0,
  avcContribution: 0,
  avcGrowthRate: 0.045,

  errboYearsBoughtOut: 0,
  earlyRetirementReductionRate: 0.05,

  giaBalance: 0,
  giaContribution: 0,
  giaGrowthRateGross: 0.045,
  giaTaxDrag: 0.005,

  oldPensions: [
    { type: 'Blank', dbAmount: 0, dbAge: 65, dcBalance: 0, dcGrowthRate: 0.045, dcAccessAge: 57 },
    { type: 'Blank', dbAmount: 0, dbAge: 65, dcBalance: 0, dcGrowthRate: 0.045, dcAccessAge: 57 },
    { type: 'Blank', dbAmount: 0, dbAge: 65, dcBalance: 0, dcGrowthRate: 0.045, dcAccessAge: 57 },
  ],

  standardAnnualAllowance: 60000,
  isHighEarner: false,
  adjustedIncome: 0,

  drawdownStrategy: '4% Safe Withdrawal (perpetual)',

  // claimAge defaults to retirementAge (no deferral) unless overridden.
  scenarios: [
    { retirementAge: 57, nhsClaimAge: 57 },
    { retirementAge: 60, nhsClaimAge: 60 },
    { retirementAge: 67, nhsClaimAge: 67 },
  ],

  targetIncome: 50000,
  targetAge: 60,
  targetSavingsGrowthRate: 0.045,

  householdType: 'One-person',
};

const scenario2Inputs = Object.assign({}, defaultInputs, {
  legacy1995Pension: 5000,
  legacy1995LumpSum: 1500,
  legacy2008Pension: 3000,
  legacy2008LumpSum: 0,
  apPurchasedAnnual: 2000,
  avcBalance: 10000,
  avcContribution: 1000,
  errboYearsBoughtOut: 2,
  giaBalance: 5000,
  giaContribution: 2000,
  giaTaxDrag: 0.01, // Higher (40%) band
  oldPensions: [
    { type: 'Defined Benefit', dbAmount: 4000, dbAge: 65, dcBalance: 0, dcGrowthRate: 0.045, dcAccessAge: 57 },
    { type: 'Defined Contribution', dbAmount: 0, dbAge: 65, dcBalance: 20000, dcGrowthRate: 0.04, dcAccessAge: 55 },
    { type: 'Blank', dbAmount: 0, dbAge: 65, dcBalance: 0, dcGrowthRate: 0.045, dcAccessAge: 57 },
  ],
  isHighEarner: true,
  adjustedIncome: 300000,
  drawdownStrategy: 'Bridge - deplete until State Pension Age',
});

// Scenario B deferred: retirement age unchanged (60), NHS claim age pushed out to State
// Pension Age (68 for this DOB) — see scratchpad/make_deferred.ps1.
const deferredInputs = Object.assign({}, defaultInputs, {
  scenarios: [
    { retirementAge: 57, nhsClaimAge: 57 },
    { retirementAge: 60, nhsClaimAge: 68 },
    { retirementAge: 67, nhsClaimAge: 67 },
  ],
});

// Bridge-to-SPA drawdown strategy + claiming the NHS pension immediately (below SPA) on
// Scenarios A and B — see scratchpad/make_bridge_expiry_test.ps1. Reproduces the reported
// bug: the ongoing drawdown row is a temporary elevated rate under this strategy (it drains
// the pot to zero by SPA) and must not be carried into the from-SPA-onwards total.
const bridgeExpiryInputs = Object.assign({}, defaultInputs, {
  currentPensionablePay: 90000,
  carePotLastStatement: 60000,
  sippBalance: 300000,
  sippContribution: 15000,
  isaBalance: 100000,
  isaContribution: 10000,
  drawdownStrategy: 'Bridge - deplete until State Pension Age',
  scenarios: [
    { retirementAge: 60, nhsClaimAge: 60 },
    { retirementAge: 60, nhsClaimAge: 60 },
    { retirementAge: 67, nhsClaimAge: 67 },
  ],
});

function validateAgainst(t, inputs, gt) {
  const model = runModel(inputs, ASOF_DATE);

  t.test('personal', () => {
    approxEqual(model.personal.currentAge, gt['Inputs']['B5'], 'Inputs!B5 current age');
    approxEqual(model.personal.statePensionAge, gt['Inputs']['B7'], 'Inputs!B7 state pension age');
  });

  t.test('legacy scheme', () => {
    approxEqual(model.legacy.totalPension, gt['Legacy Scheme']['B14'], 'Legacy Scheme!B14');
    approxEqual(model.legacy.totalLumpSum, gt['Legacy Scheme']['B15'], 'Legacy Scheme!B15');
  });

  t.test('2015 CARE Projection catch-up steps', () => {
    const careSheet = gt['2015 CARE Projection'];
    model.care.catchUpSteps.forEach((s, i) => {
      const row = 8 + i;
      approxEqual(s.potAtStart, careSheet[`C${row}`], `CARE catch-up step ${s.step} pot at start (C${row})`);
      approxEqual(s.extraAccrual, careSheet[`D${row}`], `CARE catch-up step ${s.step} extra accrual (D${row})`);
      approxEqual(s.potAfterStep, careSheet[`E${row}`], `CARE catch-up step ${s.step} pot after step (E${row})`);
    });
  });

  t.test('2015 CARE Projection main table', () => {
    const careSheet = gt['2015 CARE Projection'];
    model.care.years.forEach((y) => {
      const row = 18 + y.yearIndex;
      approxEqual(y.pensionablePay, careSheet[`D${row}`], `CARE year ${y.yearIndex} pensionable pay (D${row})`);
      approxEqual(y.accrualAdded, careSheet[`E${row}`], `CARE year ${y.yearIndex} accrual added (E${row})`);
      approxEqual(y.openingPotRevalued, careSheet[`F${row}`], `CARE year ${y.yearIndex} opening pot revalued (F${row})`);
      approxEqual(y.closingPot, careSheet[`G${row}`], `CARE year ${y.yearIndex} closing pot (G${row})`);
      approxEqual(y.pia, careSheet[`H${row}`], `CARE year ${y.yearIndex} PIA (H${row})`);
    });
  });

  t.test('Private Pensions Projection', () => {
    const privSheet = gt['Private Pensions Projection'];
    model.privatePensions.years.forEach((y) => {
      const row = 5 + y.yearIndex;
      approxEqual(y.sipp, privSheet[`D${row}`], `Private year ${y.yearIndex} SIPP (D${row})`);
      approxEqual(y.lisa, privSheet[`E${row}`], `Private year ${y.yearIndex} LISA (E${row})`);
      approxEqual(y.isa, privSheet[`F${row}`], `Private year ${y.yearIndex} ISA (F${row})`);
      approxEqual(y.avc, privSheet[`G${row}`], `Private year ${y.yearIndex} AVC (G${row})`);
      approxEqual(y.gia, privSheet[`H${row}`], `Private year ${y.yearIndex} GIA (H${row})`);
      approxEqual(y.combinedTotal, privSheet[`I${row}`], `Private year ${y.yearIndex} combined total (I${row})`);
    });
  });

  t.test('Annual Allowance Check', () => {
    const aaSheet = gt['Annual Allowance Check'];
    model.annualAllowance.forEach((y) => {
      const row = 6 + y.yearIndex;
      approxEqual(y.totalPensionInput, aaSheet[`D${row}`], `AA year ${y.yearIndex} total pension input (D${row})`);
      approxEqual(y.allowance, aaSheet[`E${row}`], `AA year ${y.yearIndex} allowance (E${row})`);
      assert.strictEqual(y.withinAA, aaSheet[`F${row}`] === 'Yes', `AA year ${y.yearIndex} within AA (F${row})`);
    });
  });

  t.test('Scenario Summary', () => {
    const ss = gt['Scenario Summary'];
    const cols = ['B', 'C', 'D'];
    model.scenarioSummary.scenarios.forEach((s, i) => {
      const col = cols[i];
      approxEqual(s.bridgeYears, ss[`${col}6`], `Scenario ${col} bridge years (${col}6)`);
      approxEqual(s.nhs2015BeforeReduction, ss[`${col}7`], `Scenario ${col} NHS2015 before reduction (${col}7)`);
      approxEqual(s.reductionFactor, ss[`${col}8`], `Scenario ${col} reduction factor (${col}8)`);
      approxEqual(s.nhs2015AfterReduction, ss[`${col}9`], `Scenario ${col} NHS2015 after reduction (${col}9)`);
      approxEqual(s.legacyPension, ss[`${col}10`], `Scenario ${col} legacy pension (${col}10)`);
      approxEqual(s.legacyLumpSum, ss[`${col}11`], `Scenario ${col} legacy lump sum (${col}11)`);
      approxEqual(s.statePension, ss[`${col}12`], `Scenario ${col} state pension (${col}12)`);
      approxEqual(s.privatePot, ss[`${col}13`], `Scenario ${col} private pot at retirement (${col}13)`);
      approxEqual(s.bridgeIncome, ss[`${col}14`], `Scenario ${col} bridge income (${col}14)`);
      approxEqual(s.privatePotRemaining, ss[`${col}15`], `Scenario ${col} private pot remaining (${col}15)`);
      approxEqual(s.drawdown, ss[`${col}16`], `Scenario ${col} ongoing drawdown (${col}16)`);
      approxEqual(s.oldPensionsIncome, ss[`${col}17`], `Scenario ${col} old pensions income (${col}17)`);
      approxEqual(s.totalIncomeFromClaimAge, ss[`${col}19`], `Scenario ${col} TOTAL income from claim age (${col}19)`);
      approxEqual(s.lumpSum, ss[`${col}21`], `Scenario ${col} lump sum (${col}21)`);
    });
  });

  // Once a scenario reaches State Pension Age, the State Pension should be added on top of
  // the claim-age total (rather than silently missing from every year after SPA too) --
  // but if claiming before SPA under the 'Bridge to SPA' drawdown strategy, the ongoing
  // drawdown itself is only sustainable until SPA, so it must NOT be carried forward too.
  t.test('State Pension Age phase', () => {
    const ss = gt['Scenario Summary'];
    const cols = ['B', 'C', 'D'];
    model.scenarioSummary.scenarios.forEach((s, i) => {
      const col = cols[i];
      assert.strictEqual(s.statePensionAge, model.personal.statePensionAge, `Scenario ${col} statePensionAge`);
      assert.strictEqual(
        s.statePensionIncludedFromClaimAge,
        s.nhsClaimAge >= model.personal.statePensionAge,
        `Scenario ${col} statePensionIncludedFromClaimAge`
      );
      const expectedDrawdownExpires =
        !s.statePensionIncludedFromClaimAge && inputs.drawdownStrategy !== '4% Safe Withdrawal (perpetual)' && (s.drawdown ?? 0) > 0;
      assert.strictEqual(s.drawdownExpiresAtSpa, expectedDrawdownExpires, `Scenario ${col} drawdownExpiresAtSpa`);

      // Real spreadsheet ground truth (Scenario Summary row 23) rather than just internal
      // consistency, now that every fixture includes it.
      approxEqual(s.totalIncomeFromStatePensionAge, ss[`${col}23`], `Scenario ${col} totalIncomeFromStatePensionAge (${col}23)`);

      if (s.statePensionIncludedFromClaimAge) {
        approxEqual(s.totalIncomeFromStatePensionAge, s.totalIncomeFromClaimAge, `Scenario ${col} totalIncomeFromStatePensionAge (already included)`);
      } else {
        approxEqual(
          s.totalIncomeFromStatePensionAge,
          s.totalIncomeFromClaimAge + inputs.estimatedStatePensionAnnual - (s.drawdownExpiresAtSpa ? s.drawdown : 0),
          `Scenario ${col} totalIncomeFromStatePensionAge (State Pension added, expired drawdown removed)`
        );
      }
    });
  });

  t.test('Target Income Calculator', () => {
    const tic = gt['Target Income Calculator'];
    const targ = model.targetIncomeCalculator;
    approxEqual(targ.guaranteedIncome, tic['B15'], 'Target!B15 total guaranteed income');
    approxEqual(targ.incomeGap, tic['B18'], 'Target!B18 income gap');
    approxEqual(targ.potNeeded, tic['B19'], 'Target!B19 pot needed');
    approxEqual(targ.projectedPot, tic['B20'], 'Target!B20 projected pot');
    approxEqual(targ.shortfall, tic['B21'], 'Target!B21 shortfall');
    approxEqual(targ.yearsToSave, tic['B22'], 'Target!B22 years to save');
    const cols = ['B', 'C', 'D'];
    targ.scenarios.forEach((s, i) => {
      const col = cols[i];
      approxEqual(s.rate, tic[`${col}26`], `Target!${col}26 rate (${s.label})`);
      approxEqual(s.extraAnnualSavingNeeded, tic[`${col}27`], `Target!${col}27 extra saving needed (${s.label})`);
    });
  });

  t.test('Retirement Living Standards', () => {
    const rls = gt['Retirement Living Standards'];
    const cols = ['B', 'C', 'D'];
    model.retirementLivingStandards.scenarios.forEach((s, i) => {
      const col = cols[i];
      approxEqual(s.totalIncomeFromClaimAge, rls[`${col}16`], `RLS!${col}16 income`);
      assert.strictEqual(s.nearestStandard, rls[`${col}17`], `RLS!${col}17 nearest standard`);
    });
  });
}

test('base case matches spreadsheet ground truth', (t) => {
  validateAgainst(t, defaultInputs, gt1);
});

test('edge-case scenario matches spreadsheet ground truth', (t) => {
  validateAgainst(t, scenario2Inputs, gt2);
});

test('deferred claim age (Scenario B: retire 60, claim at SPA) matches spreadsheet ground truth', (t) => {
  validateAgainst(t, deferredInputs, gtDeferred);

  // Extra sanity checks specific to the bridging mechanics on the deferred scenario.
  const model = runModel(deferredInputs, ASOF_DATE);
  const [a, b, c] = model.scenarioSummary.scenarios;
  assert.strictEqual(a.bridgeYears, 0, 'Scenario A: no deferral');
  assert.strictEqual(b.bridgeYears, 8, 'Scenario B: 8-year bridge (60 -> 68)');
  assert.strictEqual(c.bridgeYears, 0, 'Scenario C: no deferral');
  assert.strictEqual(b.privatePotRemaining, 0, 'Scenario B: pot fully used bridging to claim age');
  assert.strictEqual(b.drawdown, 0, 'Scenario B: nothing left for ongoing drawdown');
  assert.ok(b.bridgeIncome > 0, 'Scenario B: bridge income should be positive');
});

test('Bridge drawdown strategy claimed before SPA matches spreadsheet ground truth', (t) => {
  validateAgainst(t, bridgeExpiryInputs, gtBridgeExpiry);

  // Extra sanity checks specific to the reported bug: the claim-age total includes a huge
  // temporary drawdown that must not survive into the from-SPA-onwards total.
  const model = runModel(bridgeExpiryInputs, ASOF_DATE);
  const [a] = model.scenarioSummary.scenarios;
  assert.strictEqual(a.bridgeYears, 0, 'Scenario A: no deferral gap (claims immediately at 60)');
  assert.ok(a.drawdown > 100000, 'Scenario A: ongoing drawdown should be the large temporary Bridge-strategy figure');
  assert.strictEqual(a.drawdownExpiresAtSpa, true, 'Scenario A: drawdown is flagged as expiring at SPA');
  assert.ok(
    a.totalIncomeFromStatePensionAge < a.totalIncomeFromClaimAge,
    'Scenario A: income from SPA onwards should be LOWER than the temporary claim-age total, not higher'
  );
});
