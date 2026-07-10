// NHS + Private Pension Retirement Modeller — calculation engine.
// Pure functions, mirroring the sheets/formulas in nhs_pension_planner_model_2.xlsx 1:1.
// No UI, no I/O — call runModel(inputs, asOfDate) and read the returned object.
// UMD wrapper: works as a plain <script> (window.CalcEngine) or a CommonJS module.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CalcEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

const PROJECTION_YEARS = 35; // Year 0..34, matches the fixed row count in both projection tabs
const CATCH_UP_STEPS = 6; // fixed catch-up rows in the '2015 CARE Projection' tab

// ---- date / age helpers -----------------------------------------------

// Excel DATEDIF(start, end, "y"): whole years elapsed, only counting a year
// once the end date has passed the start date's month/day in that year.
function datedifYears(startDate, endDate) {
  let years = endDate.getFullYear() - startDate.getFullYear();
  const anniversary = new Date(endDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  if (endDate < anniversary) years -= 1;
  return years;
}

function statePensionAge(dob) {
  if (dob < new Date(1960, 3, 6)) return 66;
  if (dob < new Date(1961, 2, 6)) return 67; // transitional band, simplified to 67 (matches workbook)
  if (dob < new Date(1977, 3, 6)) return 67;
  return 68;
}

function calcPersonal(inputs, asOfDate) {
  const dob = new Date(inputs.dateOfBirth);
  const currentAge = datedifYears(dob, asOfDate);
  return {
    currentAge,
    statePensionAge: statePensionAge(dob),
  };
}

// ---- Legacy Scheme (1995/2008 Section) — static, direct from TRS/ABS --

function calcLegacyScheme(inputs) {
  const section1995 = { pension: inputs.legacy1995Pension, lumpSum: inputs.legacy1995LumpSum };
  const section2008 = { pension: inputs.legacy2008Pension, lumpSum: inputs.legacy2008LumpSum };
  return {
    section1995,
    section2008,
    totalPension: section1995.pension + section2008.pension,
    totalLumpSum: section1995.lumpSum + section2008.lumpSum,
  };
}

// ---- 2015 CARE Projection ----------------------------------------------

function calcCareProjection(inputs, currentAge) {
  const { carePotLastStatement, carePotStatementTaxYearEnd, currentTaxYearStart,
    currentPensionablePay, payRealGrowthRate, careRevaluationRealRate, careAccrualRateDenominator } = inputs;

  // Catch-up steps: bring an out-of-date TRS/ABS pot up to date using current pay
  // as a stand-in for the missing years' pay, before the main projection starts.
  const yearsOutOfDate = Math.max(0, currentTaxYearStart - carePotStatementTaxYearEnd - 1);
  const catchUpSteps = [];
  let pot = carePotLastStatement;
  for (let step = 1; step <= CATCH_UP_STEPS; step++) {
    const potAtStart = pot;
    const applies = step <= yearsOutOfDate;
    const extraAccrual = applies ? currentPensionablePay / careAccrualRateDenominator : 0;
    const potAfterStep = applies ? potAtStart * (1 + careRevaluationRealRate) + extraAccrual : potAtStart;
    catchUpSteps.push({
      step,
      taxYear: carePotStatementTaxYearEnd + step,
      potAtStart,
      extraAccrual,
      potAfterStep,
    });
    pot = potAfterStep;
  }
  const potAfterCatchUp = pot;

  // Main year-by-year projection, Year 0..34
  const years = [];
  let pensionablePay = currentPensionablePay;
  let openingPotRevalued = potAfterCatchUp * (1 + careRevaluationRealRate);
  let closingPot = openingPotRevalued + pensionablePay / careAccrualRateDenominator;

  for (let n = 0; n < PROJECTION_YEARS; n++) {
    if (n > 0) {
      pensionablePay = years[n - 1].pensionablePay * (1 + payRealGrowthRate);
      openingPotRevalued = years[n - 1].closingPot * (1 + careRevaluationRealRate);
      closingPot = openingPotRevalued + pensionablePay / careAccrualRateDenominator;
    }
    const accrualAdded = pensionablePay / careAccrualRateDenominator;
    years.push({
      yearIndex: n,
      taxYear: currentTaxYearStart + n,
      age: currentAge + n,
      pensionablePay,
      accrualAdded,
      openingPotRevalued,
      closingPot,
      pia: accrualAdded * 16,
    });
  }

  return { catchUpSteps, years };
}

// ---- Private Pensions & Savings Projection -----------------------------

function calcPrivatePensionsProjection(inputs, currentAge) {
  const {
    currentTaxYearStart,
    sippBalance, sippContribution, sippGrowthRate,
    lisaBalance, lisaContribution, lisaGrowthRate,
    isaBalance, isaContribution, isaGrowthRate,
    avcBalance, avcContribution, avcGrowthRate,
    giaBalance, giaContribution, giaGrowthRateGross, giaTaxDrag,
  } = inputs;

  const years = [];
  let sipp = sippBalance, lisa = lisaBalance, isa = isaBalance, avc = avcBalance, gia = giaBalance;

  for (let n = 0; n < PROJECTION_YEARS; n++) {
    const age = currentAge + n;
    sipp = sipp * (1 + sippGrowthRate) + sippContribution;
    lisa = lisa * (1 + lisaGrowthRate) + (age < 50 ? lisaContribution * 1.25 : 0);
    isa = isa * (1 + isaGrowthRate) + isaContribution;
    avc = avc * (1 + avcGrowthRate) + avcContribution;
    gia = gia * (1 + (giaGrowthRateGross - giaTaxDrag)) + giaContribution;
    years.push({
      yearIndex: n,
      taxYear: currentTaxYearStart + n,
      age,
      sipp, lisa, isa, avc, gia,
      combinedTotal: sipp + lisa + isa + avc + gia,
    });
  }

  return { years };
}

// ---- Annual Allowance Check ---------------------------------------------

function annualAllowanceLimit(inputs) {
  if (!inputs.isHighEarner) return inputs.standardAnnualAllowance;
  return Math.max(10000, inputs.standardAnnualAllowance - Math.max(0, (inputs.adjustedIncome - 260000) / 2));
}

function calcAnnualAllowanceCheck(inputs, careYears) {
  const allowance = annualAllowanceLimit(inputs);
  return careYears.map((y) => {
    const totalPensionInput = y.pia + inputs.sippContribution;
    return {
      yearIndex: y.yearIndex,
      taxYear: y.taxYear,
      age: y.age,
      totalPensionInput,
      allowance,
      withinAA: totalPensionInput <= allowance,
    };
  });
}

// ---- shared helpers for Scenario Summary / Target Income Calculator ----

function findByAge(years, age) {
  return years.find((y) => y.age === age) || null;
}

// The reduction always applies now — there is no on/off toggle. It's driven by how far
// before State Pension Age the NHS pension is actually claimed (nhsClaimAge), not by
// when the person stops working (retirementAge) — those can now differ (deferral).
function earlyRetirementReductionFactor(inputs, spa, claimAge) {
  const yearsShort = Math.max(0, (spa - claimAge) - inputs.errboYearsBoughtOut);
  return Math.max(0, 1 - yearsShort * inputs.earlyRetirementReductionRate);
}

function legacyIncomeAt(inputs, legacy, currentAge, claimAge) {
  const growthMultiplier = inputs.legacyContinuousService
    ? Math.pow(1 + inputs.legacyRealGrowthRate, claimAge - currentAge)
    : 1;
  const pension =
    (claimAge >= 60 ? legacy.section1995.pension : 0) +
    (claimAge >= 65 ? legacy.section2008.pension : 0);
  const lumpSum =
    (claimAge >= 60 ? legacy.section1995.lumpSum : 0) +
    (claimAge >= 65 ? legacy.section2008.lumpSum : 0);
  return { pension: pension * growthMultiplier, lumpSum: lumpSum * growthMultiplier };
}

function drawdownRateAt(inputs, spa, claimAge) {
  if (inputs.drawdownStrategy === '4% Safe Withdrawal (perpetual)') return 0.04;
  if (claimAge >= spa) return 0.04;
  return 1 / Math.max(1, spa - claimAge);
}

function oldPensionsIncomeAt(inputs, currentAge, spa, claimAge) {
  const rate = drawdownRateAt(inputs, spa, claimAge);
  return inputs.oldPensions.reduce((sum, p) => {
    if (p.type === 'Defined Benefit') {
      return sum + (claimAge >= p.dbAge ? p.dbAmount : 0);
    }
    if (p.type === 'Defined Contribution') {
      if (claimAge < p.dcAccessAge) return sum;
      const grown = p.dcBalance * Math.pow(1 + p.dcGrowthRate, claimAge - currentAge);
      return sum + grown * rate;
    }
    return sum;
  }, 0);
}

// ---- Scenario Summary -----------------------------------------------------

// retirementAge: when the person stops working (accrual stops, private pots stop being drawn from work).
// nhsClaimAge: when the NHS 2015 Scheme + AP is actually claimed (>= retirementAge). If they differ, the
// private pots bridge the gap and are spent to zero by nhsClaimAge instead of being drawn under the normal
// drawdown strategy.
function calcScenarioForAge(inputs, personal, legacy, careYears, privateYears, retirementAge, nhsClaimAge) {
  const { currentAge, statePensionAge: spa } = personal;

  // CARE accrual stops at retirementAge; from there to nhsClaimAge the pot only revalues (no new accrual).
  const careRowAtRetirement = findByAge(careYears, retirementAge);
  const careAtRetirement = careRowAtRetirement ? careRowAtRetirement.closingPot : null;
  const yearsToClaim = nhsClaimAge - retirementAge;
  const careAtClaim =
    careAtRetirement === null ? null : careAtRetirement * Math.pow(1 + inputs.careRevaluationRealRate, yearsToClaim);
  const nhs2015BeforeReduction = careAtClaim === null ? null : careAtClaim + inputs.apPurchasedAnnual;

  const reductionFactor = earlyRetirementReductionFactor(inputs, spa, nhsClaimAge);
  const nhs2015AfterReduction = nhs2015BeforeReduction === null ? null : nhs2015BeforeReduction * reductionFactor;

  const legacyIncome = legacyIncomeAt(inputs, legacy, currentAge, nhsClaimAge);

  const statePension = nhsClaimAge >= spa ? inputs.estimatedStatePensionAnnual : 0;

  const privateRow = findByAge(privateYears, retirementAge);
  const privatePot = privateRow ? privateRow.combinedTotal : null;
  const bridgeYears = Math.max(0, nhsClaimAge - retirementAge);
  const bridgeIncome = bridgeYears > 0 && privatePot !== null ? privatePot / bridgeYears : 0;
  const privatePotRemaining = bridgeYears > 0 ? 0 : privatePot;
  const drawdown = privatePotRemaining === null ? null : privatePotRemaining * drawdownRateAt(inputs, spa, nhsClaimAge);

  const oldPensionsIncome = oldPensionsIncomeAt(inputs, currentAge, spa, nhsClaimAge);

  const totalIncomeFromClaimAge =
    (nhs2015AfterReduction ?? NaN) + legacyIncome.pension + statePension + (drawdown ?? NaN) + oldPensionsIncome;

  return {
    retirementAge,
    nhsClaimAge,
    nhs2015BeforeReduction,
    reductionFactor,
    nhs2015AfterReduction,
    legacyPension: legacyIncome.pension,
    legacyLumpSum: legacyIncome.lumpSum,
    statePension,
    privatePot,
    bridgeYears,
    bridgeIncome,
    privatePotRemaining,
    drawdown,
    oldPensionsIncome,
    totalIncomeFromClaimAge,
    lumpSum: legacyIncome.lumpSum,
  };
}

function calcScenarioSummary(inputs, personal, legacy, careYears, privateYears) {
  const scenarios = inputs.scenarios.map(({ retirementAge, nhsClaimAge }) =>
    calcScenarioForAge(inputs, personal, legacy, careYears, privateYears, retirementAge, nhsClaimAge)
  );
  return { scenarios };
}

// ---- Target Income Calculator ---------------------------------------------

function calcTargetIncomeCalculator(inputs, personal, legacy, careYears, privateYears) {
  const targetAge = inputs.targetAge;
  const s = calcScenarioForAge(inputs, personal, legacy, careYears, privateYears, targetAge, targetAge);

  const guaranteedIncome = s.legacyPension + s.nhs2015AfterReduction + s.statePension + s.oldPensionsIncome;
  const incomeGap = Math.max(0, inputs.targetIncome - guaranteedIncome);

  const spa = personal.statePensionAge;
  const potNeeded =
    inputs.drawdownStrategy === '4% Safe Withdrawal (perpetual)'
      ? incomeGap / 0.04
      : targetAge >= spa
      ? incomeGap / 0.04
      : incomeGap * Math.max(1, spa - targetAge);

  const projectedPot = s.privatePot;
  const shortfall = Math.max(0, potNeeded - projectedPot);
  const yearsToSave = Math.max(1, targetAge - personal.currentAge);

  const scenarios = [
    { label: 'Cautious', rate: Math.max(0, inputs.targetSavingsGrowthRate - 0.015) },
    { label: 'Central', rate: inputs.targetSavingsGrowthRate },
    { label: 'Optimistic', rate: inputs.targetSavingsGrowthRate + 0.015 },
  ].map(({ label, rate }) => ({
    label,
    rate,
    extraAnnualSavingNeeded:
      rate === 0 ? shortfall / yearsToSave : (shortfall * rate) / (Math.pow(1 + rate, yearsToSave) - 1),
  }));

  return {
    targetAge,
    targetIncome: inputs.targetIncome,
    guaranteedIncome,
    incomeGap,
    potNeeded,
    projectedPot,
    shortfall,
    yearsToSave,
    scenarios,
  };
}

// ---- Retirement Living Standards ------------------------------------------

const RETIREMENT_LIVING_STANDARDS = {
  minimum: { onePerson: 13900, twoPerson: 22500 },
  moderate: { onePerson: 32700, twoPerson: 45400 },
  comfortable: { onePerson: 45400, twoPerson: 62700 },
};

function nearestLivingStandard(householdType, income) {
  const key = householdType === 'One-person' ? 'onePerson' : 'twoPerson';
  const { minimum, moderate, comfortable } = RETIREMENT_LIVING_STANDARDS;
  if (income < minimum[key]) return 'Below Minimum';
  if (income < moderate[key]) return 'Minimum';
  if (income < comfortable[key]) return 'Moderate';
  return 'Comfortable';
}

function calcRetirementLivingStandards(inputs, scenarioSummary) {
  return {
    benchmarks: RETIREMENT_LIVING_STANDARDS,
    scenarios: scenarioSummary.scenarios.map((s) => ({
      retirementAge: s.retirementAge,
      nhsClaimAge: s.nhsClaimAge,
      totalIncomeFromClaimAge: s.totalIncomeFromClaimAge,
      nearestStandard: nearestLivingStandard(inputs.householdType, s.totalIncomeFromClaimAge),
    })),
  };
}

// ---- top-level orchestration -----------------------------------------------

function runModel(inputs, asOfDate = new Date()) {
  const personal = calcPersonal(inputs, asOfDate);
  const legacy = calcLegacyScheme(inputs);
  const care = calcCareProjection(inputs, personal.currentAge);
  const privatePensions = calcPrivatePensionsProjection(inputs, personal.currentAge);
  const annualAllowance = calcAnnualAllowanceCheck(inputs, care.years);
  const scenarioSummary = calcScenarioSummary(inputs, personal, legacy, care.years, privatePensions.years);
  const targetIncomeCalculator = calcTargetIncomeCalculator(
    inputs, personal, legacy, care.years, privatePensions.years
  );
  const retirementLivingStandards = calcRetirementLivingStandards(inputs, scenarioSummary);

  return {
    personal,
    legacy,
    care,
    privatePensions,
    annualAllowance,
    scenarioSummary,
    targetIncomeCalculator,
    retirementLivingStandards,
  };
}

return {
  runModel,
  datedifYears,
  statePensionAge,
  annualAllowanceLimit,
  PROJECTION_YEARS,
  CATCH_UP_STEPS,
};

});
