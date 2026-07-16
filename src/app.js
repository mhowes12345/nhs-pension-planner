// UI glue: reads the inputs form, runs CalcEngine, renders the results dashboard.
// No build step — plain DOM APIs only.

const form = document.getElementById('inputsForm');
const resultsEl = document.getElementById('results');

// ---- old pension rows (3 repeatable slots) --------------------------------

function oldPensionRowHtml(n) {
  return `
    <div class="old-pension-row" data-old-pension="${n}">
      <h3>Old Pension ${n}</h3>
      <label data-note="Leave as 'Blank' if not applicable">Type
        <select name="oldPension${n}Type">
          <option value="Blank" selected>Blank (not applicable)</option>
          <option value="Defined Benefit">Defined Benefit</option>
          <option value="Defined Contribution">Defined Contribution</option>
        </select>
      </label>
      <label data-depends-on="oldPension${n}Type" data-depends-value="Defined Benefit" data-note="Only used if Type = Defined Benefit">DB: annual pension amount (£)
        <input type="number" name="oldPension${n}DbAmount" value="0" step="1" min="0">
      </label>
      <label data-depends-on="oldPension${n}Type" data-depends-value="Defined Benefit" data-note="Only used if Type = Defined Benefit">DB: age payable from
        <input type="number" name="oldPension${n}DbAge" value="65" step="1" min="40" max="90">
      </label>
      <label data-depends-on="oldPension${n}Type" data-depends-value="Defined Contribution" data-note="Only used if Type = Defined Contribution">DC: current balance (£)
        <input type="number" name="oldPension${n}DcBalance" value="0" step="1" min="0">
      </label>
      <label data-depends-on="oldPension${n}Type" data-depends-value="Defined Contribution" data-note="Only used if Type = Defined Contribution">DC: assumed REAL growth rate p.a. (%)
        <input type="number" name="oldPension${n}DcGrowthRate" value="4.5" step="0.1">
      </label>
      <label data-depends-on="oldPension${n}Type" data-depends-value="Defined Contribution" data-note="Only used if Type = Defined Contribution">DC: access age
        <input type="number" name="oldPension${n}DcAccessAge" value="57" step="1" min="40" max="90">
      </label>
    </div>`;
}

document.getElementById('oldPensionsFieldset').insertAdjacentHTML(
  'beforeend',
  [1, 2, 3].map(oldPensionRowHtml).join('')
);

// ---- persistence (localStorage autosave) -----------------------------------
// Saves every field on each recalculation and restores it on load, so the form
// survives a refresh. Wrapped in try/catch since localStorage can throw (private
// browsing, quota, disabled) — autosave just silently no-ops in that case.

const STORAGE_KEY = 'nhsPensionPlanner:inputs';

function saveFormToStorage() {
  try {
    const data = {};
    Array.from(form.elements).forEach((el) => {
      if (!el.name) return;
      data[el.name] = el.value;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // autosave unavailable — form still works, it just won't persist
  }
}

function loadFormFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    Object.keys(data).forEach((name) => {
      const el = form.elements[name];
      if (el) el.value = data[name];
    });
  } catch (e) {
    // corrupt or unavailable storage — fall back to the HTML defaults
  }
}

loadFormFromStorage();

// ---- conditional field visibility -----------------------------------------

function refreshConditionalFields() {
  form.querySelectorAll('[data-depends-on]').forEach((el) => {
    const controllingField = form.elements[el.dataset.dependsOn];
    const show = controllingField && controllingField.value === el.dataset.dependsValue;
    el.style.display = show ? '' : 'none';
  });
}

// ---- guided / advanced mode -------------------------------------------------
// Guided mode is the default onboarding view: only the 3 quick-start fields are
// shown at first, everything else takes its HTML default until a later guided
// stage (or Advanced mode) surfaces it. Both modes read/write the exact same
// <form> — nothing is duplicated, so switching modes never loses or diverges data.

const MODE_KEY = 'nhsPensionPlanner:mode';
const GUIDED_QUICKSTART_FIELDS = ['dateOfBirth', 'currentPensionablePay', 'carePotLastStatement', 'carePotStatementTaxYearEnd'];

let currentMode = 'guided';
try {
  const storedMode = localStorage.getItem(MODE_KEY);
  if (storedMode === 'advanced' || storedMode === 'guided') currentMode = storedMode;
} catch (e) {
  // storage unavailable — default to guided
}

// A fieldset/details block that contains ONLY quick-start/wizard-revealed fields is
// left alone in guided mode; one that contains a MIX (e.g. "Personal" also has tax-
// year/State-Pension fields) stays visible with just its non-relevant labels hidden;
// one with NO relevant fields is hidden entirely. guidedRevealedFields/Containers are
// populated by the wizard below, based on the user's answers so far.
function applyGuidedVisibility() {
  const guided = currentMode === 'guided';
  form.querySelectorAll('fieldset, details.input-section').forEach((container) => {
    const labels = Array.from(container.querySelectorAll('label'));
    if (!guided) {
      container.style.display = '';
      labels.forEach((l) => { l.style.display = ''; });
      return;
    }
    if (guidedRevealedContainers.has(container.id)) {
      container.style.display = '';
      labels.forEach((l) => { l.style.display = ''; });
      return;
    }
    const isVisibleLabel = (l) => {
      const input = l.querySelector('[name]');
      return input && (GUIDED_QUICKSTART_FIELDS.includes(input.name) || guidedRevealedFields.has(input.name));
    };
    const hasVisibleField = labels.some(isVisibleLabel);
    if (!hasVisibleField) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    labels.forEach((l) => { l.style.display = isVisibleLabel(l) ? '' : 'none'; });
  });
}

function setMode(mode) {
  currentMode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
  document.querySelectorAll('.mode-toggle-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  update();
}

document.querySelectorAll('.mode-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
  const active = btn.dataset.mode === currentMode;
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
});

// ---- guided wizard (progressive disclosure, §2 of the rework brief) ---------
// One plain-English question at a time, Next/Back, each defaulting to the most
// common answer (No). Answering Yes reveals the relevant fields IN PLACE in their
// original fieldsets — fields are never duplicated or moved, since a second input
// with the same name would break form.elements[name] lookups. "Not sure" is offered
// where a GP plausibly wouldn't know; it defaults safely (like No) but shows an
// explainer and flags the headline as possibly incomplete.

const WIZARD_KEY = 'nhsPensionPlanner:wizard';

const WIZARD_STEPS = [
  {
    id: 'legacy',
    question: 'Do you have NHS service from before 2015?',
    help: 'If you were in the NHS pension scheme before April 2015, you’ll also have benefits in the older 1995 or 2008 Section — usually worth a lot, so it’s worth digging out.',
    notSure: true,
    notSureExplainer: 'Your Total Reward Statement (TRS) will show a “1995 Section” or “2008 Section” block if you have one — log in at totalrewardstatements.nhs.uk. For now we’ll assume you don’t, which may understate your pension.',
    revealFields: ['legacy1995Pension', 'legacy1995LumpSum', 'legacy2008Pension', 'legacy2008LumpSum'],
  },
  {
    id: 'serviceBreak',
    question: 'Have you had a break in NHS service of 5 years or more?',
    help: 'A 5+ year break stops your older (1995/2008) benefits growing with your career — they’re frozen in real terms instead.',
    notSure: true,
    notSureExplainer: 'If you’re not certain, we’ll assume no break — that’s the common case for most careers. A 5+ year gap would make this projection slightly optimistic about your older benefits.',
    revealFields: [],
    onlyIf: (answers) => answers.legacy === 'yes',
    applyAnswer: (answer) => {
      // This one maps directly onto an existing form field rather than just revealing
      // fields: continuous service = no 5+ year break.
      form.elements.legacyContinuousService.value = answer === 'yes' ? 'No' : 'Yes';
    },
  },
  {
    id: 'private',
    question: 'Do you pay into a private pension or ISA?',
    help: 'A SIPP, workplace pension outside the NHS, Lifetime ISA, or Stocks & Shares ISA — anything you’re saving for retirement beyond the NHS scheme.',
    notSure: false,
    revealFields: ['sippBalance', 'sippContribution', 'sippGrowthRate', 'lisaBalance', 'lisaContribution', 'lisaGrowthRate', 'isaBalance', 'isaContribution', 'isaGrowthRate'],
  },
  {
    id: 'apAvc',
    question: 'Have you bought Additional Pension or paid NHS AVCs?',
    help: 'Additional Pension (AP) is extra guaranteed NHS pension you can buy. AVCs are an invested top-up run alongside the NHS scheme. Most people haven’t — if this doesn’t ring a bell, it’s a No.',
    notSure: true,
    notSureExplainer: 'These only exist if you actively signed up and pay for them — they’d show on your payslip as a separate deduction. We’ll assume not.',
    revealFields: ['apPurchasedAnnual', 'avcBalance', 'avcContribution', 'avcGrowthRate'],
  },
  {
    id: 'errbo',
    question: 'Have you bought out any early retirement reduction (ERRBO)?',
    help: 'An ERRBO agreement means you pay extra so you can retire before your Normal Pension Age with less (or no) reduction. Like AP, you’d know — it’s a deliberate signup with a payslip deduction.',
    notSure: true,
    notSureExplainer: 'ERRBO only exists if you signed up for it — we’ll assume not.',
    revealFields: ['errboYearsBoughtOut', 'earlyRetirementReductionRate'],
  },
  {
    id: 'oldPensions',
    question: 'Do you have pensions from before the NHS?',
    help: 'Old workplace pensions from previous jobs — “frozen” or “deferred” pensions you no longer pay into but that will still pay out.',
    notSure: true,
    notSureExplainer: 'You can check old paperwork or use gov.uk’s Pension Tracing Service. We’ll leave them out for now, which may understate your income.',
    revealContainers: ['oldPensionsFieldset'],
  },
  {
    id: 'highEarner',
    question: 'Do you earn over £200,000 a year?',
    help: 'Above roughly this level, a lower “tapered” Annual Allowance can apply to your pension savings and trigger tax charges.',
    notSure: false,
    revealFields: ['isHighEarner', 'adjustedIncome', 'standardAnnualAllowance'],
    applyAnswer: (answer) => {
      form.elements.isHighEarner.value = answer === 'yes' ? 'Yes' : 'No';
    },
  },
  {
    id: 'compareAges',
    question: 'Do you want to compare stopping work at different ages?',
    help: 'See side-by-side what retiring at, say, 57 vs 60 vs 67 would mean — including stopping work early but claiming your NHS pension later, with private savings bridging the gap.',
    notSure: false,
    revealContainers: ['scenariosFieldset'],
    revealFields: ['drawdownStrategy'],
  },
];

// answers: stepId -> 'yes' | 'no' | 'notsure' (absent = unanswered)
let wizardState = { step: 0, answers: {} };
try {
  const raw = localStorage.getItem(WIZARD_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.step === 'number' && parsed.answers) wizardState = parsed;
  }
} catch (e) {
  // corrupt/unavailable — start fresh
}

function saveWizardState() {
  try { localStorage.setItem(WIZARD_KEY, JSON.stringify(wizardState)); } catch (e) {}
}

// Steps whose onlyIf gate fails are skipped entirely (never shown, reveal nothing).
function activeWizardSteps() {
  return WIZARD_STEPS.filter((s) => !s.onlyIf || s.onlyIf(wizardState.answers));
}

const guidedRevealedFields = new Set();
const guidedRevealedContainers = new Set();

function recomputeRevealed() {
  guidedRevealedFields.clear();
  guidedRevealedContainers.clear();
  activeWizardSteps().forEach((step) => {
    if (wizardState.answers[step.id] !== 'yes') return;
    (step.revealFields || []).forEach((f) => guidedRevealedFields.add(f));
    (step.revealContainers || []).forEach((c) => guidedRevealedContainers.add(c));
  });
}

function anyNotSure() {
  return activeWizardSteps().some((s) => wizardState.answers[s.id] === 'notsure');
}

function resetFieldToDefault(el) {
  if (el.tagName === 'SELECT') {
    const def = Array.from(el.options).find((o) => o.defaultSelected) || el.options[0];
    if (def) el.value = def.value;
  } else {
    el.value = el.defaultValue;
  }
}

function answerWizardStep(stepId, answer) {
  const prev = wizardState.answers[stepId];
  wizardState.answers[stepId] = answer;
  const step = WIZARD_STEPS.find((s) => s.id === stepId);
  // Downgrading from Yes hides the step's fields again — reset them to their HTML
  // defaults too, otherwise values typed while they were visible would silently keep
  // feeding the projection ("never reveal a field the user's answers make irrelevant"
  // has to mean the values stop counting as well, not just the inputs disappearing).
  if (prev === 'yes' && answer !== 'yes' && step) {
    (step.revealFields || []).forEach((name) => {
      const el = form.elements[name];
      if (el) resetFieldToDefault(el);
    });
    (step.revealContainers || []).forEach((id) => {
      const container = document.getElementById(id);
      if (container) container.querySelectorAll('input, select').forEach(resetFieldToDefault);
    });
  }
  if (step && step.applyAnswer) step.applyAnswer(answer);
  saveWizardState();
}

function renderWizard() {
  const wizardEl = document.getElementById('guidedWizard');
  if (currentMode !== 'guided') {
    wizardEl.innerHTML = '';
    return;
  }

  const steps = activeWizardSteps();
  const idx = Math.min(wizardState.step, steps.length);
  const done = idx >= steps.length;

  if (done) {
    const answeredCount = steps.filter((s) => wizardState.answers[s.id]).length;
    wizardEl.innerHTML = `
      <div class="wizard-card wizard-done">
        <p class="wizard-done-msg">That's everything — your projection above reflects all ${answeredCount} answers.</p>
        <div class="wizard-nav">
          <button type="button" class="wizard-btn wizard-back" data-wizard-nav="back">&larr; Back</button>
          <button type="button" class="wizard-btn wizard-restart" data-wizard-nav="restart">Start again</button>
        </div>
        <p class="hint">Want full control of every number? Switch to <strong>Advanced (full form)</strong> at the top.</p>
      </div>`;
    return;
  }

  const step = steps[idx];
  const current = wizardState.answers[step.id];
  const showNotSureExplainer = current === 'notsure' && step.notSureExplainer;
  const answered = Boolean(current);
  const revealed = current === 'yes' && ((step.revealFields || []).length > 0 || (step.revealContainers || []).length > 0);

  const answerBtn = (value, label) => `
    <button type="button" class="wizard-answer ${current === value ? 'selected' : ''}" data-wizard-answer="${value}">${label}</button>`;

  wizardEl.innerHTML = `
    <div class="wizard-card">
      <div class="wizard-progress">Question ${idx + 1} of ${steps.length}</div>
      <p class="wizard-question">${step.question}</p>
      <p class="wizard-help">${step.help}</p>
      <div class="wizard-answers">
        ${answerBtn('yes', 'Yes')}
        ${answerBtn('no', 'No')}
        ${step.notSure ? answerBtn('notsure', 'Not sure') : ''}
      </div>
      ${showNotSureExplainer ? `<p class="wizard-notsure-explainer">${step.notSureExplainer}</p>` : ''}
      ${revealed ? `<p class="wizard-reveal-note">New fields have appeared above — fill them in, then carry on.</p>` : ''}
      <div class="wizard-nav">
        <button type="button" class="wizard-btn wizard-back" data-wizard-nav="back" ${idx === 0 ? 'disabled' : ''}>&larr; Back</button>
        <button type="button" class="wizard-btn wizard-next" data-wizard-nav="next">${answered ? 'Next &rarr;' : 'Skip &rarr;'}</button>
      </div>
      <button type="button" class="wizard-skip-all" data-wizard-nav="finish">I'm done — show my results</button>
    </div>`;
}

document.getElementById('guidedWizard').addEventListener('click', (e) => {
  const answerBtn = e.target.closest('[data-wizard-answer]');
  if (answerBtn) {
    const steps = activeWizardSteps();
    const step = steps[Math.min(wizardState.step, steps.length - 1)];
    answerWizardStep(step.id, answerBtn.dataset.wizardAnswer);
    update();
    return;
  }
  const navBtn = e.target.closest('[data-wizard-nav]');
  if (!navBtn) return;
  const nav = navBtn.dataset.wizardNav;
  if (nav === 'back') {
    wizardState.step = Math.max(0, wizardState.step - 1);
  } else if (nav === 'next') {
    // An unanswered question skipped with Next defaults to the most common answer: No.
    const steps = activeWizardSteps();
    const step = steps[wizardState.step];
    if (step && !wizardState.answers[step.id]) answerWizardStep(step.id, 'no');
    wizardState.step += 1;
  } else if (nav === 'finish') {
    wizardState.step = activeWizardSteps().length;
  } else if (nav === 'restart') {
    wizardState = { step: 0, answers: {} };
    form.elements.legacyContinuousService.value = 'Yes';
    form.elements.isHighEarner.value = 'No';
  }
  saveWizardState();
  update();
});

// ---- read form -> inputs object matching calcEngine schema ----------------

function pct(name) {
  return (parseFloat(form.elements[name].value) || 0) / 100;
}
function num(name) {
  return parseFloat(form.elements[name].value) || 0;
}
function str(name) {
  return form.elements[name].value;
}
function yesNo(name) {
  return str(name) === 'Yes';
}

function readInputs() {
  const oldPensions = [1, 2, 3].map((n) => ({
    type: str(`oldPension${n}Type`),
    dbAmount: num(`oldPension${n}DbAmount`),
    dbAge: num(`oldPension${n}DbAge`),
    dcBalance: num(`oldPension${n}DcBalance`),
    dcGrowthRate: pct(`oldPension${n}DcGrowthRate`),
    dcAccessAge: num(`oldPension${n}DcAccessAge`),
  }));

  const marginalTaxBand = str('marginalTaxBand');
  const giaTaxDrag = { Basic: 0.005, Higher: 0.01, Additional: 0.011, None: 0 }[marginalTaxBand] ?? 0;

  return {
    dateOfBirth: str('dateOfBirth'),
    currentTaxYearStart: num('currentTaxYearStart'),
    estimatedStatePensionAnnual: num('estimatedStatePensionAnnual'),

    legacy1995Pension: num('legacy1995Pension'),
    legacy1995LumpSum: num('legacy1995LumpSum'),
    legacy2008Pension: num('legacy2008Pension'),
    legacy2008LumpSum: num('legacy2008LumpSum'),
    legacyContinuousService: yesNo('legacyContinuousService'),
    legacyRealGrowthRate: pct('legacyRealGrowthRate'),

    carePotLastStatement: num('carePotLastStatement'),
    carePotStatementTaxYearEnd: num('carePotStatementTaxYearEnd'),
    currentPensionablePay: num('currentPensionablePay'),
    payRealGrowthRate: pct('payRealGrowthRate'),
    careRevaluationRealRate: pct('careRevaluationRealRate'),
    careAccrualRateDenominator: num('careAccrualRateDenominator'),

    sippBalance: num('sippBalance'),
    sippContribution: num('sippContribution'),
    sippGrowthRate: pct('sippGrowthRate'),
    sippAccessAge: 57,

    lisaBalance: num('lisaBalance'),
    lisaContribution: num('lisaContribution'),
    lisaGrowthRate: pct('lisaGrowthRate'),
    lisaAccessAge: 60,

    isaBalance: num('isaBalance'),
    isaContribution: num('isaContribution'),
    isaGrowthRate: pct('isaGrowthRate'),

    apPurchasedAnnual: num('apPurchasedAnnual'),
    avcBalance: num('avcBalance'),
    avcContribution: num('avcContribution'),
    avcGrowthRate: pct('avcGrowthRate'),

    errboYearsBoughtOut: num('errboYearsBoughtOut'),
    earlyRetirementReductionRate: pct('earlyRetirementReductionRate'),

    giaBalance: num('giaBalance'),
    giaContribution: num('giaContribution'),
    giaGrowthRateGross: pct('giaGrowthRateGross'),
    giaTaxDrag,

    oldPensions,

    standardAnnualAllowance: num('standardAnnualAllowance'),
    isHighEarner: yesNo('isHighEarner'),
    adjustedIncome: num('adjustedIncome'),

    drawdownStrategy: str('drawdownStrategy'),

    scenarios: [
      { retirementAge: num('scenarioAAge'), nhsClaimAge: num('scenarioAClaimAge') },
      { retirementAge: num('scenarioBAge'), nhsClaimAge: num('scenarioBClaimAge') },
      { retirementAge: num('scenarioCAge'), nhsClaimAge: num('scenarioCClaimAge') },
    ],

    targetIncome: num('targetIncome'),
    targetAge: num('targetAge'),
    targetSavingsGrowthRate: pct('targetSavingsGrowthRate'),

    householdType: str('householdType'),
  };
}

// ---- guided headline (two derived ages) -------------------------------------
// The headline reuses the exact same engine call as the scenario grid — inputs.scenarios
// is just a list the engine maps over, not hardcoded to 3 — so no engine change is needed:
// we just build a 2-entry scenarios list (retire = claim, at each headline age) and call
// runModel a second time on that.

function normalMinimumPensionAge(asOfDate) {
  return asOfDate >= new Date('2028-04-06') ? 57 : 55;
}

// Starts as [min private-pension access age, State Pension Age] — the only two ages
// derivable from the 3 quick-start fields alone. Once legacy service is entered (via a
// later guided stage, or Advanced mode), swaps to the member's real NPAs (60 for 1995
// Section, 65 for 2008 Section) so the headline sharpens as more is disclosed.
function computeHeadlineAges(inputs, model) {
  const hasSection1995 = inputs.legacy1995Pension > 0 || inputs.legacy1995LumpSum > 0;
  const hasSection2008 = inputs.legacy2008Pension > 0 || inputs.legacy2008LumpSum > 0;
  const spa = model.personal.statePensionAge;

  if (hasSection1995 && hasSection2008) return [60, 65];
  if (hasSection1995) return [60, spa];
  if (hasSection2008) return [65, spa];
  return [normalMinimumPensionAge(new Date()), spa];
}

function buildHeadlineModel(inputs, model) {
  const [age1, age2] = computeHeadlineAges(inputs, model);
  const headlineInputs = {
    ...inputs,
    scenarios: [
      { retirementAge: age1, nhsClaimAge: age1 },
      { retirementAge: age2, nhsClaimAge: age2 },
    ],
  };
  return CalcEngine.runModel(headlineInputs, new Date());
}

// ---- formatting -------------------------------------------------------------

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return gbp.format(v);
}
function pctFmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return `${(v * 100).toFixed(0)}%`;
}
// 1 decimal place, unlike pctFmt above — used where the precise assumption value
// matters (e.g. 4.5% growth would otherwise round to a misleading "5%").
function pctFmtPrecise(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return `${(v * 100).toFixed(1)}%`;
}

const STANDARD_BADGE_CLASS = {
  'Below Minimum': 'badge-below',
  Minimum: 'badge-minimum',
  Moderate: 'badge-moderate',
  Comfortable: 'badge-comfortable',
};

// ---- rendering ----------------------------------------------------------------

function renderScenarioCard(s, i, model, inputs) {
  const label = ['A', 'B', 'C'][i];
  const rls = model.retirementLivingStandards.scenarios[i];
  const badgeClass = STANDARD_BADGE_CLASS[rls.nearestStandard] || '';
  const isDeferring = s.bridgeYears > 0;

  const rows = [
    ['NHS 2015 Scheme + AP (after reduction)', money(s.nhs2015AfterReduction)],
    ['NHS Legacy (1995/2008) pension', money(s.legacyPension)],
    ['State Pension', money(s.statePension)],
    ['Private pots — ongoing drawdown', money(s.drawdown)],
    ['Old / frozen pensions', money(s.oldPensionsIncome)],
  ];

  const heading = isDeferring
    ? `Scenario ${label} — retire ${s.retirementAge}, claim ${s.nhsClaimAge}`
    : `Scenario ${label} — Age ${s.retirementAge}`;

  const gainsStatePension = !s.statePensionIncludedFromClaimAge && inputs.estimatedStatePensionAnnual > 0;
  const showSpaCallout = gainsStatePension || s.drawdownExpiresAtSpa;

  let spaLabel, spaAmountHtml;
  if (s.drawdownExpiresAtSpa && gainsStatePension) {
    spaLabel = 'private pot income ends (Bridge strategy), State Pension begins';
    spaAmountHtml = `<span>&rarr; ${money(s.totalIncomeFromStatePensionAge)}/yr total</span>`;
  } else if (s.drawdownExpiresAtSpa) {
    spaLabel = 'private pot income ends (Bridge strategy)';
    spaAmountHtml = `<span>&rarr; ${money(s.totalIncomeFromStatePensionAge)}/yr total</span>`;
  } else {
    spaLabel = '+ State Pension';
    spaAmountHtml = `+${money(inputs.estimatedStatePensionAnnual)}/yr <span>&rarr; ${money(s.totalIncomeFromStatePensionAge)}/yr total</span>`;
  }

  return `
    <article class="scenario-card">
      <h3>${heading}</h3>
      ${isDeferring ? `
        <div class="bridge-callout">
          <div class="bridge-label">Bridge income — ages ${s.retirementAge}&ndash;${s.nhsClaimAge - 1} (${s.bridgeYears} yr${s.bridgeYears === 1 ? '' : 's'})</div>
          <div class="bridge-amount">${money(s.bridgeIncome)}<span>/yr</span></div>
        </div>
        <div class="scenario-total-label">Then, from age ${s.nhsClaimAge}:</div>
      ` : ''}
      <div class="scenario-total">${money(s.totalIncomeFromClaimAge)}<span>/yr</span></div>
      <div class="badge ${badgeClass}">${rls.nearestStandard}</div>
      <table class="breakdown-table">
        ${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
      </table>
      ${s.reductionFactor < 1 ? `<p class="note">Early retirement reduction: ${pctFmt(1 - s.reductionFactor)} cut (${pctFmt(s.reductionFactor)} retained)</p>` : ''}
      ${s.drawdownExpiresAtSpa ? `<p class="note warn">The private-pot drawdown above is temporary — the Bridge strategy deliberately drains it to zero by State Pension Age (${s.statePensionAge}), so this total won't last. See below for what happens after.</p>` : ''}
      ${showSpaCallout ? `
        <div class="spa-callout">
          <div class="spa-callout-label">Then, from State Pension Age ${s.statePensionAge}: ${spaLabel}</div>
          <div class="spa-callout-amount">${spaAmountHtml}</div>
        </div>
      ` : ''}
      ${s.lumpSum ? `<p class="note">One-off tax-free lump sum: ${money(s.lumpSum)}</p>` : ''}
      <p class="note">Private pot at retirement: ${money(s.privatePot)}</p>
    </article>`;
}

function renderTargetIncome(t) {
  return `
    <article class="panel">
      <h2>Target Income Calculator</h2>
      <p>Targeting ${money(t.targetIncome)}/yr from age ${t.targetAge}.</p>
      <table class="breakdown-table">
        <tr><td>Guaranteed income at target age</td><td>${money(t.guaranteedIncome)}</td></tr>
        <tr><td>Income gap</td><td>${money(t.incomeGap)}</td></tr>
        <tr><td>Total private pot needed</td><td>${money(t.potNeeded)}</td></tr>
        <tr><td>Private pot already projected</td><td>${money(t.projectedPot)}</td></tr>
        <tr><td><strong>Shortfall</strong></td><td><strong>${money(t.shortfall)}</strong></td></tr>
        <tr><td>Years left to save</td><td>${t.yearsToSave}</td></tr>
      </table>
      ${t.shortfall > 0 ? `
        <p class="note">Extra annual saving needed, on top of your current plan:</p>
        <table class="breakdown-table">
          ${t.scenarios.map((s) => `<tr><td>${s.label} (${pctFmt(s.rate)} real growth)</td><td>${money(s.extraAnnualSavingNeeded)}</td></tr>`).join('')}
        </table>
      ` : `<p class="note">Your current plan already covers this target — no extra saving needed.</p>`}
    </article>`;
}

function renderAnnualAllowance(annualAllowance) {
  const breaches = annualAllowance.filter((y) => !y.withinAA);
  if (breaches.length === 0) {
    return `<article class="panel"><h2>Annual Allowance</h2><p class="note ok">All projected years stay within your Annual Allowance.</p></article>`;
  }
  return `
    <article class="panel">
      <h2>Annual Allowance</h2>
      <p class="note warn">${breaches.length} projected year(s) may exceed your Annual Allowance — worth a closer check:</p>
      <table class="breakdown-table">
        <tr><th>Tax year</th><th>Age</th><th>Pension input</th><th>Allowance</th></tr>
        ${breaches.map((y) => `<tr><td>${y.taxYear}</td><td>${y.age}</td><td>${money(y.totalPensionInput)}</td><td>${money(y.allowance)}</td></tr>`).join('')}
      </table>
    </article>`;
}

const PLAIN_NUMBER_COLUMNS = new Set(['taxYear', 'age']);

function renderProjectionTable(title, years, columns) {
  return `
    <details class="projection-details">
      <summary>${title}</summary>
      <div class="table-scroll">
        <table class="breakdown-table projection-table">
          <tr>${columns.map(([, label]) => `<th>${label}</th>`).join('')}</tr>
          ${years.map((y) => `<tr>${columns.map(([key]) => `<td>${typeof y[key] === 'number' && !PLAIN_NUMBER_COLUMNS.has(key) ? money(y[key]) : y[key]}</td>`).join('')}</tr>`).join('')}
        </table>
      </div>
    </details>`;
}

// ---- static reference panels (Retirement Living Standards / Glossary / Assumptions) ---
// Content mirrors the corresponding read-only tabs in the workbook verbatim.

const RLS_DESCRIPTIONS = {
  minimum: 'Covers all basic needs with some left over for fun — a week’s UK holiday, no car, modest eating out',
  moderate: 'More financial security and flexibility — an annual overseas holiday, a car, eating out a few times a month',
  comfortable: 'More financial freedom — long-haul-style holidays, a newer car replaced regularly, regular treats and gifts',
};

function renderRetirementLivingStandardsPanel(model) {
  const b = model.retirementLivingStandards.benchmarks;
  const rows = [
    ['Minimum', b.minimum, RLS_DESCRIPTIONS.minimum],
    ['Moderate', b.moderate, RLS_DESCRIPTIONS.moderate],
    ['Comfortable', b.comfortable, RLS_DESCRIPTIONS.comfortable],
  ];
  return `
    <article class="panel">
      <h2>Retirement Living Standards</h2>
      <p class="note">Independent annual benchmarks (Pensions UK, formerly PLSA, researched by Loughborough University) for what different retirement lifestyles cost. These are spending targets, not income recommendations. Source: retirementlivingstandards.org.uk</p>
      <details class="projection-details">
        <summary>Show benchmark table</summary>
        <div class="table-scroll">
          <table class="reference-table">
            <tr class="reference-table-head"><th>Standard</th><th>One-person</th><th>Two-person</th><th>What it typically includes</th></tr>
            ${rows.map(([label, v, desc]) => `<tr><td>${label}</td><td data-label="One-person">${money(v.onePerson)}</td><td data-label="Two-person">${money(v.twoPerson)}</td><td data-label="What it typically includes">${desc}</td></tr>`).join('')}
          </table>
        </div>
        <p class="note">Figures assume you own your home outright (no rent/mortgage) and exclude care costs.</p>
      </details>
    </article>`;
}

const GLOSSARY_TERMS = [
  ['1995 / 2008 Section', 'The two ‘legacy’ NHS pension schemes, closed to new members from 2015. Final-salary based — your pension depends on your pay near the end of membership, not your career average.'],
  ['2015 Scheme (CARE)', 'The current NHS pension scheme. ‘Career Average Revalued Earnings’ — you build up a slice of pension each year based on that year’s pay, which then grows with inflation until retirement.'],
  ['McCloud Remedy', 'A legal fix for age discrimination when the 1995/2008 schemes were closed. For service between April 2015 and March 2022, NHS Pensions automatically compares legacy vs 2015 Scheme rules and gives you whichever is higher.'],
  ['Normal Pension Age (NPA)', 'The age you can take your NHS pension in full, with no reduction. 60 (1995 Section), 65 (2008 Section), or your State Pension Age (2015 Scheme).'],
  ['Normal Minimum Pension Age (NMPA)', 'The earliest age you can access a PRIVATE pension (SIPP etc) without penalty. Currently 55, rising to 57 from April 2028.'],
  ['Additional Pension (AP)', 'A way to buy extra GUARANTEED, inflation-linked NHS pension on top of your normal 2015 Scheme benefits, up to a yearly limit (~£8,946 for 2026/27).'],
  ['AVC (Additional Voluntary Contribution)', 'An in-house, INVESTED (not guaranteed) way to top up your NHS pension savings — more like a SIPP than a guaranteed pension.'],
  ['ERRBO (Early Retirement Reduction Buy Out)', 'Lets 2015 Scheme members pay extra to reduce or remove the penalty for retiring before their Normal Pension Age.'],
  ['Annual Allowance (AA)', 'The most you can pay into pensions each year (across all schemes combined) before facing a tax charge. £60,000 standard limit for 2026/27.'],
  ['Tapered Annual Allowance', 'A reduced Annual Allowance for high earners — tapers down to a £10,000 floor if your ‘adjusted income’ exceeds £260,000.'],
  ['Pension Input Amount (PIA)', 'The value HMRC assigns to your pension growth in a year, for Annual Allowance purposes. For DB schemes like the NHS pension, this isn’t just your contributions — it’s roughly 16x the increase in your annual pension.'],
  ['SIPP (Self-Invested Personal Pension)', 'A private, invested pension you control directly, separate from your NHS pension. Same tax relief and access-age rules as other personal pensions.'],
  ['LISA (Lifetime ISA)', 'A tax-free savings account with a 25% government bonus, usable for a first home or from age 60. Can only be opened age 18-39, and you can’t pay in from age 50.'],
  ['S&S ISA (Stocks & Shares ISA)', 'A tax-free, flexible investment account with no access-age restriction — but no government bonus or pension-style tax relief either.'],
  ['GIA (General Investment Account)', 'A taxable investment account, used once you’ve maxed your £20,000/year ISA allowance. Subject to Capital Gains Tax and dividend tax.'],
  ['Old / frozen pension', 'A pension (DB or DC) from a previous employer that you’re no longer contributing to, but which still has value.'],
  ['Drawdown', 'Taking a flexible income directly from an invested pension pot, leaving the rest invested — as opposed to buying a fixed annuity.'],
  ['Annuity', 'A product you can buy with pension savings that pays a guaranteed income for life, in exchange for the pot itself.'],
  ['Commutation', 'Giving up some annual pension in exchange for a bigger tax-free lump sum (usually at a fixed rate, e.g. £12 lump sum per £1 of pension given up).'],
  ['Tax-free lump sum', 'The portion of your pension you can usually take tax-free at retirement — capped by the Lump Sum Allowance (£268,275 for 2026/27).'],
  ['State Pension Age (SPA)', 'The earliest age you can claim the State Pension — currently 66-67 depending on date of birth, rising to 68 in future.'],
  ['Retirement Living Standards', 'Independent benchmarks (Pensions UK / PLSA, researched by Loughborough University) for what different retirement lifestyles cost, from ‘Minimum’ to ‘Comfortable’.'],
  ['Real terms / today’s money', 'Figures adjusted to strip out the effect of future inflation, so they’re comparable to what things cost today rather than being distorted by decades of compounding price rises.'],
  ['Dynamised income / final salary link', 'For GPs, legacy 1995/2008 pension benefits keep growing in real terms (CPI + 1.5%, with a 1.5% floor) right up until you claim them, as long as you don’t have a 5+ year break in NHS pensionable service. Officers get a similar link, but to current pay scales instead.'],
];

function renderGlossaryPanel() {
  return `
    <article class="panel">
      <h2>Glossary</h2>
      <p class="note">This gets complex fast — use this as a quick reference.</p>
      <details class="projection-details">
        <summary>Show glossary (${GLOSSARY_TERMS.length} terms)</summary>
        <div class="table-scroll">
          <table class="reference-table">
            <tr class="reference-table-head"><th>Term</th><th>What it means</th></tr>
            ${GLOSSARY_TERMS.map(([term, def]) => `<tr><td>${term}</td><td data-label="What it means">${def}</td></tr>`).join('')}
          </table>
        </div>
      </details>
    </article>`;
}

const ASSUMPTIONS_SOURCES = [
  ['2015 Scheme accrual rate', '1/54', 'NHS Pension Scheme rules — standard for 2015 CARE scheme'],
  ['2015 Scheme CARE revaluation (REAL)', '1.5% real', 'Scheme rule is CPI + 1.5% nominal — since this model works in today’s money, we use only the +1.5% real element. Source: NHS Pension Scheme regulations'],
  ['Pay growth assumption (REAL)', '1.0% real (illustrative)', 'This is growth ABOVE inflation. Nominal AfC pay awards have varied 2-6%, but much of that has just matched inflation — 0-1.5% real is a reasonable long-run planning range, not a forecast'],
  ['Standard Annual Allowance', '£60,000', '2026/27 HMRC limit'],
  ['Tapered Annual Allowance', 'Down to £10,000 min', 'Applies if ‘adjusted income’ > £260,000: AA reduces £1 for every £2 over the threshold. Toggle on Inputs tab. Source: HMRC pension tax rules — verify each tax year'],
  ['Normal Minimum Pension Age (private pensions)', '57', 'Rising from 55 to 57 from 6 April 2028 — confirm protection rules if relevant'],
  ['LISA contribution cut-off', 'Last eligible year: age 49', 'You cannot pay into a LISA (and get the government bonus) from age 50 onwards, and cannot open a new LISA after age 39. Existing balance keeps growing. Modelled automatically in the Private Pensions Projection tab'],
  ['LISA — future of the product', 'Existing LISAs unaffected; NEW LISAs unavailable from ~April 2028', 'Announced in the Autumn 2025 Budget: the government is replacing the Lifetime ISA with a new ‘First-Time Buyer ISA’ for house-purchase only (no retirement-savings option), expected around April 2028. If you already have a LISA open, none of this changes anything for you — you can keep contributing under the current rules indefinitely. Source: HM Treasury Autumn Budget 2025 / FTB ISA consultation, June 2026'],
  ['LISA access age (no penalty)', '60', 'Withdrawals before 60 (other than first home purchase) incur a 25% government withdrawal charge'],
  ['LISA government bonus', '25%', 'Added on contributions up to £4,000/year — confirm still in payment each year'],
  ['Growth rates — SIPP/LISA/ISA (REAL)', '4.5% real (illustrative)', 'Based on the UBS/Credit Suisse Global Investment Returns Yearbook 2026: world equities have returned ~5.2% real annualised since 1900, though only ~3.5% since 2000. 4.5% is a middle-of-the-road illustrative assumption, not a promise'],
  ['Drawdown assumption', '4% of pot p.a.', 'Common rule-of-thumb, not a recommendation — real plans should model sequencing/order of withdrawals'],
  ['State Pension amount', '£12,547.60 (2026/27 full rate, default)', 'Auto-suggested default — get YOUR real figure from your gov.uk State Pension forecast, as NI record gaps reduce this'],
  ['State Pension Age', 'Calculated from date of birth', 'Applies the legislated bands (66 / 67 / 68) — the 66-to-67 transitional band is simplified to 67; verify your exact date at gov.uk/state-pension-age'],
  ['McCloud remedy', 'Not separately modelled', 'TRS/ABS CARE balances should already reflect the automatic legacy-vs-2015 comparison for the remedy period'],
  ['Drawdown strategy', '4% Safe Withdrawal (default) or Bridge-to-SPA', '‘4%’ assumes the private pot lasts indefinitely. ‘Bridge’ assumes you deliberately spend it down to zero by your State Pension Age. Bridge mode ignores further investment growth during the drawdown years, for simplicity'],
  ['Legacy (1995/2008) Normal Pension Ages', '60 (1995 Section) / 65 (2008 Section)', 'Scenario Summary pays £0 for each legacy section until you reach ITS OWN Normal Pension Age. Taking legacy benefits EARLY (with an actuarial reduction) isn’t modelled'],
  ['Legacy scheme figures', 'Entered directly from TRS/ABS', 'No years/final-pay calculation needed — just copy the ‘Pension’ and ‘Lump Sum’ figures straight from your Annual Benefit Statement’s Standard Benefits table'],
  ['Legacy pension growth (dynamising/final salary link)', '1.5% real p.a. (GP dynamised income)', 'For GPs, legacy 1995/2008 benefits stay ‘final salary linked’ as long as there’s no 5+ year break in NHS pensionable service. Officers are linked to current pay scales instead, which can occasionally undershoot inflation'],
  ['2015 CARE — out-of-date TRS catch-up', 'Assumes ~1 year old by default; extra years auto-corrected', 'The model assumes a TRS/ABS is about a year old. If yours is older, it runs extra catch-up years using your CURRENT pay as a stand-in for the missing years’ pay/accrual'],
  ['Pension Input Amount (Annual Allowance)', '16x accrual (approx)', 'Simplified illustration only — HMRC’s exact DB valuation method also factors in opening-value revaluation'],
  ['NHS Additional Pension (AP)', 'User-entered guaranteed amount', 'Lets 2015 Scheme members buy extra guaranteed, inflation-linked annual pension (up to ~£8,946/yr for 2026/27)'],
  ['NHS AVCs', 'Modelled like SIPP/ISA', 'In-house Additional Voluntary Contributions — invested, not guaranteed. Grows using the same mechanics as SIPP/ISA'],
  ['ERRBO / early retirement reduction', '5% p.a. (illustrative, flat)', 'Early Retirement Reduction Buy Out lets you buy out some/all of the reduction for claiming before Normal Pension Age. NHSBSA’s real reduction factors are non-linear — this model uses a flat illustrative rate'],
  ['Retirement age vs NHS claim age', 'Separate inputs per Scenario', '‘Retirement age’ is when you stop working. ‘NHS pension claim age’ is when you actually start drawing your NHS pension — a separate choice. They default to the same age. Set the claim age later to model deferring your NHS pension claim, with your private pots bridging the gap'],
  ['GIA tax drag', '0.5% (Basic) / 1.0% (Higher) / 1.1% (Additional) real p.a.', 'Illustrative estimate of the annual tax cost of holding investments outside a pension/ISA. Actual drag depends heavily on your asset mix and use of tax-efficient strategies'],
];

function renderAssumptionsPanel() {
  return `
    <article class="panel">
      <h2>Assumptions &amp; Sources</h2>
      <p class="note">This model works entirely in TODAY’S MONEY (real terms). Every growth/revaluation rate is the rate ABOVE inflation, not the total nominal rate.</p>
      <details class="projection-details">
        <summary>Show assumptions table (${ASSUMPTIONS_SOURCES.length} rows)</summary>
        <div class="table-scroll">
          <table class="reference-table">
            <tr class="reference-table-head"><th>Assumption</th><th>Default used</th><th>Source / note</th></tr>
            ${ASSUMPTIONS_SOURCES.map(([a, d, s]) => `<tr><td>${a}</td><td data-label="Default used">${d}</td><td data-label="Source / note">${s}</td></tr>`).join('')}
          </table>
        </div>
      </details>
    </article>`;
}

// ---- Assumptions used (transparency panel) ----------------------------------
// Unlike the static Assumptions & Sources reference panel below (which lists every
// assumption in the model verbatim, regardless of relevance), this one only surfaces
// the assumptions currently governing THIS user's numbers — gated on what they've
// actually disclosed — so it stays short rather than dumping all 11 rows on someone
// who, say, has no GIA.

const ASSUMPTIONS_USED = [
  {
    key: 'legacyRealGrowthRate',
    label: 'How fast your 1995/2008 Section pension grows above inflation until you claim it',
    rationale: 'GPs keep a "dynamised income" link (CPI + 1.5%, with a 1.5% floor) as long as there’s no 5+ year break in NHS pensionable service; in today’s-money terms that’s +1.5% real.',
    relevantWhen: (inputs) => inputs.legacy1995Pension > 0 || inputs.legacy1995LumpSum > 0 || inputs.legacy2008Pension > 0 || inputs.legacy2008LumpSum > 0,
    format: (inputs) => pctFmtPrecise(inputs.legacyRealGrowthRate),
  },
  {
    key: 'payRealGrowthRate',
    label: 'How much your NHS pay is assumed to grow above inflation',
    rationale: 'Nominal pay awards have varied 2-6%, but much of that just tracks inflation — this uses a conservative real-terms planning assumption, not a forecast.',
    relevantWhen: () => true,
    format: (inputs) => pctFmtPrecise(inputs.payRealGrowthRate),
  },
  {
    key: 'careRevaluationRealRate',
    label: 'How fast your 2015 Scheme (CARE) pot grows above inflation',
    rationale: 'The scheme rule is CPI + 1.5% nominal — since everything here is shown in today’s money, only the +1.5% real element is applied.',
    relevantWhen: () => true,
    format: (inputs) => pctFmtPrecise(inputs.careRevaluationRealRate),
  },
  {
    key: 'careAccrualRateDenominator',
    label: '2015 Scheme build-up rate',
    rationale: 'Standard NHS 2015 Scheme accrual — you build up this fraction of that year’s pay as pension, each year.',
    relevantWhen: () => true,
    format: (inputs) => `1/${inputs.careAccrualRateDenominator}`,
  },
  {
    key: 'earlyRetirementReductionRate',
    label: 'Reduction applied for claiming before your Normal Pension Age',
    rationale: 'Illustrative flat rate — NHSBSA’s real reduction factors are non-linear. Any ERRBO years you’ve bought out reduce this automatically.',
    relevantWhen: (inputs, model) => model.scenarioSummary.scenarios.some((s) => s.reductionFactor < 1),
    format: (inputs) => pctFmtPrecise(inputs.earlyRetirementReductionRate),
  },
  {
    key: 'sippGrowthRate',
    label: 'SIPP growth above inflation',
    rationale: 'Illustrative return net of charges, for a diversified (not 100% equity) portfolio — see Assumptions & Sources below for the historical reasoning.',
    relevantWhen: (inputs) => inputs.sippBalance > 0 || inputs.sippContribution > 0,
    format: (inputs) => pctFmtPrecise(inputs.sippGrowthRate),
  },
  {
    key: 'lisaGrowthRate',
    label: 'LISA growth above inflation',
    rationale: 'Illustrative return net of charges, for a diversified (not 100% equity) portfolio — see Assumptions & Sources below for the historical reasoning.',
    relevantWhen: (inputs) => inputs.lisaBalance > 0 || inputs.lisaContribution > 0,
    format: (inputs) => pctFmtPrecise(inputs.lisaGrowthRate),
  },
  {
    key: 'isaGrowthRate',
    label: 'S&S ISA growth above inflation',
    rationale: 'Illustrative return net of charges, for a diversified (not 100% equity) portfolio — see Assumptions & Sources below for the historical reasoning.',
    relevantWhen: (inputs) => inputs.isaBalance > 0 || inputs.isaContribution > 0,
    format: (inputs) => pctFmtPrecise(inputs.isaGrowthRate),
  },
  {
    key: 'giaGrowthRateGross',
    label: 'GIA growth above inflation, and tax drag',
    rationale: 'Growth is pre-tax; a tax drag is then deducted based on your marginal tax band, to approximate the ongoing cost of holding investments outside a pension/ISA.',
    relevantWhen: (inputs) => inputs.giaBalance > 0 || inputs.giaContribution > 0,
    format: (inputs) => `${pctFmtPrecise(inputs.giaGrowthRateGross)} gross, ${pctFmtPrecise(inputs.giaTaxDrag)} tax drag`,
  },
  {
    key: 'standardAnnualAllowance',
    label: 'Standard Annual Allowance',
    rationale: 'The most you can pay into pensions each year, across all schemes, before a tax charge applies.',
    relevantWhen: () => true,
    format: (inputs) => money(inputs.standardAnnualAllowance),
  },
  {
    key: 'estimatedStatePensionAnnual',
    label: 'Estimated State Pension',
    rationale: 'Defaulted to the full new State Pension rate — gaps in your National Insurance record would reduce your real figure, so check your gov.uk forecast.',
    relevantWhen: () => true,
    format: (inputs) => money(inputs.estimatedStatePensionAnnual),
  },
];

function focusField(name) {
  const el = form.elements[name];
  if (!el) return;
  // Advanced-only assumption fields (SIPP growth, legacy growth rate, etc.) aren't
  // part of the guided quick-start, so they're hidden in Guided mode — jump to
  // Advanced mode first so the "Edit this" control actually lands somewhere visible.
  if (currentMode !== 'advanced') setMode('advanced');
  const details = el.closest('details');
  if (details && !details.open) details.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
  el.classList.add('field-highlight');
  setTimeout(() => el.classList.remove('field-highlight'), 1500);
}

function renderAssumptionsUsedPanel(inputs, model) {
  const items = ASSUMPTIONS_USED.filter((a) => a.relevantWhen(inputs, model));
  return `
    <article class="panel">
      <h2>Assumptions used</h2>
      <details class="projection-details assumptions-used-panel">
        <summary>Show what's being assumed for you (${items.length})</summary>
        <ul class="assumptions-used-list">
          ${items.map((a) => `
            <li class="assumptions-used-row">
              <div class="assumptions-used-main">
                <span class="assumptions-used-label">${a.label}</span>
                <span class="assumptions-used-value">${a.format(inputs)}</span>
              </div>
              <p class="assumptions-used-rationale">${a.rationale}</p>
              <button type="button" class="assumptions-used-edit" data-edit-field="${a.key}">Edit this</button>
            </li>`).join('')}
        </ul>
      </details>
    </article>`;
}

function renderAdvancedResults(model, inputs) {
  const scenarioCards = model.scenarioSummary.scenarios
    .map((s, i) => renderScenarioCard(s, i, model, inputs))
    .join('');

  resultsEl.innerHTML = `
    <section class="scenario-grid">${scenarioCards}</section>
    ${renderAssumptionsUsedPanel(inputs, model)}
    ${renderTargetIncome(model.targetIncomeCalculator)}
    ${renderAnnualAllowance(model.annualAllowance)}
    <article class="panel">
      <h2>Year-by-year detail</h2>
      ${renderProjectionTable('2015 CARE Projection', model.care.years, [
        ['taxYear', 'Tax year'], ['age', 'Age'], ['pensionablePay', 'Pay'],
        ['accrualAdded', 'Accrual added'], ['closingPot', 'Closing pot'],
      ])}
      ${renderProjectionTable('Private Pensions Projection', model.privatePensions.years, [
        ['taxYear', 'Tax year'], ['age', 'Age'], ['sipp', 'SIPP'], ['lisa', 'LISA'],
        ['isa', 'ISA'], ['avc', 'AVC'], ['gia', 'GIA'], ['combinedTotal', 'Combined total'],
      ])}
    </article>
    ${renderRetirementLivingStandardsPanel(model)}
    ${renderGlossaryPanel()}
    ${renderAssumptionsPanel()}
    <p class="footer-note">Current age: ${model.personal.currentAge} · State Pension Age: ${model.personal.statePensionAge}</p>
  `;
}

// Headline: two derived ages, income if you stop work and claim NHS pension at the
// same age. No scenario comparison, no tables — see §6 of the guided-rework brief:
// "lead with the headline number(s), not a table." Lives in its own sticky bar
// (#guidedHeadlineBar, outside the two-column layout) rather than inside #results,
// so it stays pinned above the wizard as the user scrolls through it — on mobile in
// particular, the input/results columns stack and neither is otherwise sticky.
function renderGuidedHeadlineBar(headlineModel) {
  const bar = document.getElementById('guidedHeadlineBar');
  if (currentMode !== 'guided') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  const [s1, s2] = headlineModel.scenarioSummary.scenarios;
  const item = (s) => `
    <div class="headline-item">
      <div class="headline-age">From age ${s.retirementAge}</div>
      <div class="headline-amount">${money(s.totalIncomeFromClaimAge)}<span>/yr</span></div>
    </div>`;
  const caveat = anyNotSure()
    ? `<p class="headline-note headline-caveat">This may be incomplete — you answered "Not sure" to something that could change it. Come back and update it once you know.</p>`
    : `<p class="headline-note">In today's money, based on what you've told us so far.</p>`;
  bar.innerHTML = `
    <section class="headline-panel">
      ${item(s1)}
      ${item(s2)}
    </section>
    ${caveat}`;
}

function renderGuidedResults(model, inputs) {
  // Scenario comparison only appears once the user has asked for it via the wizard
  // (§6: "Show scenario comparison only when the user has asked for it").
  const wantsComparison = wizardState.answers.compareAges === 'yes';
  const scenarioCards = wantsComparison
    ? `<section class="scenario-grid">${model.scenarioSummary.scenarios
        .map((s, i) => renderScenarioCard(s, i, model, inputs)).join('')}</section>`
    : '';
  resultsEl.innerHTML = `
    ${scenarioCards}
    ${renderAssumptionsUsedPanel(inputs, model)}
    ${renderTargetIncome(model.targetIncomeCalculator)}
    ${renderRetirementLivingStandardsPanel(model)}
    ${renderGlossaryPanel()}
    ${renderAssumptionsPanel()}
  `;
}

function render(model, headlineModel, inputs) {
  renderGuidedHeadlineBar(headlineModel);
  if (currentMode === 'guided') {
    renderGuidedResults(model, inputs);
  } else {
    renderAdvancedResults(model, inputs);
  }
}

// ---- field notes (hover tooltips) ------------------------------------------
// Mirrors the explanatory notes in column C of the workbook's Inputs tab.
// A single shared tooltip element is appended to <body> so it's never clipped
// by the scrollable inputs panel.

const tooltipEl = document.createElement('div');
tooltipEl.className = 'field-tooltip';
document.body.appendChild(tooltipEl);

function showTooltip(target) {
  const note = target.dataset.note;
  if (!note) return;
  tooltipEl.textContent = note;
  tooltipEl.style.display = 'block';

  const rect = target.getBoundingClientRect();
  const margin = 8;
  let left = rect.left;
  let top = rect.bottom + margin;

  const maxLeft = window.innerWidth - tooltipEl.offsetWidth - margin;
  if (left > maxLeft) left = Math.max(margin, maxLeft);
  if (top + tooltipEl.offsetHeight > window.innerHeight - margin) {
    top = rect.top - tooltipEl.offsetHeight - margin;
  }

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  tooltipEl.style.display = 'none';
}

form.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[data-note]');
  if (target) showTooltip(target);
});
form.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-note]')) hideTooltip();
});
form.addEventListener('focusin', (e) => {
  const target = e.target.closest('label')?.matches('[data-note]') ? e.target.closest('label') : null;
  if (target) showTooltip(target);
});
form.addEventListener('focusout', () => hideTooltip());

// ---- update loop --------------------------------------------------------------

function update() {
  // Order matters: wizard answers determine which fields are revealed, guided-mode
  // visibility then hides/shows whole fieldsets, and conditional-field visibility
  // (DB/DC subfields etc.) refines within whatever is currently shown — reversed,
  // advanced mode's reset would clobber the conditionals.
  recomputeRevealed();
  applyGuidedVisibility();
  refreshConditionalFields();
  renderWizard();
  const inputs = readInputs();
  const model = CalcEngine.runModel(inputs, new Date());
  const headlineModel = currentMode === 'guided' ? buildHeadlineModel(inputs, model) : null;
  render(model, headlineModel, inputs);
  saveFormToStorage();
}

form.addEventListener('input', update);
form.addEventListener('change', update);

resultsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit-field]');
  if (btn) focusField(btn.dataset.editField);
});

update();
