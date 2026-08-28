/**
 * HUSLLYFE shared module.
 * Inlined directly into every page (each page has its own copy in a
 * <script> tag) so the site works from a single static file, no
 * external asset loading required. Exposes a single global: window.HUSLLYFE
 *
 * Storage strategy:
 *   This site is now genuinely multi-page (separate .html files navigated
 *   via real <a href> links), not a single-file Claude artifact. Claude's
 *   window.storage API is scoped to a live artifact preview and is not
 *   guaranteed to persist across a real browser navigation to a different
 *   document, so this module tries window.storage first (useful while
 *   previewing inside Claude) and falls back to localStorage (the correct,
 *   standard tool for a real static multi-page site) whenever
 *   window.storage is unavailable or fails. localStorage requires the
 *   files to be served over http(s) rather than opened directly via
 *   file:// in some browsers — see the site's README.
 */
(function (global) {
  'use strict';

  // Storage layout
  //   husllyfe.profiles      -> { version, activeId, profiles: [{id,name,created}] }
  //   husllyfe.state.<id>    -> one profile's state blob
  //
  // LEGACY_KEY is the single-profile key this app used before profiles existed.
  // It is read once to seed the first profile and then deliberately LEFT IN
  // PLACE as a free backup — never deleted.
  var LEGACY_KEY   = 'huslllyfe-state-v1';
  var PROFILES_KEY = 'husllyfe.profiles';
  var STATE_PREFIX = 'husllyfe.state.';
  var EXPORT_FORMAT = 1;

  function stateKey(id) { return STATE_PREFIX + id; }
  function newId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  var profiles = { version: 1, activeId: null, profiles: [] };

  // Nothing here is a measurement. Every field a user could supply starts
  // empty or null, because a seeded number is indistinguishable from an
  // earned one once it is painted onto a dial. The worked example lives in
  // loadDemoData(), which labels itself and can be wiped in one click.
  var DEFAULTS = {
    // consistency / cardio / activity are NOT stored — they are derived from
    // `sessions` on every read. Only what a log entry cannot tell us is manual,
    // and manual starts null rather than at a plausible-looking default.
    body: { recovery: null, goal: 'strength', weeklyDays: 4 },
    sessions: [],
    wealth: { contributions: 0, dividend: 0, years: 1, benchmark: 8, pattern: 'spread',
              income: 0, monthlyCommit: 0, monthlyExpenses: 0, cashMonths: 6,
              savingsTarget: 0.15 },
    deposits: [],   // dated contributions — the Wealth twin of `sessions`
    history: [],    // one dated snapshot of the four scores per day
    accounts: [],
    manualAssets: [],
    vehicles: [],
    lifts: null   // filled by freshLifts() below, which needs DEFAULT_MOVEMENTS
  };

  // ---------------------------------------------------------------------
  // training log
  // ---------------------------------------------------------------------
  // Cardio is a load measure: recent weeks are what matter, so it stays on a
  // fortnight. Consistency and strength-days are adherence measures, and a
  // 14-day denominator makes one holiday look like collapse — which trains
  // people to stop opening the app exactly when you most want them back.
  var TRAINING_WINDOW_DAYS = 14;
  var ADHERENCE_WINDOW_DAYS = 28;
  var WEEKLY_MINUTES_TARGET = 150;   // WHO/CDC moderate-intensity AEROBIC guideline
  var WEEKLY_STRENGTH_DAYS = 2;      // the other half of the same guideline
  var DEFAULT_TRAINING_DAYS = 4;     // used until the user states a commitment

  /** Days per week the user has committed to. Absolute, but theirs. */
  function trainingCommitment() {
    var d = Number(state.body && state.body.weeklyDays);
    if (!(d > 0)) d = Number(state.setup && state.setup.trainingDays);
    if (!(d > 0)) d = DEFAULT_TRAINING_DAYS;
    return clamp(Math.round(d), 1, 7);
  }

  var SESSION_TYPES = [
    { id: 'strength', label: 'Strength Training',   kind: 'strength' },
    { id: 'run',      label: 'Run',                 kind: 'cardio' },
    { id: 'cycle',    label: 'Cycling',             kind: 'cardio' },
    { id: 'walk',     label: 'Walk / Hike',         kind: 'cardio' },
    { id: 'swim',     label: 'Swim',                kind: 'cardio' },
    { id: 'row',      label: 'Rowing',              kind: 'cardio' },
    { id: 'hiit',     label: 'HIIT / Conditioning', kind: 'cardio' },
    { id: 'sport',    label: 'Sport',               kind: 'cardio' },
    { id: 'mobility', label: 'Mobility / Stretch',  kind: 'other' }
  ];
  var INTENSITIES = [
    { id: 'easy',     label: 'Easy',     weight: 0.75 },
    { id: 'moderate', label: 'Moderate', weight: 1.00 },
    { id: 'hard',     label: 'Hard',     weight: 1.50 }
  ];
  function sessionType(id) {
    for (var i = 0; i < SESSION_TYPES.length; i++) if (SESSION_TYPES[i].id === id) return SESSION_TYPES[i];
    return SESSION_TYPES[0];
  }
  function intensity(id) {
    for (var i = 0; i < INTENSITIES.length; i++) if (INTENSITIES[i].id === id) return INTENSITIES[i];
    return INTENSITIES[1];
  }

  var GOAL_WEIGHTS = {
    strength:  { consistency: 0.25, strength: 0.30, recovery: 0.15, cardio: 0.10, strengthDays: 0.20 },
    longevity: { consistency: 0.30, strength: 0.15, recovery: 0.25, cardio: 0.15, strengthDays: 0.15 },
    fatloss:   { consistency: 0.30, strength: 0.15, recovery: 0.15, cardio: 0.25, strengthDays: 0.15 },
    cardio:    { consistency: 0.25, strength: 0.10, recovery: 0.20, cardio: 0.35, strengthDays: 0.10 }
  };
  var GOAL_LABELS = { strength: 'Strength', longevity: 'Longevity', fatloss: 'Fat Loss', cardio: 'Cardio' };

  var state = JSON.parse(JSON.stringify(DEFAULTS));   // lifts filled by loadState/freshState
  var STORAGE_LIMIT_BYTES = 5 * 1024 * 1024;

  // ---------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function money(v) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v) || 0); }
  function numberFmt(v) { return new Intl.NumberFormat('en-US').format(Number(v) || 0); }
  function pct(v) { var s = (v >= 0 ? '+' : ''); return s + v.toFixed(1) + '%'; }
  function estimateBytes(obj) {
    try { return new TextEncoder().encode(JSON.stringify(obj)).length; }
    catch (e) { return JSON.stringify(obj).length; }
  }

  // ---------------------------------------------------------------------
  // storage: window.storage (Claude artifact) with localStorage fallback
  // (the fallback is required for this to function as a real multi-page
  // site with working navigation outside of a single-artifact preview)
  // ---------------------------------------------------------------------
  var hasWindowStorage = typeof global.storage !== 'undefined';
  var hasLocalStorage = (function () {
    try { var k = '__huslllyfe_test__'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; }
    catch (e) { return false; }
  })();

  function storageGet(key) {
    if (hasWindowStorage) {
      return global.storage.get(key, false).catch(function () { return fallbackGet(key); });
    }
    return fallbackGet(key);
  }
  function fallbackGet(key) {
    if (!hasLocalStorage) return Promise.reject(new Error('no_storage'));
    var raw = localStorage.getItem(key);
    if (raw === null) return Promise.reject(new Error('not_found'));
    return Promise.resolve({ key: key, value: raw, shared: false });
  }
  function storageSet(key, value) {
    if (hasWindowStorage) {
      return global.storage.set(key, value, false).then(function (res) {
        // also mirror to localStorage as a belt-and-suspenders fallback
        if (hasLocalStorage) { try { localStorage.setItem(key, value); } catch (e) {} }
        return res;
      }).catch(function () { return fallbackSet(key, value); });
    }
    return fallbackSet(key, value);
  }
  function fallbackSet(key, value) {
    if (!hasLocalStorage) return Promise.resolve(null);
    try { localStorage.setItem(key, value); return Promise.resolve({ key: key, value: value, shared: false }); }
    catch (e) { return Promise.resolve(null); }
  }
  function storageDelete(key) {
    var p1 = hasWindowStorage ? global.storage.delete(key, false).catch(function () {}) : Promise.resolve();
    return p1.then(function () {
      if (hasLocalStorage) { try { localStorage.removeItem(key); } catch (e) {} }
    });
  }

  // ---------------------------------------------------------------------
  // calculations (identical math across every page)
  // ---------------------------------------------------------------------
  // -- training log -> body inputs --------------------------------------
  // Dates are plain 'YYYY-MM-DD' local strings, so windowing is string
  // comparison and no timezone can shift a session onto the wrong day.
  function dayKey(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function todayKey() { return dayKey(new Date()); }
  function windowStartKey() {
    return dayKey(new Date(Date.now() - (TRAINING_WINDOW_DAYS - 1) * 86400000));
  }
  /** Sessions inside the rolling window, newest first. Future dates excluded. */
  function recentSessions() {
    var from = windowStartKey(), to = todayKey();
    return (state.sessions || [])
      .filter(function (s) { return s.date >= from && s.date <= to; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  }

  /**
   * The three metrics the training log can actually evidence.
   *
   *   consistency   days trained vs the days YOU committed to, over 28 days
   *   cardio        weighted aerobic minutes vs 150/wk, over 14 days
   *   strengthDays  days with a strength session vs 2/wk, over 28 days
   *
   * Consistency is graded against a commitment rather than a constant or a
   * rolling average. A constant says seven days a week is the only A, which is
   * overtraining. An average quietly redefines success downward every time you
   * slack. A commitment is absolute — it does not move when you miss — but it
   * is yours to set.
   *
   * cardio and strengthDays are the two halves of the published guideline and
   * are deliberately disjoint: minutes are counted for one, days for the other,
   * so a runner and a lifter do not both light up the same input twice.
   */
  function metricsOver(fromKey, toKey, adherenceDays, loadDays) {
    var rows = (state.sessions || []).filter(function (s) {
      return s.date >= fromKey && s.date <= toKey;
    });

    var days = {}, strengthDayMap = {}, cardioLoad = 0, totalMinutes = 0;
    var loadFrom = shiftDays(toKey, -(loadDays - 1));

    rows.forEach(function (s) {
      var mins = Math.max(0, Number(s.duration) || 0);
      days[s.date] = true;
      totalMinutes += mins;
      var t = sessionType(s.type);
      if (t.kind === 'strength') strengthDayMap[s.date] = true;
      // Cardio load only counts the recent window, even though adherence
      // looks further back.
      if (t.kind === 'cardio' && s.date >= loadFrom) {
        cardioLoad += mins * intensity(s.intensity).weight;
      }
    });

    var committed = trainingCommitment();
    var adherenceWeeks = adherenceDays / 7;
    var loadWeeks = loadDays / 7;
    var activeDays = Object.keys(days).length;
    var strengthDayCount = Object.keys(strengthDayMap).length;

    return {
      consistency:  clamp(Math.round(activeDays / (committed * adherenceWeeks) * 100), 0, 100),
      cardio:       clamp(Math.round((cardioLoad / loadWeeks) / WEEKLY_MINUTES_TARGET * 100), 0, 100),
      strengthDays: clamp(Math.round(strengthDayCount / (WEEKLY_STRENGTH_DAYS * adherenceWeeks) * 100), 0, 100),
      // evidence, so every number above can be checked by eye
      activeDays: activeDays,
      committedDays: committed,
      expectedDays: Math.round(committed * adherenceWeeks),
      strengthDayCount: strengthDayCount,
      expectedStrengthDays: Math.round(WEEKLY_STRENGTH_DAYS * adherenceWeeks),
      sessionCount: rows.length,
      totalMinutes: Math.round(totalMinutes),
      cardioMinutes: Math.round(cardioLoad),
      weeklyCardio: Math.round(cardioLoad / loadWeeks),
      adherenceDays: adherenceDays,
      loadDays: loadDays,
      weeklyTarget: WEEKLY_MINUTES_TARGET
    };
  }

  function derivedBody() {
    return metricsOver(shiftDays(todayKey(), -(ADHERENCE_WINDOW_DAYS - 1)), todayKey(),
                       ADHERENCE_WINDOW_DAYS, TRAINING_WINDOW_DAYS);
  }

  /**
   * The same three metrics over the window immediately before this one.
   * Direction is the useful thing to show a user — "up from 48" tells you
   * something a static average does not.
   */
  function bodyTrend() {
    if (!(state.sessions || []).length) return null;
    var prevEnd = shiftDays(todayKey(), -ADHERENCE_WINDOW_DAYS);
    var prevStart = shiftDays(prevEnd, -(ADHERENCE_WINDOW_DAYS - 1));
    var prev = metricsOver(prevStart, prevEnd, ADHERENCE_WINDOW_DAYS, TRAINING_WINDOW_DAYS);
    if (!prev.sessionCount) return null;
    var now = derivedBody();
    return {
      windowDays: ADHERENCE_WINDOW_DAYS,
      consistency:  { now: now.consistency,  prev: prev.consistency,  delta: now.consistency - prev.consistency },
      cardio:       { now: now.cardio,       prev: prev.cardio,       delta: now.cardio - prev.cardio },
      strengthDays: { now: now.strengthDays, prev: prev.strengthDays, delta: now.strengthDays - prev.strengthDays }
    };
  }

  function bodyInputs() {
    var d = derivedBody();
    var consistency = d.consistency, cardio = d.cardio, strengthDays = d.strengthDays;

    // Before there is a log to measure, project what the stated commitment
    // would score if it were kept. The UI labels this provisional — it is a
    // projection, not something earned. See bodyIsProvisional().
    if (bodyIsProvisional()) {
      var days = clamp(Number(state.setup.trainingDays) || 0, 0, 7);
      var committed = trainingCommitment();
      consistency  = clamp(Math.round(days / committed * 100), 0, 100);
      // Unknown split, so assume half the sessions are strength and the rest
      // aerobic at a plausible 45 minutes.
      strengthDays = clamp(Math.round((days * 0.5) / WEEKLY_STRENGTH_DAYS * 100), 0, 100);
      cardio       = clamp(Math.round((days * 0.5 * 45) / WEEKLY_MINUTES_TARGET * 100), 0, 100);
    }
    return {
      consistency: consistency,
      // null until the Strength page has a baseline and a lift beyond it.
      // bodyScore() reweights around it rather than inventing a number.
      strength: strengthProgress(),
      recovery: state.body.recovery,
      cardio: cardio,
      strengthDays: strengthDays
    };
  }

  /**
   * Weighted across the five inputs — but rescaled over only the ones that
   * have data, the same way overallScore() handles an engine with nothing in
   * it. Strength Progress is null until the Strength page has a baseline and
   * a lift beyond it, and a missing input should redistribute its weight
   * rather than quietly score zero or invent a default.
   */
  function bodyScore() {
    var b = bodyInputs();
    var w = GOAL_WEIGHTS[state.body.goal] || GOAL_WEIGHTS.strength;
    var parts = ['consistency', 'strength', 'recovery', 'cardio', 'strengthDays']
      .map(function (k) { return { weight: w[k], score: b[k] }; })
      .filter(function (p) { return !isEmptyScore(p.score); });

    var totalWeight = parts.reduce(function (a, p) { return a + p.weight; }, 0);
    if (!totalWeight) return 0;
    var weighted = parts.reduce(function (a, p) { return a + p.score * p.weight; }, 0);
    return clamp(Math.round(weighted / totalWeight), 0, 100);
  }

  /** Which Body inputs are actually contributing, for the formula readout. */
  function bodyActiveWeights() {
    var b = bodyInputs();
    var w = GOAL_WEIGHTS[state.body.goal] || GOAL_WEIGHTS.strength;
    var keys = ['consistency', 'strength', 'recovery', 'cardio', 'strengthDays'];
    var total = keys.reduce(function (a, k) { return a + (isEmptyScore(b[k]) ? 0 : w[k]); }, 0) || 1;
    var out = {};
    keys.forEach(function (k) { out[k] = isEmptyScore(b[k]) ? 0 : w[k] / total; });
    return out;
  }

  // -- session CRUD ------------------------------------------------------
  function addSession(entry) {
    var s = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      date: entry.date || todayKey(),
      type: sessionType(entry.type).id,
      duration: clamp(Math.round(Number(entry.duration) || 0), 1, 1440),
      intensity: intensity(entry.intensity).id
    };
    state.sessions.unshift(s);
    state.sessions.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    scheduleSave();
    return s;
  }
  function removeSession(id) {
    state.sessions = (state.sessions || []).filter(function (s) { return s.id !== id; });
    scheduleSave();
  }
  function accountsTotal() {
    return (state.accounts || []).reduce(function (sum, a) { return sum + (Number(a.value) || 0); }, 0);
  }
  function manualAssetsTotal() {
    return (state.manualAssets || []).reduce(function (sum, a) { return sum + (Number(a.value) || 0); }, 0);
  }
  /**
   * How the contributions arrived. This matters more than it looks.
   *
   * The old model raised (portfolio / contributions) to the power of 1/years,
   * which silently assumes every dollar was deposited on day one. Almost
   * nobody invests that way, and the error is not small: contribute $50,000 a
   * year for six years into a fund genuinely returning 10% and you finish with
   * $424,359 — which that formula reports as 6.0% and the score marks 43, in
   * red, for a perfectly good decade. Money you only put in last year has not
   * had six years to compound and must not be measured as though it had.
   *
   * 'spread' solves for the rate at which level annual contributions actually
   * reach the balance. For evenly-spaced equal deposits that IS the internal
   * rate of return, so this is a real money-weighted figure, not an
   * adjustment factor — and it needs nothing from the user beyond which of
   * the two patterns describes them.
   */
  var CONTRIB_PATTERNS = ['spread', 'lump'];
  function contributionPattern() {
    return (state.wealth && state.wealth.pattern === 'lump') ? 'lump' : 'spread';
  }

  /**
   * Rate r where `years` level annual deposits of (total/years), each
   * compounding for the rest of the term, sum to `future`.
   *
   *   Σ deposit × (1+r)^i  for i = 1..years  =  future
   *
   * Bisection rather than a closed form: the annuity equation has no general
   * algebraic solution and bisection cannot diverge the way Newton can on the
   * flat, near-zero-return end where plenty of real portfolios sit.
   */
  function annuityRate(total, future, years) {
    if (!(total > 0) || !(years > 0)) return 0;
    var deposit = total / years;
    function fv(r) {
      var sum = 0;
      for (var i = 1; i <= years; i++) sum += deposit * Math.pow(1 + r, i);
      return sum;
    }
    var lo = -0.95, hi = 10;                 // -95%/yr to +1000%/yr
    if (fv(hi) < future) return hi * 100;    // beyond anything worth modelling
    if (fv(lo) > future) return lo * 100;
    for (var n = 0; n < 200; n++) {
      var mid = (lo + hi) / 2;
      if (fv(mid) < future) lo = mid; else hi = mid;
    }
    return ((lo + hi) / 2) * 100;
  }

  function wealthMetrics() {
    var w = state.wealth;
    var portfolioValue = accountsTotal();
    var contributions = Number(w.contributions) || 0;
    var gain = portfolioValue - contributions;
    var totalReturn = contributions > 0 ? (gain / contributions * 100) : 0;
    var years = Math.max(w.years || 1, 1);
    var pattern = contributionPattern();
    var annualized;
    if (contributions <= 0) {
      annualized = totalReturn;
    } else if (pattern === 'lump') {
      // Everything invested at the start: straight compound growth rate.
      annualized = (Math.pow(Math.max(portfolioValue, 1) / contributions, 1 / years) - 1) * 100;
    } else {
      annualized = annuityRate(contributions, Math.max(portfolioValue, 0), years);
    }
    return {
      portfolioValue: portfolioValue,
      gain: gain,
      totalReturn: totalReturn,
      annualized: annualized,
      pattern: pattern,
      years: years
    };
  }
  // ---------------------------------------------------------------------
  // Wealth v2 — grading the decisions, not the market
  //
  // v1 scored return against a benchmark: 50 meant "matched the market",
  // 90 meant "beat it by four points a year, every year". Body and Drive
  // grade something else entirely — did you keep the commitment you set, did
  // you service the car — both of which are inside the user's control, and
  // both of which pay out in the 90s for ordinary good behaviour. Averaging
  // an effort score with an outcome score assumes 70 means the same thing in
  // each, and it does not: a person training as promised, servicing one
  // sensible car and holding an index fund that returned exactly the market
  // average scored BODY 89 / WEALTH 50 / DRIVE 100, and the composite told
  // him his money was the problem. Nothing about that person needed fixing.
  //
  // So Wealth now grades what an investor actually decides:
  //
  //   Savings Rate            what you put in, against the 15% guideline —
  //                           the absolute standard, like WHO's 150 min/wk
  //   Contribution Consistency what you put in against what YOU committed to —
  //                           the personal bar, like Body's days-per-week
  //
  // Return against benchmark is still computed and still shown, but as a
  // context line, never as a grade. Same treatment Body gives direction:
  // worth knowing, not the user's fault, not part of the mark.
  // ---------------------------------------------------------------------
  // The published guideline, and the floor. You may raise your own bar; you
  // may not lower it below the standard everyone is measured against.
  //
  // This differs on purpose from Body's days-per-week, which you can set to
  // one. Training frequency has no universal number — seven days a week is
  // overtraining and the right figure is personal. Saving 15% of gross IS a
  // published standard, the same kind of thing as 150 minutes of cardio a
  // week, and Body does not let you talk that one down either.
  //
  // It became settable because a fixed 15% goes deaf at the top: someone
  // saving 25% of $400,000 and someone saving 15% of $150,000 both peg at a
  // permanent 100, so the heaviest Wealth input stops moving for anyone who
  // earns well. A target you set keeps the gauge alive at any income.
  var SAVINGS_RATE_TARGET = 0.15;    // the standard 15%-of-gross guideline
  var SAVINGS_TARGET_MAX  = 0.60;
  var CONTRIB_WINDOW_DAYS = 365;
  // Expense ratios, in percent. At or under the target is full marks — index
  // funds live at 0.03–0.10 and plenty of decent workplace funds at 0.15, so
  // the target is a threshold to clear, not a race to zero. The zero point is
  // where a fund is taking more than a fifth of a long-run real return.
  var ER_TARGET = 0.20;
  var ER_ZERO   = 1.20;
  // Cash beyond an emergency fund is the classic discipline failure and
  // nothing in the app noticed it. Cash UP TO the fund is not a failure at
  // all, so the target is subtracted before anything is charged.
  var DEFAULT_CASH_MONTHS = 6;
  // Nobody's living expenses are $0.00. Treating an unset figure as zero
  // sized the emergency fund at zero, which read every dollar of cash as idle
  // and made the meter unscoreable rather than merely imprecise. A floor is
  // the conservative direction, not a flattering one: a smaller assumed fund
  // means MORE cash counts as excess, so the assumption can only cost points,
  // never hand them out. Anything the user enters replaces it.
  var MIN_MONTHLY_EXPENSES = 1500;
  var WEALTH_WEIGHTS = {
    savingsRate:   0.35,   // what goes in — still the biggest lever
    consistency:   0.30,   // whether it keeps going in
    investedShare: 0.20,   // whether it is actually working once in
    costDrag:      0.15    // what it costs to hold
  };
  var WEALTH_KEYS = ['savingsRate', 'consistency', 'investedShare', 'costDrag'];

  function deposits() {
    return (state.deposits || []).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
    });
  }
  function addDeposit(entry) {
    var row = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      date: entry.date || todayKey(),
      amount: Math.max(0, Math.round(Number(entry.amount) || 0)),
      note: (entry.note || '').slice(0, 120)
    };
    if (!Array.isArray(state.deposits)) state.deposits = [];
    state.deposits.push(row);
    scheduleSave();
    return row;
  }
  function removeDeposit(id) {
    state.deposits = (state.deposits || []).filter(function (r) { return r.id !== id; });
    scheduleSave();
  }
  function monthlyCommitment() { return Math.max(0, Number(state.wealth && state.wealth.monthlyCommit) || 0); }
  /** The share of gross this user is holding themselves to. Never below 15%. */
  function savingsTarget() {
    var t = Number(state.wealth && state.wealth.savingsTarget);
    if (!(t > 0)) return SAVINGS_RATE_TARGET;
    return clamp(t, SAVINGS_RATE_TARGET, SAVINGS_TARGET_MAX);
  }
  function savingsTargetIsRaised() { return savingsTarget() > SAVINGS_RATE_TARGET + 1e-9; }
  function grossIncome() { return Math.max(0, Number(state.wealth && state.wealth.income) || 0); }

  /**
   * Contributions in the trailing twelve months, plus the denominators the
   * two scores need.
   *
   * The consistency denominator counts months since the FIRST logged deposit,
   * capped at twelve — not a flat twelve. Body can use a fixed 28-day window
   * because a new user is caught up inside a month; charging someone twelve
   * months of missed contributions for a log they started in March is a
   * different thing entirely. This does not soften when you slack: once a
   * month has passed it stays in the denominator forever, so a missed month
   * still costs you. It just does not bill you for months before you began.
   */
  function contributionMetrics() {
    var rows = deposits();
    var from = shiftDays(todayKey(), -(CONTRIB_WINDOW_DAYS - 1));
    var window = rows.filter(function (r) { return r.date >= from && r.date <= todayKey(); });
    var contributed = window.reduce(function (a, r) { return a + r.amount; }, 0);

    // Minimum of one month, even with an empty log. An empty month is a real
    // month in which nothing was contributed — the same way an empty training
    // week is a real week in which nobody trained — so it belongs in the
    // denominator rather than making the whole measurement undefined.
    var monthsLogging = 1;
    if (rows.length) {
      var first = rows[rows.length - 1].date;
      monthsLogging = clamp(Math.ceil(daysBetween(first, todayKey()) / 30.44) || 1, 1, 12);
    }
    var commit = monthlyCommitment();
    var income = grossIncome();
    return {
      contributed: contributed,
      entries: window.length,
      totalEntries: rows.length,
      monthsLogging: monthsLogging,
      monthlyCommit: commit,
      committedInWindow: commit * monthsLogging,
      committedAnnual: commit * 12,
      income: income,
      // Actual rate over the trailing year, and the rate the commitment implies.
      actualRate: income > 0 ? contributed / income : null,
      // What the gauge is ACTUALLY built from: a partial year scaled up to a
      // full one. The readout must quote this rather than actualRate — one
      // month of $2,500 on a $200,000 income scores 100 (a 15% annual pace)
      // while the raw figure is 1.3%, and showing the raw figure next to a
      // 100 makes the gauge look broken.
      annualisedRate: income > 0 ? (contributed * (12 / monthsLogging)) / income : null,
      committedRate: income > 0 && commit > 0 ? (commit * 12) / income : null,
      // Under a full year of log, the savings rate is an annualised
      // projection of a partial year rather than a measured one. The UI says
      // so — the same treatment Body gives a provisional score built from a
      // stated training frequency instead of a real log.
      provisional: rows.length > 0 && monthsLogging < 12,
      target: savingsTarget(),
      guideline: SAVINGS_RATE_TARGET,
      targetRaised: savingsTargetIsRaised(),
      windowDays: CONTRIB_WINDOW_DAYS
    };
  }

  /**
   * Liquid money, split by whether it is working.
   *
   * Only LIQUID holdings are in scope: investment accounts plus anything the
   * user has flagged as cash in either ledger. Illiquid manual assets — a
   * house, a private business — sit outside this measure entirely rather than
   * being counted as "invested", because the question here is whether the
   * money you could deploy is deployed, and home equity is not deployable.
   */
  function cashRows() {
    return (state.accounts || []).concat(state.manualAssets || [])
      .filter(function (r) { return !!r.cash; });
  }
  function cashTotal() {
    return cashRows().reduce(function (a, r) { return a + (Number(r.value) || 0); }, 0);
  }
  function investedAccounts() {
    return (state.accounts || []).filter(function (a) { return !a.cash; });
  }
  function investedTotal() {
    return investedAccounts().reduce(function (a, r) { return a + (Number(r.value) || 0); }, 0);
  }
  function cashMonthsTarget() {
    var m = Number(state.wealth && state.wealth.cashMonths);
    return m > 0 ? m : DEFAULT_CASH_MONTHS;
  }
  /** What the user entered, before the floor is applied. */
  function statedMonthlyExpenses() {
    return Math.max(0, Number(state.wealth && state.wealth.monthlyExpenses) || 0);
  }
  /** What the emergency fund is actually sized from. Never below the floor. */
  function monthlyExpenses() {
    return Math.max(statedMonthlyExpenses(), MIN_MONTHLY_EXPENSES);
  }
  /** True when the floor is doing the work rather than a figure the user gave. */
  function usingExpenseFloor() {
    return statedMonthlyExpenses() < MIN_MONTHLY_EXPENSES;
  }

  function investedShareMetrics() {
    var cash = cashTotal();
    var invested = investedTotal();
    var liquid = cash + invested;
    var expenses = monthlyExpenses();
    var months = cashMonthsTarget();
    var targetCash = expenses * months;
    return {
      cash: cash,
      invested: invested,
      liquid: liquid,
      expenses: expenses,
      statedExpenses: statedMonthlyExpenses(),
      usingFloor: usingExpenseFloor(),
      floor: MIN_MONTHLY_EXPENSES,
      months: months,
      targetCash: targetCash,
      excessCash: Math.max(0, cash - targetCash),
      // Under-funded is reported but NOT graded here: too little buffer is a
      // real risk, but it is the opposite failure and folding it into the same
      // meter would make one number mean two contradictory things.
      shortOfBuffer: Math.max(0, targetCash - cash),
      share: liquid > 0 ? invested / liquid : null
    };
  }

  /**
   * Weighted expense ratio across the invested accounts.
   *
   * Requires a ratio on EVERY invested account, not just the ones the user
   * bothered to look up. Averaging only the accounts with a figure is the
   * same hole the Garage had, where one logged oil change certified a service
   * schedule nobody had recorded — a user who fills in their cheap index fund
   * and leaves the expensive managed account blank would score a clean 100.
   * Partial data yields no score at all, and the page names what is missing.
   */
  function expenseRatioMetrics() {
    var accts = investedAccounts().filter(function (a) { return Number(a.value) > 0; });
    var missing = accts.filter(function (a) { return typeof a.er !== 'number'; });
    var total = accts.reduce(function (a, r) { return a + Number(r.value); }, 0);
    if (!accts.length || !total) return { ratio: null, accounts: 0, missing: [], covered: 0 };
    var weighted = accts.reduce(function (a, r) {
      return a + Number(r.value) * (typeof r.er === 'number' ? r.er : 0);
    }, 0) / total;
    return {
      ratio: missing.length ? null : weighted,
      accounts: accts.length,
      missing: missing.map(function (a) { return a.name || 'Untitled'; }),
      covered: (total - missing.reduce(function (a, r) { return a + Number(r.value); }, 0)) / total,
      annualCost: missing.length ? null : total * weighted / 100
    };
  }

  /**
   * The four graded inputs. Null means "no data" and the weight is
   * redistributed, exactly as bodyScore() does with Strength Progress.
   */
  function wealthInputs() {
    var c = contributionMetrics();
    var savingsRate = null, consistency = null;

    // These two start at ZERO, not at "no data", the moment their denominator
    // exists — which is exactly how Body treats its logged inputs. Open Body
    // on a fresh profile and Consistency reads 0, because you have trained
    // zero days out of the days you said you would; it does not read "—".
    // Wealth used to demand a logged contribution before it would say
    // anything, so a user who had entered their income and set a commitment
    // saw a dash, as though the app had no idea. It had a very good idea:
    // they had contributed nothing.
    //
    // A missing DENOMINATOR is still no data — there is no such thing as a
    // savings rate without an income to measure it against — so the gauge
    // stays grey until the user supplies one.
    if (c.income > 0) {
      // Annualise a partial year so an honest three-month log is not scored
      // as though nine months of nothing had happened.
      var annualised = c.contributed * (12 / c.monthsLogging);
      savingsRate = clamp(Math.round((annualised / c.income) / c.target * 100), 0, 100);
    }
    if (c.monthlyCommit > 0) {
      consistency = clamp(Math.round(c.contributed / Math.max(c.committedInWindow, 1) * 100), 0, 100);
    }

    // Only liquid money is required now. Expenses can never be zero — see
    // MIN_MONTHLY_EXPENSES — so the emergency fund always has a size and the
    // meter always has something to measure against. The page states which
    // figure it used.
    var investedShare = null;
    var s = investedShareMetrics();
    if (s.liquid > 0) {
      investedShare = clamp(Math.round((1 - s.excessCash / s.liquid) * 100), 0, 100);
    }

    var costDrag = null;
    var e = expenseRatioMetrics();
    if (e.ratio !== null) {
      costDrag = e.ratio <= ER_TARGET ? 100
        : clamp(Math.round((1 - (e.ratio - ER_TARGET) / (ER_ZERO - ER_TARGET)) * 100), 0, 100);
    }

    return { savingsRate: savingsRate, consistency: consistency,
             investedShare: investedShare, costDrag: costDrag };
  }

  /** Which Wealth inputs are actually contributing, for the formula readout. */
  function wealthActiveWeights() {
    var i = wealthInputs();
    var total = WEALTH_KEYS.reduce(function (a, k) { return a + (isEmptyScore(i[k]) ? 0 : WEALTH_WEIGHTS[k]); }, 0) || 1;
    var out = {};
    WEALTH_KEYS.forEach(function (k) { out[k] = isEmptyScore(i[k]) ? 0 : WEALTH_WEIGHTS[k] / total; });
    return out;
  }

  function hasWealthData() {
    var i = wealthInputs();
    return WEALTH_KEYS.some(function (k) { return !isEmptyScore(i[k]); });
  }
  function wealthScore() {
    var i = wealthInputs();
    var parts = WEALTH_KEYS
      .map(function (k) { return { weight: WEALTH_WEIGHTS[k], score: i[k] }; })
      .filter(function (p) { return !isEmptyScore(p.score); });
    if (!parts.length) return null;
    var totalWeight = parts.reduce(function (a, p) { return a + p.weight; }, 0);
    var weighted = parts.reduce(function (a, p) { return a + p.score * p.weight; }, 0);
    return clamp(Math.round(weighted / totalWeight), 0, 100);
  }

  /** Return against benchmark. Reported, never graded — this is context. */
  function returnContext() {
    if (!(accountsTotal() > 0) || !(Number(state.wealth.contributions) > 0)) return null;
    var m = wealthMetrics();
    var benchmark = (typeof state.wealth.benchmark === 'number') ? state.wealth.benchmark : 8;
    return {
      annualized: m.annualized,
      benchmark: benchmark,
      delta: m.annualized - benchmark,
      pattern: m.pattern,
      years: m.years
    };
  }
  function netWorthProxy() { return Math.max(accountsTotal() + manualAssetsTotal(), 1); }
  /**
   * How well this vehicle is being kept, expressed as a multiplier rather than
   * a bonus. As an additive bonus it was invisible: a user already at 100 had
   * nowhere for the +6 to go, so the app claimed to score maintenance
   * discipline while, for anyone doing well, scoring nothing at all.
   *
   * Untracked sits at UNTRACKED_FACTOR — below a well-kept car, above a
   * neglected one. That is a deliberate change of stance: "we don't know" is
   * no longer identical to "perfect", because otherwise logging service can
   * never gain you anything. It is still well above the neglect floor, so a
   * new user is not punished for a history they haven't had time to build.
   *
   * COVERAGE. Averaging only the services that have history made the 0.94 a
   * toll booth rather than a discipline measure: one fresh oil change took a
   * car from 0.94 to a full 1.00 while six other services sat unlogged, so the
   * app certified tyres, brakes and battery it had never been told about. The
   * result is now scaled by how much of the schedule has any history at all —
   * you move from "we don't know" toward the verdict your records support, in
   * proportion to how much you have actually recorded. Full marks require a
   * full schedule kept up; the 0.80 floor likewise requires enough evidence to
   * justify it, so one stale record on an otherwise unlogged car reads as
   * doubt (0.92) rather than neglect.
   */
  var MAINT_FLOOR_FACTOR = 0.80;   // every service on the schedule overdue
  var UNTRACKED_FACTOR   = 0.94;   // no service history at all
  var DUE_WEIGHT = { ok: 1, soon: 0.7, overdue: 0 };

  function maintenanceFactor(v) {
    // Everything this vehicle is judged on ('off' services are already gone).
    var schedule = vehicleDueList(v);
    var list = schedule.filter(function (d) {
      return d.status === 'ok' || d.status === 'soon' || d.status === 'overdue';
    });
    if (!schedule.length || !list.length) {
      return { factor: UNTRACKED_FACTOR, tracked: false, items: 0,
               schedule: schedule.length, coverage: 0 };
    }

    var health = list.reduce(function (a, d) { return a + DUE_WEIGHT[d.status]; }, 0) / list.length;
    var kept = MAINT_FLOOR_FACTOR + (1 - MAINT_FLOOR_FACTOR) * health;
    var coverage = list.length / schedule.length;
    return {
      factor: UNTRACKED_FACTOR + (kept - UNTRACKED_FACTOR) * coverage,
      tracked: true,
      items: list.length,
      schedule: schedule.length,
      coverage: coverage,
      untracked: schedule.length - list.length,
      health: health,
      kept: kept,
      overdue: list.filter(function (d) { return d.status === 'overdue'; }).length
    };
  }

  /**
   * Affordability is a property of the FLEET, not of any one car, so it is
   * charged once against total vehicle value. Charging it per vehicle meant
   * $200k in one car scored 61 while the same $200k split across two cars
   * scored 97 — the penalty was simply divided away by the averaging in
   * driveScore(). It also disagreed with avgDriveRatio(), which was already
   * computing the ratio fleet-wide for display.
   */
  function fleetValue() {
    return (state.vehicles || []).reduce(function (a, v) { return a + currentValue(v); }, 0);
  }
  function fleetAnnualCost() {
    return (state.vehicles || []).reduce(function (a, v) { return a + (Number(v.annualCost) || 0); }, 0);
  }

  // Affordability. Cars cost money every year, and the question worth asking
  // is whether that money is coming out of surplus or out of your future.
  //
  // This used to be answered with fleet value ÷ net worth, free to 15%. That
  // is the wrong denominator for anyone who earns well and has not finished
  // accumulating: it punished a 32-year-old on $220,000, saving a quarter of
  // it, for owning one well-kept sports car — 39 points, from a perfect
  // upkeep score down to 61 — while handing 100 to someone with a cheap car
  // and no savings habit at all. On a page headed "Cars are culture", the
  // engine was telling the people it is for that they had failed.
  //
  // What actually makes a car affordable is what it costs you each year
  // against what you earn, and whether you are still putting money away
  // while you run it. Both are decisions. Net worth is largely an outcome of
  // age and inheritance, and grading it broke the same rule Wealth broke
  // when it graded the market.
  var CAR_COST_FREE  = 0.15;   // annual fleet cost up to 15% of gross: no charge
  var CAR_COST_SLOPE = 220;    // 2.2 points per percentage point beyond that
  // Saving hard is direct evidence the cars are not eating your future, so it
  // relieves most of the charge — but never all of it. A cost share this far
  // out of line is worth flagging even to somebody who can carry it.
  var MIN_COST_BITE  = 0.35;

  /**
   * Affordability charge for the fleet, optionally including a vehicle that
   * has not been saved yet. Returns the penalty and the basis it used, so the
   * page can say which question it answered.
   *
   *   'income'    annual cost vs gross income, relieved by savings discipline
   *   'networth'  the old ratio, used only when income or running costs are
   *               missing — no new inputs, no surprise change for anyone who
   *               has not filled in Wealth
   */
  function affordability(draft) {
    var income = grossIncome();
    var cost = fleetAnnualCost() + (draft ? (Number(draft.annualCost) || 0) : 0);
    var value = fleetValue() + (draft ? currentValue(draft) : 0);

    if (income > 0 && cost > 0) {
      var costShare = cost / income;
      var over = Math.max(0, costShare - CAR_COST_FREE);
      var raw = over * CAR_COST_SLOPE;
      // Relief is measured against the PUBLISHED 15% guideline, deliberately
      // not against the user's own savings target.
      //
      // Reading the Savings Rate gauge here instead was perverse: that gauge
      // is scored against whatever target the user set, so raising your own
      // ambition from 15% to 30% lowered the gauge from 100 to 83 and quietly
      // charged you two points on your car — same income, same saving, same
      // fleet. The app was billing people for setting a harder goal.
      //
      // Affordability asks an objective question — is this coming out of
      // surplus — and the objective answer is the standard everyone is
      // measured against, not a personal stretch goal.
      var cm = contributionMetrics();
      var rate = cm.annualisedRate;   // null when income or the log is missing
      var shortfall = (rate === null) ? 1 : (1 - clamp(rate / SAVINGS_RATE_TARGET, 0, 1));
      return {
        basis: 'income',
        penalty: raw * (MIN_COST_BITE + (1 - MIN_COST_BITE) * shortfall),
        rawPenalty: raw,
        costShare: costShare,
        annualCost: cost,
        income: income,
        savingsRate: rate === null ? null : Math.round(rate * 1000) / 10,
        reliefApplied: 1 - shortfall,
        guideline: SAVINGS_RATE_TARGET,
        free: CAR_COST_FREE
      };
    }
    var ratio = value / netWorthProxy();
    return {
      basis: 'networth',
      penalty: Math.max(0, ratio - 0.15) * 220,
      ratio: ratio,
      fleetValue: value,
      needs: income > 0 ? 'annualCost' : 'income',
      free: 0.15
    };
  }
  function fleetRatioPenalty(draft) { return affordability(draft).penalty; }

  /**
   * Upkeep quality of one vehicle. Maintenance discipline, and nothing else.
   *
   * This used to also subtract a point for every $1,000 of annual running
   * cost above a flat $15,000 — a second affordability charge, hiding inside
   * a number labelled "Upkeep", judged against a constant that never once
   * asked what the owner earned. A car costing $55,000 a year lost 40 points
   * whether its owner made $90,000 or $900,000, and no amount of perfect
   * maintenance could win them back.
   *
   * It also contradicted the rule this file already states out loud:
   * affordability is a property of the fleet, not of a car. It is charged
   * once, at fleet level, against income — see affordability(). Upkeep now
   * measures the only thing its name claims: whether the thing is looked
   * after.
   */
  function vehicleScore(v) {
    return clamp(Math.round(100 * maintenanceFactor(v).factor), 0, 100);
  }

  function driveScore() {
    // No fleet, no score. Returning a plausible 60 here meant any caller that
    // forgot to check hasDriveData() would paint a default onto a dial.
    if (!state.vehicles.length) return null;
    var scores = state.vehicles.map(vehicleScore);
    var avg = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    return clamp(Math.round(avg - fleetRatioPenalty()), 0, 100);
  }

  /**
   * What the Drive score would become if `draft` were added to the garage.
   * Used by the Garage preview, which needs the fleet-level effect of a car
   * that has not been saved yet.
   */
  function projectedDriveScore(draft) {
    var upkeep = vehicleScore(draft);
    var scores = (state.vehicles || []).map(vehicleScore).concat([upkeep]);
    var avg = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    return clamp(Math.round(avg - fleetRatioPenalty(draft)), 0, 100);
  }

  /** Fleet value as a share of net worth. Null with an empty garage — a 10%
   *  placeholder read as a measurement of a fleet that does not exist. */
  function avgDriveRatio() {
    if (!state.vehicles.length) return null;
    var total = state.vehicles.reduce(function (a, v) { return a + currentValue(v); }, 0);
    return total / netWorthProxy();
  }
  /**
   * Body 40 / Wealth 40 / Drive 20, but rescaled across only the engines that
   * have something to measure. With nothing logged and no cars, the result is
   * the Wealth score alone rather than a blend padded out with defaults.
   * Returns null in the impossible case that no engine can be scored.
   */
  function overallScore() {
    var parts = [
      { weight: 0.40, score: hasBodyData() ? bodyScore() : null },
      { weight: 0.40, score: wealthScore() },
      { weight: 0.20, score: hasDriveData() ? driveScore() : null }
    ].filter(function (p) { return !isEmptyScore(p.score); });

    var totalWeight = parts.reduce(function (a, p) { return a + p.weight; }, 0);
    if (!totalWeight) return null;
    var weighted = parts.reduce(function (a, p) { return a + p.score * p.weight; }, 0);
    return clamp(Math.round(weighted / totalWeight), 0, 100);
  }

  // ---------------------------------------------------------------------
  // Score history
  //
  // Every number on this site describes right now. For an app whose entire
  // claim is discipline held over time, that is the wrong tense: you could
  // see today's consistency and never your own trajectory.
  //
  // One snapshot per day, taken when the app is opened and only once there
  // is something real to record. Nulls are kept as nulls — a stretch where
  // Drive was grey is part of the record, not a zero. About 47 bytes each,
  // so three years of daily use is a fraction of a percent of the storage
  // budget, and it rides along in every backup.
  // ---------------------------------------------------------------------
  var HISTORY_MAX = 1200;

  function scoreHistory() { return (state.history || []).slice(); }

  /**
   * Record today's scores. Idempotent within a day: re-opening the app
   * overwrites the day's entry rather than stacking duplicates, so the
   * latest reading for a day is the one kept.
   */
  function recordSnapshot() {
    if (!Array.isArray(state.history)) state.history = [];
    var o = overallScore();
    var b = hasBodyData() ? bodyScore() : null;
    var w = wealthScore();
    var dr = driveScore();
    // Nothing measured anywhere yet — nothing worth remembering.
    if (o === null && b === null && w === null && dr === null) return null;

    var today = todayKey();
    var row = { d: today, b: b, w: w, dr: dr, o: o };
    var last = state.history[state.history.length - 1];
    if (last && last.d === today) state.history[state.history.length - 1] = row;
    else state.history.push(row);

    if (state.history.length > HISTORY_MAX) {
      state.history = state.history.slice(state.history.length - HISTORY_MAX);
    }
    scheduleSave();
    return row;
  }

  /**
   * Change in one series over a window, using the earliest reading at or
   * before the window start so a gap does not read as a collapse.
   * Returns null when there is nothing to compare against.
   */
  function historyTrend(key, days) {
    var rows = (state.history || []).filter(function (r) { return r[key] !== null && r[key] !== undefined; });
    if (rows.length < 2) return null;
    var from = shiftDays(todayKey(), -(days || 30));
    var older = rows.filter(function (r) { return r.d <= from; });
    var base = older.length ? older[older.length - 1] : rows[0];
    var now = rows[rows.length - 1];
    if (base.d === now.d) return null;
    return {
      now: now[key], then: base[key], delta: now[key] - base[key],
      fromDate: base.d, toDate: now.d,
      days: daysBetween(base.d, now.d), points: rows.length
    };
  }

  // ---------------------------------------------------------------------
  // What moves the needle most
  //
  // The weights are published and a missing input redistributes rather than
  // scoring zero, which means the marginal value of every possible action is
  // computable — not guessable. Each candidate below is applied to a throwaway
  // copy of the state, the composite is recomputed, and the difference is the
  // honest gain.
  //
  // Where the outcome depends on a number the user has not given us, the gain
  // is reported as a CEILING — what it would be worth if that input scored
  // full marks — and labelled "up to". The app does not get to invent your
  // expense ratio and then congratulate itself on the improvement.
  // ---------------------------------------------------------------------
  function withTrialState(mutate) {
    var backup = state;
    var trial = JSON.parse(JSON.stringify(state));
    state = trial;
    var result = null;
    try { mutate(trial); result = overallScore(); }
    finally { state = backup; }
    return result;
  }

  function nextActions() {
    var base = overallScore();
    var out = [];
    function add(id, label, detail, page, mutate, ceiling) {
      var after = withTrialState(mutate);
      if (after === null) return;
      var gain = (base === null) ? after : after - base;
      if (gain <= 0) return;
      out.push({ id: id, label: label, detail: detail, page: page,
                 gain: Math.round(gain), ceiling: !!ceiling });
    }

    var bi = bodyInputs(), wi = wealthInputs(), c = contributionMetrics();

    // --- Body -----------------------------------------------------------
    if (!(state.sessions || []).length) {
      add('log-session', 'Log a training session', 'Body is your heaviest engine and nothing is logged yet.',
          'body.html', function (t) {
            t.sessions = [{ id: 1, date: todayKey(), type: 'strength', duration: 60, intensity: 'moderate' }];
          }, true);
    }
    if (bi.recovery === null) {
      add('set-recovery', 'Set your recovery', 'A manual input worth 15–25% of Body, currently unscored.',
          'body.html', function (t) { t.body.recovery = 100; }, true);
    }
    if (bi.strength === null) {
      add('strength-baseline', 'Record a starting max and log a lift',
          'Strength Progress is the heaviest Body input and has nothing to measure.',
          'strength.html', function (t) {
            var m = (t.lifts.movements || [])[0]; if (!m) return;
            m.baseline = { weight: 100, reps: 1, tested: true, date: shiftDays(todayKey(), -30), fromEntryId: null };
            t.lifts.entries = [{ id: 1, movementId: m.id, date: todayKey(), weight: 120, reps: 1, tested: true }];
          }, true);
    }
    if (anyNeedsBodyweight()) {
      add('set-bodyweight', 'Set your bodyweight',
          'A movement where the body is the load is being held out of Strength Progress.',
          'strength.html', function (t) { t.lifts.bodyweight = 180; }, true);
    }

    // --- Wealth ---------------------------------------------------------
    if (!(c.income > 0)) {
      add('set-income', 'Enter your gross income', 'Savings Rate is 35% of Wealth and has no bar to measure against.',
          'wealth.html', function (t) {
            t.wealth.income = 100000;
            if (!(t.deposits || []).length) t.deposits = [{ id: 1, date: todayKey(), amount: 1250 }];
          }, true);
    } else if (!(c.totalEntries > 0)) {
      add('log-contribution', 'Log a contribution', 'Your savings rate reads 0 because nothing has been recorded.',
          'wealth.html', function (t) {
            t.deposits = [{ id: 1, date: todayKey(), amount: Math.round(t.wealth.income * 0.15 / 12) }];
          }, true);
    }
    if (!(c.monthlyCommit > 0)) {
      add('set-commitment', 'Set a monthly contribution target',
          'Contribution Consistency is 30% of Wealth and has no bar.',
          'wealth.html', function (t) {
            t.wealth.monthlyCommit = 100;
            if (!(t.deposits || []).length) t.deposits = [{ id: 1, date: todayKey(), amount: 100 }];
          }, true);
    }
    if (wi.costDrag === null && (state.accounts || []).length) {
      var miss = expenseRatioMetrics().missing.length;
      add('set-er', 'Add expense ratios to your accounts',
          miss ? miss + ' account' + (miss === 1 ? '' : 's') + ' still without one — Cost Drag will not score until every one has it.'
               : 'Cost Drag has nothing to read.',
          'wealth.html', function (t) {
            (t.accounts || []).forEach(function (a) { if (!a.cash && typeof a.er !== 'number') a.er = 0.05; });
          }, true);
    }
    if (wi.investedShare !== null && wi.investedShare < 100) {
      var sm = investedShareMetrics();
      add('deploy-cash', 'Put idle cash to work',
          money(Math.round(sm.excessCash)) + ' is sitting beyond your emergency fund.',
          'wealth.html', function (t) {
            // Trial only: the ceiling if none of it were idle.
            (t.accounts || []).forEach(function (r) { r.cash = false; });
            (t.manualAssets || []).forEach(function (r) { r.cash = false; });
          }, true);
    }

    // --- Drive ----------------------------------------------------------
    (state.vehicles || []).forEach(function (v, i) {
      var mf = maintenanceFactor(v);
      if (mf.coverage < 1 || (mf.overdue || 0) > 0) {
        var name = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'your vehicle';
        add('service-' + i, 'Bring ' + name + '’s service record up to date',
            mf.tracked
              ? Math.round((1 - mf.coverage) * (mf.schedule || 0)) + ' of ' + (mf.schedule || 0) + ' services have no history.'
              : 'Nothing logged yet, so upkeep sits at 0.94 rather than 1.00.',
            'garage.html', function (t) {
              var tv = t.vehicles[i]; if (!tv) return;
              tv.maintenance = SERVICE_SCHEDULE.map(function (s, n) {
                return { id: 10000 + n, type: s.type, date: todayKey(),
                         mileage: Number(tv.mileage) || 0, cost: 0 };
              });
            });
      }
    });
    if ((state.vehicles || []).length) {
      var aff = affordability();
      if (aff.basis === 'networth') {
        add('afford-basis', aff.needs === 'income' ? 'Enter your gross income' : 'Add an annual running cost',
            'Affordability is falling back to the net-worth ratio, which is harsher on anyone still building.',
            aff.needs === 'income' ? 'wealth.html' : 'garage.html',
            function (t) {
              if (aff.needs === 'income') { t.wealth.income = 200000; }
              else { (t.vehicles || []).forEach(function (v) { if (!(Number(v.annualCost) > 0)) v.annualCost = 6000; }); }
            }, true);
      }
    } else {
      add('add-vehicle', 'Add a vehicle to the Garage', 'Drive is 20% of your score and has nothing to measure.',
          'garage.html', function (t) {
            t.vehicles = [{ id: 1, year: '', make: 'Vehicle', model: '', value: 20000, mileage: 10000,
              annualCost: 4000, intervals: {}, duty: 'standard', valuations: [], maintenance:
              SERVICE_SCHEDULE.map(function (s, n) { return { id: n, type: s.type, date: todayKey(), mileage: 10000, cost: 0 }; }),
              photos: [], cash: false, vin: '', recalls: null }];
          }, true);
    }

    out.sort(function (a, b) { return b.gain - a.gain; });
    return out;
  }


  // ---------------------------------------------------------------------
  // strength log
  //
  // Replaces the old 0-100 "how strong do you feel" slider. Strength Progress
  // is now computed from lifts the user actually performed, measured against
  // the starting maxes they recorded when they set the movement up.
  //
  // Epley is used to turn a working set into an estimated 1RM. It is accurate
  // for roughly 1-10 reps and increasingly optimistic beyond that, which is
  // why the form caps reps at MAX_VALID_REPS and flags anything over 10.
  // A set actually taken to a true single is stored with tested:true and needs
  // no estimating at all.
  // ---------------------------------------------------------------------
  var MAX_VALID_REPS = 12;
  var REPS_ACCURACY_LIMIT = 10;
  // 1% gained over baseline is worth this many points, so +20% reaches 100 and
  // baseline itself sits at BASELINE_SCORE with headroom in both directions.
  var GAIN_POINTS_PER_PERCENT = 2.5;
  var BASELINE_SCORE = 50;

  var DEFAULT_MOVEMENTS = [
    { id: 'bench',    name: 'Bench Press',      group: 'Push' },
    { id: 'ohp',      name: 'Overhead Press',   group: 'Push' },
    { id: 'squat',    name: 'Back Squat',       group: 'Legs' },
    { id: 'deadlift', name: 'Deadlift',         group: 'Legs' },
    { id: 'row',      name: 'Barbell Row',      group: 'Pull' },
    { id: 'pullup',   name: 'Weighted Pull-up', group: 'Pull', bodyweight: true }
  ];

  function freshLifts() {
    return {
      unit: 'lb',
      bodyweight: 0,
      movements: DEFAULT_MOVEMENTS.map(function (m) {
        return { id: m.id, name: m.name, group: m.group, custom: false,
                 bodyweight: !!m.bodyweight, baseline: null };
      }),
      entries: []
    };
  }

  /**
   * Estimated 1RM for a set. A true single is its own max.
   *
   * `extraLoad` is bodyweight for a movement where the body is the bar. Without
   * it, a weighted pull-up going from +25 to +45 lb reads as a 75% strength
   * gain, when the system load actually moved from 200 to 220 — about 10%. One
   * such movement was dragging the whole average up on its own.
   */
  function e1rm(weight, reps, tested, extraLoad) {
    var w = (Number(weight) || 0) + (Number(extraLoad) || 0);
    var r = clamp(Math.round(Number(reps) || 1), 1, MAX_VALID_REPS);
    if (w <= 0) return 0;
    if (r === 1) return w;            // tested or not, a single is the max
    return w * (1 + r / 30);          // Epley
  }

  function liftBodyweight() { return Number(state.lifts && state.lifts.bodyweight) || 0; }
  function setBodyweight(v) { state.lifts.bodyweight = Math.max(0, Number(v) || 0); }
  /** Load the movement adds to the body, if the body itself is the load. */
  function movementExtraLoad(m) { return (m && m.bodyweight) ? liftBodyweight() : 0; }
  /** True when a movement needs a bodyweight we do not have. */
  function needsBodyweight(m) { return !!(m && m.bodyweight) && liftBodyweight() <= 0; }
  function anyNeedsBodyweight() {
    return liftMovements().some(function (m) { return m.baseline && needsBodyweight(m); });
  }
  function repsAreReliable(reps) { return (Number(reps) || 1) <= REPS_ACCURACY_LIMIT; }

  function liftMovements() { return (state.lifts && state.lifts.movements) || []; }
  function liftMovement(id) {
    var list = liftMovements();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function liftEntries(movementId) {
    var rows = (state.lifts && state.lifts.entries) || [];
    if (movementId) rows = rows.filter(function (e) { return e.movementId === movementId; });
    return rows.slice().sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  }

  /**
   * Per-movement progress. Cumulative: best ever achieved against the recorded
   * starting max. Entries dated on or before the baseline are ignored for the
   * "best" so that back-filled history cannot manufacture a gain.
   */
  function movementProgress(m) {
    if (!m || !m.baseline) return null;
    var extra = movementExtraLoad(m);
    var base = e1rm(m.baseline.weight, m.baseline.reps, m.baseline.tested, extra);
    if (base <= 0) return null;

    // The body IS the bar here and we have not been told what it weighs, so
    // there is no system load to measure a gain against. Scoring the plate
    // alone does not merely skew the average: 25 lb to 45 lb reads as +80%,
    // which clamps Strength Progress at a flat 100 — the heaviest single input
    // on Body under the Strength goal. Report it, warn on it, do not score it.
    if (needsBodyweight(m)) {
      return { movement: m, baseline: base, best: base, gainPct: 0,
               entries: liftEntries(m.id).filter(function (e) {
                 return e.date >= m.baseline.date && e.id !== m.baseline.fromEntryId;
               }).length,
               measurable: false, blocked: 'bodyweight', baselineDate: m.baseline.date,
               extraLoad: extra, needsBodyweight: true };
    }

    // On or after the baseline date, excluding the single entry that created
    // the baseline. Using a strict > here silently discarded a PR set on the
    // same day you recorded your starting max, which is a normal first session.
    var after = liftEntries(m.id).filter(function (e) {
      return e.date >= m.baseline.date && e.id !== m.baseline.fromEntryId;
    });
    if (!after.length) {
      return { movement: m, baseline: base, best: base, gainPct: 0, entries: 0,
               measurable: false, baselineDate: m.baseline.date,
               extraLoad: extra, needsBodyweight: needsBodyweight(m) };
    }
    var best = base, bestEntry = null, latest = after[0];
    after.forEach(function (e) {
      var v = e1rm(e.weight, e.reps, e.tested, extra);
      if (v > best) { best = v; bestEntry = e; }
    });
    return {
      movement: m,
      baseline: base,
      best: best,
      bestEntry: bestEntry,
      latest: latest,
      latestE1rm: e1rm(latest.weight, latest.reps, latest.tested, extra),
      extraLoad: extra,
      needsBodyweight: needsBodyweight(m),
      gainPct: (best - base) / base * 100,
      entries: after.length,
      measurable: true,
      baselineDate: m.baseline.date
    };
  }

  /** Every movement that has a baseline, whether or not it has moved yet. */
  function strengthProgressList() {
    return liftMovements().map(movementProgress).filter(Boolean);
  }

  /** True once at least one movement can actually show progress. */
  function hasStrengthData() {
    return strengthProgressList().some(function (p) { return p.measurable; });
  }

  /**
   * Strength Progress, 0-100. Average cumulative gain across every movement
   * that has moved, mapped so baseline = 50 and +20% = 100.
   *
   * Cumulative by design (the user's call): it rewards the whole climb rather
   * than only the last 90 days, so an advanced lifter's slow year still counts.
   * The trade-off is that it does not decay — see strengthStaleness(), which
   * surfaces how long it has been since anything was logged rather than
   * silently letting an old number stand in for current form.
   */
  function strengthProgress() {
    var moved = strengthProgressList().filter(function (p) { return p.measurable; });
    if (!moved.length) return null;
    var avgGain = moved.reduce(function (a, p) { return a + p.gainPct; }, 0) / moved.length;
    return clamp(Math.round(BASELINE_SCORE + avgGain * GAIN_POINTS_PER_PERCENT), 0, 100);
  }
  function averageGainPct() {
    var moved = strengthProgressList().filter(function (p) { return p.measurable; });
    if (!moved.length) return null;
    return moved.reduce(function (a, p) { return a + p.gainPct; }, 0) / moved.length;
  }

  var STRENGTH_STALE_DAYS = 45;
  function strengthStaleness() {
    var rows = liftEntries();
    if (!rows.length) return null;
    var days = daysBetween(rows[0].date, todayKey());
    return { lastDate: rows[0].date, days: days, stale: days >= STRENGTH_STALE_DAYS };
  }

  function addLiftEntry(movementId, entry) {
    var row = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      movementId: movementId,
      date: entry.date || todayKey(),
      weight: Number(entry.weight) || 0,
      reps: clamp(Math.round(Number(entry.reps) || 1), 1, MAX_VALID_REPS),
      tested: !!entry.tested,
      notes: (entry.notes || '').slice(0, 240)
    };
    state.lifts.entries.push(row);
    return row;
  }
  function setBaseline(movementId, baseline) {
    var m = liftMovement(movementId);
    if (!m) return;
    m.baseline = baseline ? {
      weight: Number(baseline.weight) || 0,
      reps: clamp(Math.round(Number(baseline.reps) || 1), 1, MAX_VALID_REPS),
      date: baseline.date || todayKey(),
      tested: !!baseline.tested,
      // Set when a logged lift became the baseline, so that one entry can be
      // excluded from "progress since" without excluding the whole day.
      fromEntryId: baseline.fromEntryId != null ? baseline.fromEntryId : null
    } : null;
  }
  function addMovement(name, group, bodyweight) {
    var clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    var id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    var m = { id: id, name: clean, group: group || 'Other', custom: true,
              bodyweight: !!bodyweight, baseline: null };
    state.lifts.movements.push(m);
    return m;
  }
  function removeMovement(id) {
    state.lifts.movements = liftMovements().filter(function (m) { return m.id !== id; });
    state.lifts.entries = (state.lifts.entries || []).filter(function (e) { return e.movementId !== id; });
  }
  function liftUnit() { return (state.lifts && state.lifts.unit) === 'kg' ? 'kg' : 'lb'; }
  function setLiftUnit(u) { state.lifts.unit = (u === 'kg') ? 'kg' : 'lb'; }
  function weightFmt(v) { return Math.round(Number(v) || 0).toLocaleString('en-US') + ' ' + liftUnit(); }

  // ---------------------------------------------------------------------
  // service schedules — per service type, a mileage interval AND a time
  // interval. Due is whichever arrives first. A blank/0 interval on one
  // dimension means "don't judge this service on that dimension"; blank on
  // both disables the service entirely. This mirrors the model Gas Cubby
  // documents, which is the de-facto standard in the category.
  // ---------------------------------------------------------------------
  var SERVICE_SCHEDULE = [
    { type: 'Oil Change',    miles: 5000,  months: 6 },
    { type: 'Tire Rotation', miles: 6000,  months: 6 },
    { type: 'Air Filter',    miles: 15000, months: 12 },
    { type: 'Brake Service', miles: 25000, months: 36 },
    { type: 'Tune-Up',       miles: 30000, months: 24 },
    { type: 'Battery',       miles: 0,     months: 48 },
    { type: 'Inspection',    miles: 0,     months: 12 }
  ];
  // Manufacturers publish a severe-duty column for towing, short trips, dust,
  // heat and stop-start city use. Scaling both dimensions is the honest cheap
  // version of that.
  var SEVERE_DUTY_FACTOR = 0.7;
  // Warn at 10% of the interval remaining, so a 5,000 mi oil change goes SOON
  // with 500 mi left rather than at some constant that ignores the interval.
  var SOON_FRACTION = 0.10;
  var DEFAULT_MILES_PER_YEAR = 12000;
  var MIN_RATE_SPAN_DAYS = 21;    // below this a rate fit is noise

  // ---------------------------------------------------------------------
  // Make-specific service intervals
  //
  // The generic SERVICE_SCHEDULE above is one-size-fits-all, and a modern
  // Porsche running 10,000 miles between oil changes should not be nagged on
  // a 5,000-mile clock built for nothing in particular. These are the typical
  // NORMAL-DUTY intervals published for each marque's recent petrol models.
  //
  // They are a sensible starting point, NOT your car's schedule. Model, year,
  // engine and market all move these numbers, and the owner's manual is the
  // only authority. The Intervals panel says which schedule a vehicle is on
  // and every figure stays editable — switching to severe duty scales them,
  // and blanking a box switches that dimension off.
  //
  // A 0 means the service does not apply: an EV has no oil to change, and
  // serviceInterval() already reads 0/0 as "switched off" rather than "due".
  // ---------------------------------------------------------------------
  var MAKE_INTERVALS = {
    porsche:    { label: 'Porsche',        i: { 'Oil Change': [10000, 12], 'Tire Rotation': [10000, 12], 'Air Filter': [30000, 36], 'Brake Service': [25000, 24], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    bmw:        { label: 'BMW',            i: { 'Oil Change': [10000, 12], 'Tire Rotation': [10000, 12], 'Air Filter': [30000, 36], 'Brake Service': [25000, 24], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    mercedes:   { label: 'Mercedes-Benz',  i: { 'Oil Change': [10000, 12], 'Tire Rotation': [10000, 12], 'Air Filter': [30000, 36], 'Brake Service': [25000, 24], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    audi:       { label: 'Audi',           i: { 'Oil Change': [10000, 12], 'Tire Rotation': [10000, 12], 'Air Filter': [30000, 36], 'Brake Service': [25000, 24], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    volkswagen: { label: 'Volkswagen',     i: { 'Oil Change': [10000, 12], 'Tire Rotation': [10000, 12], 'Air Filter': [30000, 36], 'Brake Service': [25000, 24], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    toyota:     { label: 'Toyota',         i: { 'Oil Change': [10000, 12], 'Tire Rotation': [5000, 6],   'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    lexus:      { label: 'Lexus',          i: { 'Oil Change': [10000, 12], 'Tire Rotation': [5000, 6],   'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    honda:      { label: 'Honda',          i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    acura:      { label: 'Acura',          i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    subaru:     { label: 'Subaru',         i: { 'Oil Change': [6000, 6],   'Tire Rotation': [6000, 6],   'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    mazda:      { label: 'Mazda',          i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    nissan:     { label: 'Nissan',         i: { 'Oil Change': [5000, 6],   'Tire Rotation': [5000, 6],   'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    ford:       { label: 'Ford',           i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    chevrolet:  { label: 'Chevrolet',      i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    gmc:        { label: 'GMC',            i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    jeep:       { label: 'Jeep',           i: { 'Oil Change': [8000, 12],  'Tire Rotation': [8000, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    hyundai:    { label: 'Hyundai',        i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    kia:        { label: 'Kia',            i: { 'Oil Change': [7500, 12],  'Tire Rotation': [7500, 12],  'Air Filter': [30000, 36], 'Brake Service': [25000, 36], 'Battery': [0, 48], 'Inspection': [0, 12] } },
    // Electric: no oil, no tune-up. Brake fluid and cabin air still matter,
    // and regen braking means pads last far longer than on a petrol car.
    tesla:      { label: 'Tesla (EV)',     ev: true, i: { 'Oil Change': [0, 0], 'Tune-Up': [0, 0], 'Tire Rotation': [6250, 12], 'Air Filter': [0, 24], 'Brake Service': [0, 24], 'Battery': [0, 0], 'Inspection': [0, 12] } },
    rivian:     { label: 'Rivian (EV)',    ev: true, i: { 'Oil Change': [0, 0], 'Tune-Up': [0, 0], 'Tire Rotation': [7500, 12], 'Air Filter': [0, 24], 'Brake Service': [0, 24], 'Battery': [0, 0], 'Inspection': [0, 12] } },
    polestar:   { label: 'Polestar (EV)',  ev: true, i: { 'Oil Change': [0, 0], 'Tune-Up': [0, 0], 'Tire Rotation': [7500, 12], 'Air Filter': [0, 24], 'Brake Service': [0, 24], 'Battery': [0, 0], 'Inspection': [0, 12] } }
  };
  var MAKE_ALIASES = {
    'mercedes-benz': 'mercedes', 'mercedes benz': 'mercedes', 'benz': 'mercedes',
    'vw': 'volkswagen', 'chevy': 'chevrolet', 'land rover': 'landrover'
  };

  /** The make table entry for a vehicle, or null when we have nothing for it. */
  function makeSchedule(v) {
    var raw = String((v && v.make) || '').trim().toLowerCase();
    if (!raw) return null;
    var key = MAKE_ALIASES[raw] || raw;
    return MAKE_INTERVALS[key] || null;
  }
  function makeScheduleLabel(v) {
    var m = makeSchedule(v);
    return m ? m.label : null;
  }

  function defaultInterval(type) {
    for (var i = 0; i < SERVICE_SCHEDULE.length; i++) {
      if (SERVICE_SCHEDULE[i].type.toLowerCase() === String(type).toLowerCase()) {
        return { miles: SERVICE_SCHEDULE[i].miles, months: SERVICE_SCHEDULE[i].months };
      }
    }
    return null;
  }

  /**
   * Where a vehicle's interval for one service came from, so the UI can say.
   *   'user'    — typed into the Intervals panel, beats everything
   *   'make'    — the marque's typical normal-duty figure
   *   'generic' — the catch-all schedule
   */
  function intervalSource(v, type) {
    var over = (v.intervals || {})[type];
    if (over && (over.miles != null || over.months != null)) return 'user';
    var m = makeSchedule(v);
    if (m && m.i[type]) return 'make';
    return 'generic';
  }

  /** Effective interval for one service on one vehicle, overrides applied. */
  function serviceInterval(v, type) {
    var over = (v.intervals || {})[type];
    // User override, then the make's schedule, then the generic one. Nothing
    // is written into the vehicle: the make table is a fallback layer, so a
    // corrected make or a later table update takes effect without migrating
    // anybody's saved data, and a user override is never clobbered.
    var m = makeSchedule(v);
    var base = (m && m.i[type])
      ? { miles: m.i[type][0], months: m.i[type][1] }
      : (defaultInterval(type) || { miles: 0, months: 0 });
    var miles  = over && over.miles  != null ? Number(over.miles)  : base.miles;
    var months = over && over.months != null ? Number(over.months) : base.months;
    if (v.duty === 'severe') {
      miles  = Math.round(miles  * SEVERE_DUTY_FACTOR);
      months = Math.round(months * SEVERE_DUTY_FACTOR);
    }
    return {
      miles:  miles  > 0 ? miles  : 0,
      months: months > 0 ? months : 0,
      disabled: !(miles > 0) && !(months > 0)
    };
  }

  /** Every service type this vehicle knows about: defaults plus anything logged. */
  function serviceTypesFor(v) {
    var seen = {}, out = [];
    SERVICE_SCHEDULE.forEach(function (s) { seen[s.type.toLowerCase()] = true; out.push(s.type); });
    (v.maintenance || []).forEach(function (r) {
      var t = (r.type || '').trim();
      if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = true; out.push(t); }
    });
    return out;
  }

  /** Most recent record of a type. Anchor for the next due — see dateAddMonths. */
  function lastServiceOf(v, type) {
    var t = String(type).toLowerCase();
    var rows = (v.maintenance || []).filter(function (r) {
      return String(r.type || '').toLowerCase() === t;
    });
    if (!rows.length) return null;
    rows.sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    return rows[0];
  }

  function dateAddMonths(ymd, months) {
    var parts = String(ymd).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var targetMonth = d.getMonth() + months;
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(targetMonth);
    // clamp to the last valid day, so 31 Jan + 1 month is 28/29 Feb not 3 Mar
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return dayKey(d);
  }
  function daysBetween(fromYmd, toYmd) {
    var a = String(fromYmd).split('-'), b = String(toYmd).split('-');
    var d1 = Date.UTC(+a[0], +a[1] - 1, +a[2]);
    var d2 = Date.UTC(+b[0], +b[1] - 1, +b[2]);
    return Math.round((d2 - d1) / 86400000);
  }

  /**
   * mileageRate(v) — miles per day, fitted from the odometer readings the
   * user has already given us on service records, plus the vehicle's current
   * mileage as of today. No app in this category projects a due DATE from
   * distance intervals; this is what makes that possible.
   *
   * Returns { perDay, source } where source is 'fitted' or 'default'. Odometer
   * readings that go backwards are dropped rather than trusted, and a span
   * under three weeks falls back rather than extrapolating from noise.
   */
  function mileageRate(v) {
    var fallback = { perDay: DEFAULT_MILES_PER_YEAR / 365, source: 'default' };
    var points = (v.maintenance || [])
      .filter(function (r) { return r.date && Number(r.mileage) > 0; })
      .map(function (r) { return { date: r.date, miles: Number(r.mileage) }; });

    if (Number(v.mileage) > 0) points.push({ date: todayKey(), miles: Number(v.mileage) });
    if (points.length < 2) return fallback;

    points.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

    // Drop any reading lower than the highest seen so far: an odometer cannot
    // run backwards, so those are typos rather than data.
    var clean = [], high = -Infinity;
    points.forEach(function (p) { if (p.miles >= high) { clean.push(p); high = p.miles; } });
    if (clean.length < 2) return fallback;

    var first = clean[0], last = clean[clean.length - 1];
    var span = daysBetween(first.date, last.date);
    var delta = last.miles - first.miles;
    if (span < MIN_RATE_SPAN_DAYS || delta <= 0) return fallback;

    return { perDay: delta / span, source: 'fitted', spanDays: span, miles: delta, points: clean.length };
  }

  /**
   * serviceDue(v, type) — status for one service on one vehicle.
   * status: 'none' (nothing logged yet) | 'off' | 'ok' | 'soon' | 'overdue'
   */
  function serviceDue(v, type) {
    var iv = serviceInterval(v, type);
    if (iv.disabled) return { type: type, status: 'off', interval: iv };

    var last = lastServiceOf(v, type);
    if (!last) {
      return { type: type, status: 'none', interval: iv,
               detail: 'Log one to start the countdown.' };
    }

    var out = { type: type, status: 'ok', interval: iv, last: last };
    var triggers = [];

    // Mileage dimension. Anchored to the odometer ON the record, not to any
    // previously projected target — that is the drift bug Fuelio shipped.
    if (iv.miles > 0 && Number(last.mileage) > 0) {
      var dueAt = Number(last.mileage) + iv.miles;
      var remaining = dueAt - (Number(v.mileage) || 0);
      out.dueAtMiles = dueAt;
      out.remainingMiles = remaining;
      triggers.push(remaining <= 0 ? 'overdue'
        : (remaining <= iv.miles * SOON_FRACTION ? 'soon' : 'ok'));
    }

    // Time dimension.
    if (iv.months > 0 && last.date) {
      var dueOn = dateAddMonths(last.date, iv.months);
      var daysLeft = daysBetween(todayKey(), dueOn);
      var intervalDays = Math.max(1, daysBetween(last.date, dueOn));
      out.dueOn = dueOn;
      out.remainingDays = daysLeft;
      triggers.push(daysLeft <= 0 ? 'overdue'
        : (daysLeft <= intervalDays * SOON_FRACTION ? 'soon' : 'ok'));
    }

    if (!triggers.length) {
      out.status = 'none';
      out.detail = 'No odometer or date on the last record.';
      return out;
    }
    // Due is whichever dimension arrives first.
    out.status = triggers.indexOf('overdue') > -1 ? 'overdue'
               : (triggers.indexOf('soon') > -1 ? 'soon' : 'ok');

    // Project the mileage threshold onto a date, so a distance interval reads
    // as something a human can put in a calendar.
    if (out.remainingMiles != null) {
      var rate = mileageRate(v);
      out.rate = rate;
      if (rate.perDay > 0) {
        var days = Math.round(out.remainingMiles / rate.perDay);
        out.projectedOn = shiftDays(todayKey(), days);
        out.projectedDays = days;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Vehicle lookup — NHTSA
  //
  // Two public US government endpoints, both free, both key-less, both
  // CORS-enabled, so they are called straight from the browser. Nothing is
  // scraped: a page cannot read another site's HTML, and a scraper would
  // break the first time somebody redesigned a page. These return JSON that
  // is meant to be consumed.
  //
  //   vPIC     decodes a VIN into year / make / model / engine / body
  //   recalls  open safety campaigns for a year + make + model
  //
  // Everything here is OPTIONAL and cached. The app is offline-first: if the
  // network is missing, blocked or slow, lookups fail quietly and every
  // existing feature carries on. Results are stored on the vehicle so the
  // last answer survives going offline, and each one carries the date it was
  // fetched so a stale answer never passes as current.
  //
  // Recalls are deliberately NOT part of the Drive score. An open recall is
  // the manufacturer's failing, not the owner's, and this app grades what
  // you decide. It is reported, and reported loudly — never graded.
  // ---------------------------------------------------------------------
  var VPIC_DECODE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/';
  var RECALLS_URL     = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
  var LOOKUP_TIMEOUT_MS = 12000;
  var RECALL_STALE_DAYS = 30;
  // I, O and Q are never used in a VIN — they would be mistaken for 1 and 0.
  var VIN_CHARS = /^[A-HJ-NPR-Z0-9]{17}$/;
  var VIN_TRANSLIT = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
  var VIN_WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

  function normalizeVin(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  /**
   * Full VIN validation including the check digit in position 9. Doing this
   * before the network call means an obvious typo is caught instantly and
   * offline, rather than costing a round trip to be told nothing useful.
   */
  function isValidVin(raw) {
    var vin = normalizeVin(raw);
    if (!VIN_CHARS.test(vin)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) {
      var ch = vin.charAt(i);
      var val = /[0-9]/.test(ch) ? Number(ch) : VIN_TRANSLIT[ch];
      if (val === undefined) return false;
      sum += val * VIN_WEIGHTS[i];
    }
    var check = sum % 11;
    var expected = check === 10 ? 'X' : String(check);
    return vin.charAt(8) === expected;
  }

  /** fetch + JSON with a hard timeout, so a hung request cannot hang the UI. */
  function fetchJson(url) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('offline'));
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, LOOKUP_TIMEOUT_MS);
    var opts = controller ? { signal: controller.signal } : {};
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('http_' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /**
   * Decode a VIN. Resolves to { ok, vehicle, notes } — never rejects for a
   * bad VIN, only for a genuine network failure, so the caller can tell
   * "we could not reach NHTSA" apart from "NHTSA does not know this VIN".
   */
  function decodeVin(rawVin) {
    var vin = normalizeVin(rawVin);
    if (vin.length !== 17) {
      return Promise.resolve({ ok: false, reason: 'length',
        message: 'A VIN is 17 characters. That one is ' + vin.length + '.' });
    }
    if (!VIN_CHARS.test(vin)) {
      return Promise.resolve({ ok: false, reason: 'charset',
        message: 'That VIN contains a letter no VIN uses — I, O and Q never appear.' });
    }
    var checkOk = isValidVin(vin);
    return fetchJson(VPIC_DECODE_URL + encodeURIComponent(vin) + '?format=json')
      .then(function (data) {
        var r = (data && data.Results && data.Results[0]) || null;
        if (!r) return { ok: false, reason: 'empty', message: 'NHTSA returned nothing for that VIN.' };
        var vehicle = {
          vin: vin,
          year: firstNonEmpty(r.ModelYear),
          make: titleCase(firstNonEmpty(r.Make)),
          model: titleCase(firstNonEmpty(r.Model)),
          trim: firstNonEmpty(r.Trim, r.Series),
          engine: [firstNonEmpty(r.DisplacementL) ? Number(r.DisplacementL).toFixed(1) + 'L' : '',
                   firstNonEmpty(r.EngineCylinders) ? r.EngineCylinders + '-cyl' : '',
                   titleCase(firstNonEmpty(r.FuelTypePrimary))].filter(Boolean).join(' '),
          body: titleCase(firstNonEmpty(r.BodyClass)),
          drive: firstNonEmpty(r.DriveType),
          plant: [titleCase(firstNonEmpty(r.PlantCity)), firstNonEmpty(r.PlantCountry)].filter(Boolean).join(', ')
        };
        var notes = [];
        if (!checkOk) notes.push('The check digit does not validate, so this VIN may be mistyped — NHTSA decoded what it could.');
        if (!vehicle.make && !vehicle.model) {
          return { ok: false, reason: 'unknown', vehicle: vehicle, notes: notes,
                   message: 'NHTSA could not identify that VIN. Enter the details by hand.' };
        }
        if (r.ErrorText && /Unable to provide|not decoded/i.test(r.ErrorText) && !vehicle.model) {
          notes.push('NHTSA decoded the manufacturer but not the model.');
        }
        return { ok: true, vehicle: vehicle, notes: notes, checkDigitValid: checkOk };
      });
  }

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
      .replace(/\b(Suv|Mpv|Awd|Fwd|Rwd|4wd|Gt|Rs|Amg|Bmw|Gmc|Ev)\b/gi, function (m) { return m.toUpperCase(); });
  }

  /** DD/MM/YYYY, which is what the recalls API returns, into our day key. */
  function recallDateKey(s) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    return m[3] + '-' + m[2] + '-' + m[1];
  }

  /**
   * Open recall campaigns for a vehicle. Resolves to a record that is stored
   * on the vehicle itself, so it survives a reload and reads correctly with
   * no network at all.
   */
  function fetchRecalls(year, make, model) {
    var q = '?make=' + encodeURIComponent(String(make || '').trim()) +
            '&model=' + encodeURIComponent(String(model || '').trim()) +
            '&modelYear=' + encodeURIComponent(String(year || '').trim());
    return fetchJson(RECALLS_URL + q).then(function (data) {
      // vPIC capitalises `Results`; the recalls service does not. Read both.
      var rows = (data && (data.results || data.Results)) || [];
      return {
        checkedAt: new Date().toISOString(),
        query: { year: String(year || ''), make: String(make || ''), model: String(model || '') },
        count: rows.length,
        campaigns: rows.map(function (r) {
          return {
            id: firstNonEmpty(r.NHTSACampaignNumber),
            component: firstNonEmpty(r.Component),
            summary: firstNonEmpty(r.Summary),
            consequence: firstNonEmpty(r.Consequence),
            remedy: firstNonEmpty(r.Remedy),
            reported: recallDateKey(r.ReportReceivedDate),
            parkIt: !!r.parkIt,
            parkOutside: !!r.parkOutSide,
            overTheAir: !!r.overTheAirUpdate
          };
        })
      };
    });
  }

  /** Look up recalls for a saved vehicle and cache the answer on it. */
  function refreshRecalls(v) {
    if (!v) return Promise.reject(new Error('no_vehicle'));
    if (!v.year || !v.make || !v.model) {
      return Promise.reject(new Error('need_year_make_model'));
    }
    return fetchRecalls(v.year, v.make, v.model).then(function (rec) {
      v.recalls = rec;
      scheduleSave();
      return rec;
    });
  }

  /** How old a cached recall check is, so the UI never implies it is live. */
  function recallStatus(v) {
    var rec = v && v.recalls;
    if (!rec || !rec.checkedAt) return { checked: false };
    var days = Math.floor((Date.now() - new Date(rec.checkedAt).getTime()) / 86400000);
    return {
      checked: true,
      days: days,
      stale: days >= RECALL_STALE_DAYS,
      count: rec.count || 0,
      urgent: (rec.campaigns || []).some(function (c) { return c.parkIt || c.parkOutside; })
    };
  }

  function shiftDays(ymd, days) {
    var p = String(ymd).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + days);
    return dayKey(d);
  }

  /** Every service for a vehicle, most urgent first. */
  function vehicleDueList(v) {
    var rank = { overdue: 0, soon: 1, ok: 2, none: 3, off: 4 };
    return serviceTypesFor(v)
      .map(function (t) { return serviceDue(v, t); })
      .filter(function (d) { return d.status !== 'off'; })
      .sort(function (a, b) {
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        var am = a.remainingMiles == null ? Infinity : a.remainingMiles;
        var bm = b.remainingMiles == null ? Infinity : b.remainingMiles;
        return am - bm;
      });
  }

  /** The single most urgent item, for card summaries and the Drive score. */
  function topDue(v) {
    var list = vehicleDueList(v).filter(function (d) { return d.status !== 'none'; });
    return list.length ? list[0] : null;
  }

  // ---------------------------------------------------------------------
  // Reminders
  //
  // The Garage has always known when a service was due. It just had no way to
  // say so unless you happened to open the page, which is exactly backwards:
  // the reason an interval exists is that you forget.
  //
  // There is no server here and there is not going to be one, so this is
  // built from the only two things a static site is actually allowed to do:
  //
  //   showNotification   posted by the SERVICE WORKER rather than the page,
  //                      so it survives the tab being closed.
  //   periodicsync       the browser waking that worker on its own schedule.
  //                      Chromium only, installed apps only, and best-effort
  //                      by design — see registerPeriodicSync().
  //
  // A service worker cannot read localStorage, so it cannot recompute any of
  // this for itself. Instead the page writes a small digest into the Cache
  // API — the one store both sides can see — every time state is saved. The
  // worker then only compares dates. Every judgement about what counts as due
  // stays here, next to the data and next to serviceDue(), rather than being
  // duplicated into sw.js where it would quietly drift out of agreement.
  // ---------------------------------------------------------------------
  var REMINDER_CACHE = 'husllyfe-reminders';
  var DIGEST_URL     = '__husllyfe_reminders';
  var NOTIFIED_URL   = '__husllyfe_notified';
  var SYNC_TAG       = 'husllyfe-due-check';
  var SYNC_MIN_MS    = 24 * 60 * 60 * 1000;

  /**
   * HTML-escape a value that is about to be concatenated into innerHTML.
   *
   * Every vehicle make, movement name, account name and service note in this
   * app is free text the user typed, and several render paths build markup by
   * string concatenation. On its own that is somebody typing into their own
   * browser and harming nobody. It stops being harmless because HUSLLYFE
   * imports backup files: "open this backup" is a delivery route into a page
   * that holds income, balances and account names, on an origin with no
   * server in front of it. Escape at the point of interpolation.
   *
   * Quotes are escaped too, so a value is still safe inside an attribute.
   */
  function escapeHtml(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function vehicleTitle(v) {
    var s = [v.year, v.make, v.model].filter(Boolean).join(' ');
    return s || 'Your vehicle';
  }

  /** Human phrasing for one due item — whichever dimension actually bit. */
  function dueDetail(d) {
    var bits = [];
    if (d.remainingMiles != null) {
      bits.push(d.remainingMiles <= 0
        ? Math.abs(d.remainingMiles).toLocaleString() + ' mi over'
        : d.remainingMiles.toLocaleString() + ' mi to go');
    }
    if (d.remainingDays != null) {
      bits.push(d.remainingDays <= 0
        ? Math.abs(d.remainingDays) + ' days over'
        : 'by ' + d.dueOn);
    }
    return bits.join('  ·  ') || 'Due now.';
  }

  /**
   * Everything currently worth telling someone about, most urgent first.
   * Pure — reads state, writes nothing, so it is safe to call on every render.
   */
  function reminderItems() {
    var out = [];
    (state.vehicles || []).forEach(function (v) {
      vehicleDueList(v).forEach(function (d) {
        if (d.status !== 'overdue' && d.status !== 'soon') return;
        out.push({
          key: 'svc:' + v.id + ':' + d.type,
          kind: 'service',
          status: d.status,
          title: vehicleTitle(v) + ' — ' + d.type,
          detail: dueDetail(d)
        });
      });

      // An open recall is the one item here that is a safety matter rather
      // than a maintenance one, so a park-it campaign outranks everything.
      var rc = recallStatus(v);
      if (rc.checked && rc.count > 0) {
        out.push({
          key: 'recall:' + v.id + ':' + rc.count,
          kind: 'recall',
          status: rc.urgent ? 'overdue' : 'soon',
          title: vehicleTitle(v) + ' — ' + rc.count + ' open recall' + (rc.count === 1 ? '' : 's'),
          detail: rc.urgent
            ? 'A campaign says do not drive it until this is fixed.'
            : 'Free to have done at a franchised dealer.'
        });
      }
    });

    var rank = { overdue: 0, soon: 1 };
    return out.sort(function (a, b) {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      // Recalls above routine maintenance at the same urgency.
      if (a.kind !== b.kind) return a.kind === 'recall' ? -1 : 1;
      return 0;
    });
  }

  function overdueCount() {
    return reminderItems().filter(function (i) { return i.status === 'overdue'; }).length;
  }

  function hasCacheStore() {
    return typeof caches !== 'undefined' && caches && typeof caches.open === 'function';
  }

  /**
   * Mirror the digest to where the service worker can read it.
   *
   * Every failure here is swallowed on purpose. This runs on the same path as
   * every save, and a missing digest costs at most one notification, while a
   * thrown error would cost the record the user just entered.
   */
  function publishDigest() {
    if (!hasCacheStore()) return Promise.resolve(false);
    var body;
    try {
      body = JSON.stringify({ updated: todayKey(), items: reminderItems() });
    } catch (e) { return Promise.resolve(false); }
    return caches.open(REMINDER_CACHE).then(function (c) {
      return c.put(DIGEST_URL, new Response(body, {
        headers: { 'Content-Type': 'application/json' }
      }));
    }).then(function () { return true; })
      .catch(function () { return false; });
  }

  /** The count on the home-screen icon. Overdue only — "soon" is not a debt. */
  function refreshBadge() {
    if (!navigator.setAppBadge) return;
    var n = overdueCount();
    var p = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge();
    if (p && p.catch) p.catch(function () {});
  }

  function reminderSupport() {
    var standalone = false;
    try {
      standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                   navigator.standalone === true;
    } catch (e) {}
    return {
      notifications: typeof Notification !== 'undefined',
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
      periodicSync: 'serviceWorker' in navigator &&
                    typeof ServiceWorkerRegistration !== 'undefined' &&
                    'periodicSync' in ServiceWorkerRegistration.prototype,
      badge: !!navigator.setAppBadge,
      installed: standalone
    };
  }

  /**
   * Background checks are best-effort and the UI says so rather than
   * promising an alarm clock. The browser — not this code — decides how often
   * periodicsync actually fires, from how much you use the site, whether the
   * device is charged and whether it is on a network it has seen before. It
   * is allowed to fire never. That is why the in-app list stays the source of
   * truth and the notification is only ever a convenience on top of it.
   */
  function registerPeriodicSync() {
    var sup = reminderSupport();
    if (!sup.periodicSync) {
      return Promise.resolve({ ok: false, reason: 'unsupported',
        message: 'This browser only checks while the app is open.' });
    }
    return navigator.serviceWorker.ready.then(function (reg) {
      var q = (navigator.permissions && navigator.permissions.query)
        ? navigator.permissions.query({ name: 'periodic-background-sync' })
            .catch(function () { return { state: 'denied' }; })
        : Promise.resolve({ state: 'denied' });
      return q.then(function (st) {
        if (st.state !== 'granted') {
          return { ok: false, reason: 'permission',
            message: sup.installed
              ? 'The browser has not granted background checks yet — it grants them as you use the app.'
              : 'Install it to your home screen and background checks become available.' };
        }
        return reg.periodicSync.register(SYNC_TAG, { minInterval: SYNC_MIN_MS })
          .then(function () { return { ok: true, reason: 'registered', message: '' }; })
          .catch(function () {
            return { ok: false, reason: 'refused',
              message: 'The browser declined to schedule background checks.' };
          });
      });
    }).catch(function () {
      return { ok: false, reason: 'error',
        message: 'Background checks are unavailable here.' };
    });
  }

  function enableReminders() {
    var sup = reminderSupport();
    if (!sup.notifications) {
      return Promise.resolve({ ok: false, reason: 'unsupported',
        message: 'This browser cannot show notifications.' });
    }
    return Promise.resolve(Notification.requestPermission()).then(function (perm) {
      if (perm !== 'granted') {
        return { ok: false, reason: perm,
          message: perm === 'denied'
            ? 'Notifications are blocked for this site. They have to be switched back on in the browser’s own site settings.'
            : 'Nothing changed — the prompt was dismissed.' };
      }
      return publishDigest()
        .then(registerPeriodicSync)
        .then(function (sync) {
          refreshBadge();
          return {
            ok: true, background: sync.ok, reason: sync.reason,
            message: sync.ok
              ? 'Reminders on. The Garage checks daily, even with the app closed.'
              : 'Reminders on. ' + sync.message
          };
        });
    }).catch(function () {
      return { ok: false, reason: 'error', message: 'The browser refused the request.' };
    });
  }

  function disableReminders() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(true);
    return navigator.serviceWorker.ready.then(function (reg) {
      if (reg.periodicSync && reg.periodicSync.unregister) {
        return reg.periodicSync.unregister(SYNC_TAG).catch(function () {});
      }
    }).then(function () {
      if (navigator.clearAppBadge) {
        var p = navigator.clearAppBadge();
        if (p && p.catch) p.catch(function () {});
      }
      return true;
    }).catch(function () { return false; });
  }

  /**
   * Fire the same check the background wake would run, right now.
   *
   * Worth having as a button rather than only in the background, because
   * "did that actually work?" is otherwise unanswerable for up to a day, and
   * an unverifiable feature is one nobody trusts.
   */
  function testReminder() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return Promise.resolve({ ok: false, message: 'Turn reminders on first.' });
    }
    if (!('serviceWorker' in navigator)) {
      return Promise.resolve({ ok: false, message: 'No service worker on this page.' });
    }
    return publishDigest().then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      var items = reminderItems();
      if (!items.length) {
        return reg.showNotification('Nothing is due', {
          body: 'Every service on every vehicle is inside its interval. Reminders are working — this is what one looks like.',
          tag: 'husllyfe-due', icon: 'icon-512.png', badge: 'favicon.png',
          data: { url: 'garage.html' }
        }).then(function () { return { ok: true, message: 'Sent — nothing is actually due.' }; });
      }
      // Route through the worker so the test exercises the real path, not a
      // second copy of it that could pass while the real one is broken.
      if (reg.active) reg.active.postMessage({ type: 'husllyfe-check', force: true });
      return { ok: true, message: 'Sent — check your notification shade.' };
    }).catch(function () {
      return { ok: false, message: 'The browser refused to show it.' };
    });
  }

  // ---------------------------------------------------------------------
  // vehicle value history — a dated series rather than one overwritable
  // field, so depreciation is visible and cost per mile can include it.
  // ---------------------------------------------------------------------
  function valuations(v) {
    return (v.valuations || []).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
  }
  function currentValue(v) {
    var rows = valuations(v);
    if (rows.length) return Number(rows[rows.length - 1].value) || 0;
    return Number(v.value) || 0;
  }
  function addValuation(v, value, date) {
    v.valuations = v.valuations || [];
    var d = date || todayKey();
    var existing = v.valuations.filter(function (r) { return r.date === d; })[0];
    if (existing) { existing.value = Number(value) || 0; }
    else { v.valuations.push({ id: Date.now() + Math.floor(Math.random() * 1000), date: d, value: Number(value) || 0 }); }
    v.value = currentValue(v);   // keep the legacy field as a mirror
    return v.valuations;
  }

  /**
   * ownershipCost(v) — the number the whole category refuses to compute.
   * Fuel and service apps report cost per mile from outflows only, which
   * omits depreciation, usually the largest cost of owning anything.
   * Returns null where we genuinely cannot know rather than guessing.
   */
  function ownershipCost(v) {
    var purchase = Number(v.purchase) || 0;
    var value = currentValue(v);
    var service = (v.maintenance || []).reduce(function (a, r) { return a + (Number(r.cost) || 0); }, 0);
    var depreciation = purchase > 0 ? Math.max(0, purchase - value) : null;
    var out = {
      purchase: purchase, value: value, service: service,
      depreciation: depreciation,
      total: depreciation == null ? null : depreciation + service,
      milesDriven: null, perMile: null
    };
    var startMiles = Number(v.purchaseMileage);
    var nowMiles = Number(v.mileage) || 0;
    if (startMiles > 0 && nowMiles > startMiles) {
      out.milesDriven = nowMiles - startMiles;
      if (out.total != null) out.perMile = out.total / out.milesDriven;
    }
    return out;
  }

  function needleDeg(score) { return -80 + (score / 100) * 160; }
  function ringDeg(score) { return -180 + (score / 100) * 360; }

  // ---------------------------------------------------------------------
  // score banding — one traffic-light scale shared by every gauge on the site
  //   0-60 red / 61-89 yellow / 90-100 green
  // Bands are upper-bound inclusive and checked in order.
  // ---------------------------------------------------------------------
  var SCORE_BANDS = [
    { name: 'low',  max: 60,  color: 'var(--score-low)'  },
    { name: 'mid',  max: 89,  color: 'var(--score-mid)'  },
    { name: 'high', max: 100, color: 'var(--score-high)' }
  ];
  function scoreBand(score) {
    var s = clamp(Math.round(Number(score) || 0), 0, 100);
    for (var i = 0; i < SCORE_BANDS.length; i++) {
      if (s <= SCORE_BANDS[i].max) return SCORE_BANDS[i];
    }
    return SCORE_BANDS[SCORE_BANDS.length - 1];
  }
  function scoreColor(score) { return scoreBand(score).color; }

  // An engine with nothing logged has no score to show. Rather than render a
  // default as though it were a measurement, these dials go neutral.
  var NO_DATA_BAND = { name: 'none', max: null, color: 'var(--score-none)' };
  // Lifts count as Body evidence too: a user who logs strength but no cardio
  // sessions still has something real to score, and bodyScore() reweights
  // across whichever inputs have data.
  function hasBodyData()  { return (state.sessions || []).length > 0 || hasStrengthData(); }
  function hasDriveData() { return (state.vehicles || []).length > 0; }
  function isEmptyScore(score) { return score === null || score === undefined; }
  // Paints one readout. Every banded element's CSS reads var(--score-color)
  // with its original colour as the fallback, so an unpainted element is
  // unchanged rather than blank.
  function paintScore(el, score) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    var band = isEmptyScore(score) ? NO_DATA_BAND : scoreBand(score);
    el.style.setProperty('--score-color', band.color);
    el.setAttribute('data-score-band', band.name);
  }

  /**
   * Renders a whole dial: needle angle, band colour and the numeral inside it.
   * Pass null as the score when the engine has nothing to measure yet — the
   * dial goes neutral grey and reads "—" instead of showing a default as
   * though the user had earned it.
   */
  function paintDial(el, score) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    var empty = isEmptyScore(score);
    el.style.setProperty('--deg', ringDeg(empty ? 0 : score) + 'deg');
    paintScore(el, empty ? null : score);
    var num = el.querySelector('b');
    if (num) num.textContent = empty ? '—' : score;
  }

  /** Same idea as paintDial, for a plain text readout with no arc to draw. */
  function paintReadout(el, score) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    var empty = isEmptyScore(score);
    paintScore(el, empty ? null : score);
    el.textContent = empty ? '—' : score;
  }

  // ---------------------------------------------------------------------
  // toast (every page includes a toast element with id="toast")
  // ---------------------------------------------------------------------
  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  // ---------------------------------------------------------------------
  // load / save
  // ---------------------------------------------------------------------
  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 350);
  }
  function saveState() {
    if (!profiles.activeId) return Promise.resolve(null);
    return storageSet(stateKey(profiles.activeId), JSON.stringify(state)).then(function (res) {
      if (!res) showToast('Could not save — try removing a vehicle photo.');
      // The reminder digest is refreshed off the back of every save rather
      // than on a timer, so the service worker can never be reasoning about
      // a service you logged an hour ago. Deliberately not awaited: it must
      // never delay or fail the save it is riding on.
      publishDigest();
      refreshBadge();
      return res;
    }).catch(function () {
      showToast('Storage full — try smaller / fewer vehicle photos.');
      return null;
    });
  }
  function saveProfiles() {
    return storageSet(PROFILES_KEY, JSON.stringify(profiles));
  }
  function freshState() {
    var next = JSON.parse(JSON.stringify(DEFAULTS));
    next.lifts = freshLifts();   // DEFAULTS.lifts is a null placeholder: the
    return next;                 // movement list is defined further down.
  }

  function migrate(saved) {
    var accounts;
    if (Array.isArray(saved.accounts) && saved.accounts.length) {
      accounts = saved.accounts;
    } else if (saved.wealth && typeof saved.wealth.portfolioValue === 'number' && saved.wealth.portfolioValue > 0) {
      accounts = [{ id: Date.now(), name: 'Portfolio (migrated)', value: saved.wealth.portfolioValue }];
    } else {
      // Deliberately empty. Falling back to DEFAULTS.accounts here re-seeded
      // demo money into any save that had none, which is how a fresh install
      // ended up with a red Wealth score built from $458k nobody entered.
      accounts = [];
    }
    var next = {
      body: Object.assign({}, DEFAULTS.body, saved.body),
      sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
      deposits: Array.isArray(saved.deposits) ? saved.deposits : [],
      history: Array.isArray(saved.history) ? saved.history : [],
      wealth: Object.assign({}, DEFAULTS.wealth, saved.wealth),
      accounts: accounts,
      manualAssets: Array.isArray(saved.manualAssets) ? saved.manualAssets : [],
      vehicles: Array.isArray(saved.vehicles) ? saved.vehicles : [],
      setup: Object.assign({ done: false }, saved.setup),
      lifts: saved.lifts && Array.isArray(saved.lifts.movements) ? saved.lifts : freshLifts()
    };
    // The default movements must exist even in a save made before they did.
    DEFAULT_MOVEMENTS.forEach(function (d) {
      if (!next.lifts.movements.some(function (m) { return m.id === d.id; })) {
        next.lifts.movements.push({ id: d.id, name: d.name, group: d.group, custom: false, baseline: null });
      }
    });
    if (!Array.isArray(next.lifts.entries)) next.lifts.entries = [];
    if (typeof next.lifts.bodyweight !== 'number') next.lifts.bodyweight = 0;
    next.lifts.movements.forEach(function (m) {
      if (typeof m.bodyweight !== 'boolean') {
        var def = null;
        DEFAULT_MOVEMENTS.forEach(function (d) { if (d.id === m.id) def = d; });
        m.bodyweight = !!(def && def.bodyweight);
      }
    });
    if (next.lifts.unit !== 'kg') next.lifts.unit = 'lb';
    // The old 0-100 manual slider is gone; Strength Progress is computed now.
    delete next.body.strength;
    // Vehicle value went from one overwritable number to a dated series.
    // Anything saved before that gets its value stamped as the first reading,
    // so no history is invented and nothing is lost.
    next.vehicles.forEach(function (v) {
      if (!Array.isArray(v.valuations) || !v.valuations.length) {
        v.valuations = Number(v.value) > 0
          ? [{ id: 1, date: v.addedOn || todayKey(), value: Number(v.value) }]
          : [];
      }
      if (!v.intervals || typeof v.intervals !== 'object') v.intervals = {};
      if (typeof v.vin !== 'string') v.vin = '';
      // A cached NHTSA answer, or nothing. Never fabricated on migration.
      if (!v.recalls || typeof v.recalls !== 'object') v.recalls = null;
      if (v.duty !== 'severe') v.duty = 'standard';
      v.maintenance = Array.isArray(v.maintenance) ? v.maintenance : [];
    });
    delete next.wealth.portfolioValue;
    // Pre-log saves carried consistency/cardio/activity as stored sliders and
    // a WHOOP integration block. Both are gone — these are derived now.
    delete next.body.consistency;
    delete next.body.cardio;
    delete next.body.activity;
    // Saves made before the contribution-pattern choice existed were scored
    // as though every dollar landed on day one. 'spread' is both the honest
    // default and what the overwhelming majority of people actually do, so
    // an old save is migrated to it rather than grandfathered onto the model
    // that was understating it.
    if (CONTRIB_PATTERNS.indexOf(next.wealth.pattern) === -1) next.wealth.pattern = 'spread';
    // Wealth v2 inputs. Absent on every save made before the engine stopped
    // grading the market; both stay 0, which reads as 'no data' and lets the
    // dial go grey rather than scoring an old save against inputs it never had.
    if (typeof next.wealth.income !== 'number') next.wealth.income = 0;
    if (typeof next.wealth.monthlyCommit !== 'number') next.wealth.monthlyCommit = 0;
    if (typeof next.wealth.monthlyExpenses !== 'number') next.wealth.monthlyExpenses = 0;
    // Older saves were all on the flat guideline; that is exactly what an
    // unset target means, so nobody's score moves on upgrade.
    if (!(Number(next.wealth.savingsTarget) > 0)) next.wealth.savingsTarget = SAVINGS_RATE_TARGET;
    if (!(Number(next.wealth.cashMonths) > 0)) next.wealth.cashMonths = DEFAULT_CASH_MONTHS;
    // Ledger rows predate both flags. `cash` defaults to false rather than
    // being guessed from the row's name — "Cash Reserves" is a strong hint but
    // "Emergency" and "HYSA" are not, and a wrong guess here silently changes
    // a score. The user flags them; until they do, Invested Share reads the
    // whole ledger as invested and says so.
    ['accounts', 'manualAssets'].forEach(function (key) {
      next[key].forEach(function (r) {
        if (typeof r.cash !== 'boolean') r.cash = false;
        if (typeof r.er !== 'number') r.er = null;
      });
    });
    next.deposits = next.deposits.filter(function (r) { return r && r.date && Number(r.amount) > 0; });
    // Recovery is a manual input with no default. An old save that carries a
    // number keeps it — we cannot tell a touched slider from an untouched one
    // after the fact — but anything missing or malformed stays unset.
    if (typeof next.body.recovery !== 'number') next.body.recovery = null;
    return next;
  }

  // ---------------------------------------------------------------------
  // profiles
  //
  // Several people can use one browser without seeing each other's data.
  // This is separation, NOT security: anyone at this device can switch
  // profiles freely. Real access control needs a server, which this app
  // deliberately does not have.
  // ---------------------------------------------------------------------

  /** First run: adopt the old single-profile save if there is one. */
  function bootstrapProfiles() {
    return storageGet(LEGACY_KEY).then(function (res) {
      try { return migrate(JSON.parse(res.value)); } catch (e) { return null; }
    }).catch(function () {
      return null;
    }).then(function (adopted) {
      var id = newId();
      var idx = {
        version: 1,
        activeId: id,
        profiles: [{ id: id, name: adopted ? 'Curt' : 'Profile 1', created: new Date().toISOString() }]
      };
      // Write the state first. If this fails we have not yet claimed the
      // profile index, so the next load simply retries the migration.
      return storageSet(stateKey(id), JSON.stringify(adopted || freshState()))
        .then(function () { profiles = idx; return saveProfiles(); })
        .then(function () { return idx; });
    });
  }

  function readProfileIndex() {
    return storageGet(PROFILES_KEY).then(function (res) {
      var idx = JSON.parse(res.value);
      if (!idx || !Array.isArray(idx.profiles) || !idx.profiles.length) throw new Error('empty');
      if (!idx.profiles.some(function (p) { return p.id === idx.activeId; })) {
        idx.activeId = idx.profiles[0].id;   // active pointed at a deleted profile
      }
      return idx;
    });
  }

  /**
   * loadState(callback) — resolves the active profile, loads its state,
   * merges over defaults, then calls callback(state). Always calls back
   * exactly once, even with no storage at all.
   */
  function loadState(callback) {
    readProfileIndex()
      .catch(function () { return bootstrapProfiles(); })
      .then(function (idx) {
        profiles = idx;
        return storageGet(stateKey(idx.activeId)).then(function (res) {
          try { state = migrate(JSON.parse(res.value)); }
          catch (e) { state = freshState(); }
        }).catch(function () {
          state = freshState();   // profile exists but has never been written
        });
      })
      // Only a storage failure may reach here. Nothing past this point is
      // allowed to touch `state`: a render error must never be able to
      // replace loaded data with defaults, because the next autosave would
      // then write those defaults over the real thing.
      .catch(function () { state = freshState(); })
      .then(function () {
        try { renderProfileControl(); }
        catch (e) { /* no header on this page — cosmetic only */ }
        callback(state);
      });
  }

  function listProfiles() { return (profiles.profiles || []).slice(); }
  function activeProfile() {
    var list = profiles.profiles || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === profiles.activeId) return list[i];
    return null;
  }

  /** Persist current state, then reload the page under a different profile. */
  function switchProfile(id) {
    if (id === profiles.activeId) return Promise.resolve();
    clearTimeout(saveTimer);
    return saveState().then(function () {
      profiles.activeId = id;
      return saveProfiles();
    }).then(function () { location.reload(); });
  }

  function createProfile(name) {
    var id = newId();
    clearTimeout(saveTimer);
    return saveState().then(function () {
      return storageSet(stateKey(id), JSON.stringify(freshState()));
    }).then(function () {
      profiles.profiles.push({ id: id, name: name, created: new Date().toISOString() });
      profiles.activeId = id;
      return saveProfiles();
    }).then(function () { location.reload(); });
  }

  function renameProfile(id, name) {
    var list = profiles.profiles || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i].name = name;
    return saveProfiles().then(function () { renderProfileControl(); });
  }

  function deleteProfile(id) {
    if ((profiles.profiles || []).length < 2) {
      return Promise.reject(new Error('last_profile'));
    }
    profiles.profiles = profiles.profiles.filter(function (p) { return p.id !== id; });
    var wasActive = profiles.activeId === id;
    if (wasActive) profiles.activeId = profiles.profiles[0].id;
    return storageDelete(stateKey(id))
      .then(saveProfiles)
      .then(function () { location.reload(); });
  }

  /** Wipe the active profile back to defaults, leaving other profiles alone. */
  function resetState() {
    state = freshState();
    return saveState();
  }

  // ---------------------------------------------------------------------
  // export / import
  //
  // localStorage is cache the browser may evict without warning — clearing
  // site data, private windows, and iOS Safari's 7-day rule all wipe it.
  // These two functions are the only real backup this app has.
  // ---------------------------------------------------------------------
  function exportPayload() {
    var p = activeProfile();
    return {
      app: 'HUSLLYFE',
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      profile: p ? p.name : 'Profile',
      state: state
    };
  }

  function exportProfile() {
    var payload = exportPayload();
    var slug = (payload.profile || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var name = 'husllyfe-' + (slug || 'profile') + '-' + payload.exportedAt.slice(0, 10) + '.json';
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return name;
  }

  /** Throws a human-readable Error if the file is not one of ours. */
  function parseBackup(text) {
    var data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('That file is not valid JSON.'); }
    if (!data || typeof data !== 'object') throw new Error('That file is empty.');
    if (data.app !== 'HUSLLYFE') throw new Error('That is not a HUSLLYFE backup.');
    if (Number(data.format) > EXPORT_FORMAT) {
      throw new Error('That backup was made by a newer version of HUSLLYFE.');
    }
    if (!data.state || typeof data.state !== 'object') throw new Error('That backup has no data in it.');
    return data;
  }

  /**
   * importBackup(text, mode)
   *   'new'     — restore into a brand-new profile, touching nothing existing
   *   'replace' — overwrite the ACTIVE profile's data
   */
  function importBackup(text, mode) {
    var data = parseBackup(text);           // throws before anything is written
    var incoming = migrate(data.state);
    clearTimeout(saveTimer);

    if (mode === 'replace') {
      state = incoming;
      return saveState().then(function () { location.reload(); });
    }
    var id = newId();
    var base = (data.profile || 'Imported').slice(0, 40);
    var taken = (profiles.profiles || []).map(function (p) { return p.name; });
    var name = base, n = 2;
    while (taken.indexOf(name) > -1) { name = base + ' ' + (n++); }
    return saveState()
      .then(function () { return storageSet(stateKey(id), JSON.stringify(incoming)); })
      .then(function () {
        profiles.profiles.push({ id: id, name: name, created: new Date().toISOString() });
        profiles.activeId = id;
        return saveProfiles();
      })
      .then(function () { location.reload(); });
  }



  // ---------------------------------------------------------------------
  // first run
  //
  // Every product in this category solves the empty state by aggregating —
  // connect a bank, connect a watch, watch it fill in. With no accounts and
  // no integrations there is nothing to backfill from, so the only honest
  // options are to ask, or to show a worked example. This offers both, and
  // labels anything it infers as provisional rather than earned.
  // ---------------------------------------------------------------------
  var PROVISIONAL_SESSIONS = 3;   // below this the Body score is an estimate

  function needsSetup() {
    return !(state.setup && (state.setup.done || state.setup.skipped));
  }
  /** True while Body is running on a stated baseline rather than a real log. */
  function bodyIsProvisional() {
    return (state.sessions || []).length < PROVISIONAL_SESSIONS
        && !!(state.setup && state.setup.trainingDays > 0);
  }
  /**
   * First run asks ONE question, and it is about training.
   *
   * It used to ask for a ballpark portfolio value too, second of three, which
   * is the highest-friction thing you can ask a stranger — before the app has
   * done a single thing for them. Body is the engine that pays off fastest:
   * one logged session and the dial is live. Money is asked for on the Wealth
   * page, by someone who has already decided the app is worth the trouble.
   *
   * `answers.portfolio` is still accepted and still honoured if a caller
   * passes it, so an older entry point or a restored backup does not break —
   * the first-run card simply no longer asks.
   */
  function completeSetup(answers) {
    var trainingDays = Number(answers.trainingDays) || 0;
    state.setup = { done: true, trainingDays: trainingDays, at: new Date().toISOString() };
    // trainingCommitment() reads state.body.weeklyDays FIRST, and that field
    // is never null (DEFAULTS seeds it at 4) — so without this, the answer
    // given here was recorded but never actually graded against. A user who
    // said "5 days a week" stayed scored against the untouched default of 4
    // until they separately opened Body and touched its own slider. Setting
    // it here is what makes the first-run answer the live commitment, the
    // same way body.html's own weeklyDays control does when changed later.
    if (trainingDays > 0) {
      state.body.weeklyDays = clamp(Math.round(trainingDays), 1, 7);
    }
    if (Number(answers.portfolio) > 0) {
      state.accounts = [{ id: Date.now(), name: 'Portfolio', value: Number(answers.portfolio) }];
      state.manualAssets = [];
      // Contributions are NOT guessed from the balance. This used to assume
      // 80%, which is a 25% return the user never reported — and paired with
      // a default number of years it handed a brand-new account a Wealth 100.
      // The balance is a fact they gave us; what they paid in is not, so
      // Wealth stays unscored until they enter it on the Wealth page.
    }
    return saveState();
  }
  function skipSetup() {
    state.setup = { done: false, skipped: true };
    return saveState();
  }

  /** A worked example, clearly labelled, that the user can wipe in one click. */
  function loadDemoData() {
    var today = new Date();
    var sessions = [];
    // Eight weeks, deliberately improving: a patchy earlier month so the trend
    // lines under each meter have a previous window to compare against, then a
    // consistent recent month. The worked example should demonstrate the
    // features, not just populate them.
    var plan = [
      // recent 28 days — four sessions a week, mixed
      [0,'strength',55,'hard'],   [2,'run',35,'moderate'],  [4,'strength',60,'moderate'], [6,'cycle',45,'easy'],
      [7,'strength',50,'hard'],   [9,'hiit',30,'hard'],     [11,'strength',55,'moderate'],[13,'run',40,'moderate'],
      [14,'strength',60,'hard'],  [16,'row',35,'moderate'], [18,'strength',55,'moderate'],[20,'run',45,'hard'],
      [21,'strength',50,'moderate'],[23,'walk',40,'easy'],  [25,'strength',55,'hard'],    [27,'cycle',50,'easy'],
      // previous 28 days — twice a week, patchier
      [30,'strength',45,'easy'],  [34,'run',25,'easy'],
      [38,'strength',50,'moderate'], [42,'walk',30,'easy'],
      [45,'strength',45,'moderate'], [49,'run',30,'easy'],
      [52,'strength',40,'easy'],  [55,'cycle',35,'easy']
    ];
    plan.forEach(function (row, i) {
      sessions.push({
        id: Date.now() + i,
        date: dayKey(new Date(today.getTime() - row[0] * 86400000)),
        type: row[1], duration: row[2], intensity: row[3], notes: ''
      });
    });

    // Strength: a starting max per lift plus sessions above it, so the new
    // Strength page and the computed Strength Progress input both have
    // something real to show rather than an empty state.
    var liftPlan = [
      ['bench',    185, 5, [[28, 205, 5], [14, 215, 5], [3, 225, 5]]],
      ['ohp',      115, 5, [[24, 125, 5], [7, 130, 5]]],
      ['squat',    255, 5, [[30, 285, 5], [10, 305, 5]]],
      ['deadlift', 315, 3, [[26, 345, 3], [9, 365, 3]]],
      ['row',      155, 8, [[20, 165, 8]]],
      ['pullup',    25, 6, [[18, 35, 6], [4, 45, 5]]]
    ];
    var lifts = { unit: 'lb', bodyweight: 185, movements: [], entries: [] };
    DEFAULT_MOVEMENTS.forEach(function (def, mi) {
      var row = null;
      liftPlan.forEach(function (r) { if (r[0] === def.id) row = r; });
      lifts.movements.push({
        id: def.id, name: def.name, group: def.group, custom: false, bodyweight: !!def.bodyweight,
        baseline: row ? { weight: row[1], reps: row[2], date: shiftDays(todayKey(), -56), tested: false } : null
      });
      if (!row) return;
      row[3].forEach(function (e, ei) {
        lifts.entries.push({
          id: Date.now() + mi * 100 + ei, movementId: def.id,
          date: shiftDays(todayKey(), -e[0]), weight: e[1], reps: e[2], tested: false, notes: ''
        });
      });
    });

    var vid = Date.now() + 900;
    var vehicle = {
      id: vid, year: '2021', make: 'Porsche', model: 'Panamera', trim: '4S',
      mileage: '52000', purchaseMileage: '38000', purchase: '58500', value: '51200',
      annualCost: '6800', notes: 'Demo vehicle — remove it whenever you like.',
      photos: [], intervals: {}, duty: 'standard', valuations: [], addedOn: todayKey(),
      maintenance: [
        { id: vid + 1, type: 'Oil Change',    date: shiftDays(todayKey(), -40),  mileage: '49800', cost: '95',  notes: 'Synthetic' },
        { id: vid + 2, type: 'Tire Rotation', date: shiftDays(todayKey(), -40),  mileage: '49800', cost: '',    notes: 'DIY' },
        { id: vid + 3, type: 'Oil Change',    date: shiftDays(todayKey(), -260), mileage: '44100', cost: '88',  notes: '' },
        { id: vid + 4, type: 'Brake Service', date: shiftDays(todayKey(), -400), mileage: '41200', cost: '740', notes: 'Front pads and rotors' }
      ]
    };
    addValuation(vehicle, 58500, shiftDays(todayKey(), -560));
    addValuation(vehicle, 54200, shiftDays(todayKey(), -300));
    addValuation(vehicle, 51200, todayKey());

    state.sessions = sessions;
    state.vehicles = [vehicle];
    state.lifts = lifts;
    // Wealth belongs to the worked example too. It used to come from the app's
    // seeded defaults, which meant every user got it whether they asked for a
    // demo or not — the whole point of putting it here is that it arrives
    // labelled and leaves in one click.
    // $382,400 contributed evenly over six years, now worth $585,000 — a
    // 12.3% money-weighted return, which scores 64. Deliberately a good run
    // rather than a spectacular one: the example should look like a system
    // working with a visible weakest link, not like a winning lottery ticket.
    // The figures shipped before this were $458,122 on the same contributions,
    // which the day-one model reported as 3.1% and scored a red 34.
    // Expense ratios: a cheap index brokerage and a costlier workplace plan,
    // which is what most people actually have. Weighted, that lands at 0.31%
    // — over the 0.20% target but nowhere near punitive, so Cost Drag shows
    // as a meter with room in it rather than a pass/fail light.
    state.accounts = [
      { id: Date.now() + 910, name: 'Brokerage / IRA', value: 385000, cash: false, er: 0.06 },
      { id: Date.now() + 911, name: '401(k)',          value: 200000, cash: false, er: 0.78 }
    ];
    state.manualAssets = [
      { id: Date.now() + 920, name: 'Real Estate Equity', value: 120000, cash: false, er: null },
      { id: Date.now() + 921, name: 'Cash Reserves',      value: 25000,  cash: true,  er: null },
      { id: Date.now() + 922, name: 'Crypto',             value: 8000,   cash: false, er: null }
    ];
    // $6,500/month of expenses × 6 months = a $39,000 target against $25,000
    // held, so this example is UNDER its buffer rather than over it: Invested
    // Share is 100 and the page notes the shortfall as context instead of
    // grading it. Two opposite failures, one meter — only one of them is the
    // meter's business.
    state.wealth = { contributions: 382400, dividend: 8420, years: 6, benchmark: 8, pattern: 'spread',
                     income: 210000, monthlyCommit: 3200, monthlyExpenses: 6500, cashMonths: 6 };
    // Fourteen months of contributions against a $3,200/month commitment:
    // two months missed, two months short, one bonus. Consistency lands at
    // 91 and the savings rate at 100 — a good year with visible slippage,
    // which is what a worked example should show. A demo that scores a flat
    // 100 teaches nothing about what the meter is for.
    var depositPlan = [
      [0, 3200], [1, 3200], [2, 2000], [3, 6000], [4, 3200], [5, 0],
      [6, 3200], [7, 0],    [8, 3200], [9, 2400], [10, 3200], [11, 3200],
      [12, 3200], [13, 3200]
    ];
    state.deposits = [];
    depositPlan.forEach(function (row, i) {
      if (!row[1]) return;                       // the missed month
      state.deposits.push({
        id: Date.now() + 930 + i,
        date: shiftDays(todayKey(), -Math.round(row[0] * 30.44)),
        amount: row[1],
        note: row[1] > 3200 ? 'Bonus' : ''
      });
    });
    state.body = { recovery: 79, goal: 'strength', weeklyDays: 4 };
    state.setup = { done: true, demo: true, trainingDays: 4, at: new Date().toISOString() };
    return saveState();
  }
  function isDemo() { return !!(state.setup && state.setup.demo); }

  // ---------------------------------------------------------------------
  // backup nagging
  //
  // localStorage is a cache the browser is free to evict: clearing site data,
  // a private window, a new laptop, iOS Safari's 7-day rule. A maintenance
  // log's value is cumulative and back-loaded, so silent loss at year three
  // destroys the entire investment. Export is the only real backup here, and
  // an export nobody remembers to take is not a backup — hence the nag.
  // ---------------------------------------------------------------------
  var BACKUP_NAG_DAYS = 14;
  var NAG_DISMISS_KEY = 'husllyfe.nagDismissed';

  /**
   * Records worth losing — everything the user typed in, on every page.
   * This used to count sessions, vehicles and service records only, which
   * meant a user whose data was all on the Strength page (baselines, lifts,
   * bodyweight) or all in the Wealth ledger was never nagged at all. Their
   * data is exactly as evictable as everyone else's.
   */
  function meaningfulRecords() {
    var lifts = state.lifts || {};
    return (state.sessions || []).length
         + (state.deposits || []).length
         + (state.vehicles || []).length
         + (state.vehicles || []).reduce(function (a, v) { return a + (v.maintenance || []).length; }, 0)
         + (state.vehicles || []).reduce(function (a, v) { return a + (v.valuations || []).length; }, 0)
         + (lifts.entries || []).length
         + (lifts.movements || []).filter(function (m) { return !!m.baseline; }).length
         + (state.accounts || []).length
         + (state.manualAssets || []).length;
  }

  function backupStatus() {
    var p = activeProfile();
    var records = meaningfulRecords();
    var last = p && p.lastExportAt ? p.lastExportAt : null;
    var days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
    return {
      records: records,
      lastExportAt: last,
      daysSince: days,
      due: records > 0 && (last === null || days >= BACKUP_NAG_DAYS)
    };
  }

  function markExported() {
    var p = activeProfile();
    if (!p) return Promise.resolve();
    p.lastExportAt = new Date().toISOString();
    try { sessionStorage.removeItem(NAG_DISMISS_KEY); } catch (e) {}
    return saveProfiles();
  }

  /**
   * Renders the nag above the first <main> on any page that has one.
   * Dismissal lasts for the browser session only — the risk doesn't go away
   * just because the banner did.
   */
  function renderBackupNag() {
    var existing = document.getElementById('backupNag');
    if (existing) existing.remove();

    var s = backupStatus();
    if (!s.due) return;
    try { if (sessionStorage.getItem(NAG_DISMISS_KEY) === '1') return; } catch (e) {}

    var main = document.querySelector('main');
    if (!main) return;

    var bar = document.createElement('div');
    bar.className = 'backup-nag';
    bar.id = 'backupNag';

    var msg = s.lastExportAt
      ? 'Last backup was ' + s.daysSince + ' days ago. You have ' + s.records + ' record' + (s.records === 1 ? '' : 's') + ' saved in this browser only.'
      : 'You have ' + s.records + ' record' + (s.records === 1 ? '' : 's') + ' saved in this browser only, and no backup yet.';

    var text = document.createElement('div');
    text.className = 'bn-text';
    var strong = document.createElement('b');
    strong.textContent = 'Back up your data. ';
    text.appendChild(strong);
    text.appendChild(document.createTextNode(msg + ' Clearing site data or switching devices would lose it.'));

    var actions = document.createElement('div');
    actions.className = 'bn-actions';
    var go = document.createElement('button');
    go.className = 'btn primary bn-go';
    go.type = 'button';
    go.textContent = 'Download backup';
    go.addEventListener('click', function () {
      exportProfile();
      showToast('Backup downloaded');
      markExported().then(renderBackupNag);
    });
    var later = document.createElement('button');
    later.className = 'bn-later';
    later.type = 'button';
    later.textContent = 'Not now';
    later.addEventListener('click', function () {
      try { sessionStorage.setItem(NAG_DISMISS_KEY, '1'); } catch (e) {}
      bar.remove();
    });
    actions.appendChild(go); actions.appendChild(later);
    bar.appendChild(text); bar.appendChild(actions);
    main.insertBefore(bar, main.firstChild);
  }

  // ---------------------------------------------------------------------
  // profile control — injected into every page's header by app.js so the
  // five pages need no markup of their own.
  // ---------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent: profile names are user input
    return n;
  }

  function renderProfileControl() {
    var nav = document.querySelector('header .nav');
    if (!nav) return;

    var host = nav.querySelector('.profile-ctl');
    if (!host) {
      host = el('div', 'profile-ctl');
      var toggle = nav.querySelector('.nav-toggle');
      nav.insertBefore(host, toggle || null);
    }
    host.innerHTML = '';


    var active = activeProfile();
    var chip = el('button', 'profile-chip');
    chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'true');
    chip.setAttribute('aria-expanded', 'false');
    chip.appendChild(el('span', 'profile-initial', (active ? active.name : '?').trim().charAt(0).toUpperCase()));
    chip.appendChild(el('span', 'profile-name', active ? active.name : 'Profile'));
    chip.appendChild(el('span', 'profile-caret', '▾'));
    host.appendChild(chip);

    var panel = el('div', 'profile-panel');
    panel.hidden = true;
    host.appendChild(panel);

    // -- switch list -----------------------------------------------------
    panel.appendChild(el('div', 'pp-head', 'Switch profile'));
    var list = el('div', 'pp-list');
    listProfiles().forEach(function (p) {
      var b = el('button', 'pp-item' + (p.id === profiles.activeId ? ' current' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'pp-tick', p.id === profiles.activeId ? '●' : ''));
      b.appendChild(el('span', 'pp-item-name', p.name));
      b.addEventListener('click', function () { switchProfile(p.id); });
      list.appendChild(b);
    });
    panel.appendChild(list);

    // -- add ---------------------------------------------------------------
    var addRow = el('form', 'pp-add');
    var addInput = el('input');
    addInput.type = 'text'; addInput.placeholder = 'New profile name'; addInput.maxLength = 40;
    addInput.setAttribute('aria-label', 'New profile name');
    var addBtn = el('button', 'pp-add-btn', 'Add');
    addBtn.type = 'submit';
    addRow.appendChild(addInput); addRow.appendChild(addBtn);
    addRow.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = addInput.value.trim();
      if (!name) { addInput.focus(); return showToast('Give the profile a name'); }
      createProfile(name);
    });
    panel.appendChild(addRow);

    // -- this profile ------------------------------------------------------
    panel.appendChild(el('div', 'pp-sep'));
    panel.appendChild(el('div', 'pp-head', 'Backup'));

    function action(label, cls, fn) {
      var b = el('button', 'pp-action' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      panel.appendChild(b);
      return b;
    }

    action('Download backup', '', function () {
      var name = exportProfile();
      showToast('Saved ' + name);
      markExported().then(renderBackupNag);
    });

    var picker = el('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.hidden = true;
    host.appendChild(picker);
    var pendingMode = 'new';
    picker.addEventListener('change', function () {
      var file = picker.files && picker.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try { importBackup(String(reader.result), pendingMode); }
        catch (err) { showToast(err.message); }
        picker.value = '';
      };
      reader.onerror = function () { showToast('Could not read that file.'); picker.value = ''; };
      reader.readAsText(file);
    });

    action('Restore into a new profile…', '', function () {
      pendingMode = 'new'; picker.click();
    });
    action('Restore over this profile…', '', function () {
      if (!confirm('Replace ' + (active ? '“' + active.name + '”' : 'this profile') +
                   ' with the contents of a backup file? Its current data will be overwritten.')) return;
      pendingMode = 'replace'; picker.click();
    });

    panel.appendChild(el('div', 'pp-sep'));
    action('Rename profile…', '', function () {
      var name = prompt('Rename this profile', active ? active.name : '');
      if (name == null) return;
      name = name.trim();
      if (!name) return showToast('Name cannot be empty');
      renameProfile(profiles.activeId, name.slice(0, 40));
      showToast('Renamed');
    });
    var del = action('Delete this profile', 'danger', function () {
      if (listProfiles().length < 2) return showToast('This is your only profile');
      if (!confirm('Delete “' + (active ? active.name : '') + '” and everything in it?\n\n' +
                   'This cannot be undone. Download a backup first if you might want it back.')) return;
      deleteProfile(profiles.activeId).catch(function () { showToast('Could not delete that profile'); });
    });
    if (listProfiles().length < 2) del.disabled = true;

    panel.appendChild(el('p', 'pp-note',
      'Profiles keep data separate on this device. They are not passwords — anyone using this browser can switch between them.'));

    // -- open / close ------------------------------------------------------
    function close() { panel.hidden = true; chip.setAttribute('aria-expanded', 'false'); host.classList.remove('open'); }
    function open() { panel.hidden = false; chip.setAttribute('aria-expanded', 'true'); host.classList.add('open'); }
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden ? open() : close();
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // ---------------------------------------------------------------------
  // shared nav / footer wiring (mobile menu, active link, reset button)
  // Call HUSLLYFE.wireChrome() once per page after DOM is ready.
  // ---------------------------------------------------------------------
  /**
   * Generic collapsible sections. Any .disclosure-toggle[data-auto] just opens
   * and closes its own .disclosure; toggles without data-auto are left for the
   * page script (the Garage one reacts to saves and deletions too).
   */
  function wireDisclosures() {
    document.querySelectorAll('.disclosure-toggle[data-auto]').forEach(function (btn) {
      var wrap = btn.closest('.disclosure');
      var hint = btn.querySelector('.dt-hint');
      if (!wrap) return;
      var openText = hint && hint.getAttribute('data-open-text');
      var shutText = hint && hint.textContent;
      btn.addEventListener('click', function () {
        var open = wrap.classList.contains('collapsed');
        wrap.classList.toggle('collapsed', !open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (hint && openText) hint.textContent = open ? openText : shutText;
      });
    });
  }

  // ---------------------------------------------------------------------
  // installable app (service worker + home-screen install)
  // ---------------------------------------------------------------------
  /**
   * Registers sw.js so the site works with no signal and can be installed.
   *
   * Two guards, both deliberate. Service workers are unavailable over file://,
   * and calling register() there throws a security error into the console for
   * anyone who double-clicks index.html instead of running serve.bat — the app
   * still works, so the failure should be silent. And registration waits for
   * `load` so it never competes with the page's own first paint.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var p = location.protocol;
    if (p !== 'http:' && p !== 'https:') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  /**
   * The install button only exists if the browser says the app is installable.
   * Chrome fires beforeinstallprompt; iOS Safari never does (installing there
   * is Share → Add to Home Screen), so rather than show a button that cannot
   * work, nothing is rendered at all and the button is built on demand.
   */
  function wireInstallPrompt() {
    var deferred = null;
    var btn = null;

    function makeButton(foot) {
      var b = document.createElement('button');
      b.className = 'reset-btn';
      b.id = 'installBtn';
      b.type = 'button';
      b.textContent = 'Install app';
      b.title = 'Add HUSLLYFE to your home screen';
      b.addEventListener('click', function () {
        if (!deferred) return;
        var evt = deferred;
        deferred = null;
        b.disabled = true;
        evt.prompt();
        evt.userChoice.then(function (choice) {
          if (choice && choice.outcome === 'accepted') {
            b.remove();
          } else {
            // Declined — put the button back so it is there if they change
            // their mind. The event itself is spent and will not re-fire
            // until the next page load, so the button is disabled, not live.
            b.remove();
          }
        }).catch(function () { b.remove(); });
      });
      foot.appendChild(b);
      return b;
    }

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      var foot = document.querySelector('footer .wrap');
      if (foot && !btn) btn = makeButton(foot);
    });

    window.addEventListener('appinstalled', function () {
      if (btn) { btn.remove(); btn = null; }
      deferred = null;
      showToast('HUSLLYFE installed — it will open from your home screen.');
    });
  }

  function wireChrome() {
    wireDisclosures();
    registerServiceWorker();
    wireInstallPrompt();
    var navToggle = document.getElementById('navToggle');
    var mainNav = document.getElementById('mainNav');
    var navScrim = document.getElementById('navScrim');
    if (navToggle && mainNav && navScrim) {
      function closeNav() {
        navToggle.classList.remove('open'); mainNav.classList.remove('open'); navScrim.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
      function toggleNav() {
        var isOpen = mainNav.classList.toggle('open');
        navToggle.classList.toggle('open', isOpen);
        navScrim.classList.toggle('open', isOpen);
        navToggle.setAttribute('aria-expanded', String(isOpen));
      }
      navToggle.addEventListener('click', toggleNav);
      navScrim.addEventListener('click', closeNav);
      mainNav.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeNav); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNav(); });
    }

    var resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        var p = activeProfile();
        if (!confirm('Reset ' + (p ? '“' + p.name + '”' : 'this profile') + ' back to defaults?\n\n' +
                     'This clears its training log, wealth numbers and vehicles. Other profiles are untouched. ' +
                     'Download a backup first if you might want this data back.')) return;
        resetState().then(function () {
          showToast('Profile reset — reloading…');
          setTimeout(function () { location.reload(); }, 600);
        });
      });
    }
  }

  // ---------------------------------------------------------------------
  // generic editable ledger renderer, shared by Investment Accounts and
  // Manual Assets on wealth.html
  // ---------------------------------------------------------------------
  /**
   * One ledger. `opts.cash` adds a "cash" toggle to each row and `opts.er` an
   * expense-ratio field — both needed by Wealth, neither wanted anywhere else,
   * so they are opt-in rather than baked into the row.
   */
  function renderLedger(listElId, items, emptyLabel, onChange, onRemove, opts) {
    var list = document.getElementById(listElId);
    if (!list) return;
    opts = opts || {};
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="ledger-empty">' + emptyLabel + '</div>';
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'ledger-row';
      var name = document.createElement('span'); name.className = 'ledger-name'; name.textContent = item.name || 'Untitled'; name.title = item.name || 'Untitled';
      var right = document.createElement('div'); right.className = 'ledger-right';

      // Cash rows have no expense ratio to speak of, so the field appears and
      // disappears with the flag. Done by mutating this row rather than
      // re-rendering the ledger: a full redraw on every change would tear the
      // input the user is currently typing in out from under them.
      var cashBtn = null, er = null;
      function syncCashUi() {
        row.classList.toggle('is-cash', !!item.cash);
        if (cashBtn) {
          cashBtn.classList.toggle('on', !!item.cash);
          cashBtn.setAttribute('aria-pressed', item.cash ? 'true' : 'false');
          cashBtn.title = item.cash
            ? 'Counted as cash. Click to mark it as invested.'
            : 'Counted as invested. Click to mark it as cash or savings.';
        }
        if (er) er.style.display = item.cash ? 'none' : '';
      }

      if (opts.cash) {
        cashBtn = document.createElement('button');
        cashBtn.type = 'button';
        cashBtn.className = 'ledger-cash';
        cashBtn.textContent = 'CASH';
        cashBtn.addEventListener('click', function () {
          item.cash = !item.cash;
          syncCashUi();
          onChange();
        });
        right.appendChild(cashBtn);
      }

      if (opts.er) {
        er = document.createElement('input');
        er.type = 'number'; er.min = '0'; er.max = '5'; er.step = '0.01';
        er.className = 'ledger-er';
        er.placeholder = 'ER %';
        er.title = 'Expense ratio, e.g. 0.04 for a total-market index fund';
        er.value = (typeof item.er === 'number') ? item.er : '';
        er.addEventListener('input', function () {
          item.er = er.value === '' ? null : Math.max(0, Number(er.value) || 0);
          onChange();
        });
        right.appendChild(er);
      }
      syncCashUi();

      var val = document.createElement('input'); val.type = 'number'; val.min = '0'; val.step = '100'; val.value = item.value;
      val.className = 'ledger-value';
      val.addEventListener('input', function () { item.value = Number(val.value) || 0; onChange(); });
      var remove = document.createElement('button'); remove.className = 'ledger-remove'; remove.setAttribute('aria-label', 'Remove'); remove.textContent = '✕';
      remove.addEventListener('click', function () { onRemove(item.id); });
      right.appendChild(val); right.appendChild(remove);
      row.appendChild(name); row.appendChild(right);
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------
  global.HUSLLYFE = {
    DEFAULTS: DEFAULTS,
    GOAL_WEIGHTS: GOAL_WEIGHTS,
    GOAL_LABELS: GOAL_LABELS,
    SESSION_TYPES: SESSION_TYPES,
    INTENSITIES: INTENSITIES,
    sessionType: sessionType,
    intensity: intensity,
    getState: function () { return state; },
    loadState: loadState,
    scheduleSave: scheduleSave,
    saveState: saveState,
    resetState: resetState,
    listProfiles: listProfiles,
    activeProfile: activeProfile,
    switchProfile: switchProfile,
    createProfile: createProfile,
    renameProfile: renameProfile,
    deleteProfile: deleteProfile,
    exportProfile: exportProfile,
    exportPayload: exportPayload,
    parseBackup: parseBackup,
    importBackup: importBackup,
    renderProfileControl: renderProfileControl,
    clamp: clamp, money: money, numberFmt: numberFmt, pct: pct, estimateBytes: estimateBytes,
    STORAGE_LIMIT_BYTES: STORAGE_LIMIT_BYTES,
    bodyScore: bodyScore,
    bodyInputs: bodyInputs,
    derivedBody: derivedBody,
    recentSessions: recentSessions,
    addSession: addSession,
    removeSession: removeSession,
    todayKey: todayKey,
    accountsTotal: accountsTotal,
    manualAssetsTotal: manualAssetsTotal,
    wealthMetrics: wealthMetrics,
    wealthInputs: wealthInputs,
    wealthActiveWeights: wealthActiveWeights,
    contributionMetrics: contributionMetrics,
    returnContext: returnContext,
    deposits: deposits,
    addDeposit: addDeposit,
    removeDeposit: removeDeposit,
    monthlyCommitment: monthlyCommitment,
    grossIncome: grossIncome,
    SAVINGS_RATE_TARGET: SAVINGS_RATE_TARGET,
    SAVINGS_TARGET_MAX: SAVINGS_TARGET_MAX,
    savingsTarget: savingsTarget,
    savingsTargetIsRaised: savingsTargetIsRaised,
    investedShareMetrics: investedShareMetrics,
    expenseRatioMetrics: expenseRatioMetrics,
    cashTotal: cashTotal,
    investedTotal: investedTotal,
    MIN_MONTHLY_EXPENSES: MIN_MONTHLY_EXPENSES,
    statedMonthlyExpenses: statedMonthlyExpenses,
    monthlyExpenses: monthlyExpenses,
    usingExpenseFloor: usingExpenseFloor,
    ER_TARGET: ER_TARGET,
    ER_ZERO: ER_ZERO,
    WEALTH_KEYS: WEALTH_KEYS,
    WEALTH_WEIGHTS: WEALTH_WEIGHTS,
    contributionPattern: contributionPattern,
    CONTRIB_PATTERNS: CONTRIB_PATTERNS,
    wealthScore: wealthScore,
    netWorthProxy: netWorthProxy,
    vehicleScore: vehicleScore,
    projectedDriveScore: projectedDriveScore,
    maintenanceFactor: maintenanceFactor,
    fleetValue: fleetValue,
    fleetAnnualCost: fleetAnnualCost,
    affordability: affordability,
    CAR_COST_FREE: CAR_COST_FREE,
    fleetRatioPenalty: fleetRatioPenalty,
    driveScore: driveScore,
    avgDriveRatio: avgDriveRatio,
    overallScore: overallScore,
    scoreHistory: scoreHistory,
    recordSnapshot: recordSnapshot,
    historyTrend: historyTrend,
    nextActions: nextActions,
    needleDeg: needleDeg,
    ringDeg: ringDeg,
    SCORE_BANDS: SCORE_BANDS,
    scoreBand: scoreBand,
    scoreColor: scoreColor,
    paintScore: paintScore,
    paintDial: paintDial,
    paintReadout: paintReadout,
    hasBodyData: hasBodyData,
    hasDriveData: hasDriveData,
    hasWealthData: hasWealthData,
    SERVICE_SCHEDULE: SERVICE_SCHEDULE,
    serviceInterval: serviceInterval,
    intervalSource: intervalSource,
    makeSchedule: makeSchedule,
    makeScheduleLabel: makeScheduleLabel,
    MAKE_INTERVALS: MAKE_INTERVALS,
    normalizeVin: normalizeVin,
    isValidVin: isValidVin,
    decodeVin: decodeVin,
    fetchRecalls: fetchRecalls,
    refreshRecalls: refreshRecalls,
    recallStatus: recallStatus,
    RECALL_STALE_DAYS: RECALL_STALE_DAYS,
    serviceTypesFor: serviceTypesFor,
    lastServiceOf: lastServiceOf,
    serviceDue: serviceDue,
    vehicleDueList: vehicleDueList,
    topDue: topDue,
    reminderItems: reminderItems,
    overdueCount: overdueCount,
    reminderSupport: reminderSupport,
    enableReminders: enableReminders,
    disableReminders: disableReminders,
    testReminder: testReminder,
    publishDigest: publishDigest,
    refreshBadge: refreshBadge,
    vehicleTitle: vehicleTitle,
    esc: escapeHtml,
    mileageRate: mileageRate,
    shiftDays: shiftDays,
    daysBetween: daysBetween,
    valuations: valuations,
    currentValue: currentValue,
    addValuation: addValuation,
    ownershipCost: ownershipCost,
    bodyTrend: bodyTrend,
    bodyActiveWeights: bodyActiveWeights,
    e1rm: e1rm,
    repsAreReliable: repsAreReliable,
    MAX_VALID_REPS: MAX_VALID_REPS,
    REPS_ACCURACY_LIMIT: REPS_ACCURACY_LIMIT,
    liftMovements: liftMovements,
    liftMovement: liftMovement,
    liftEntries: liftEntries,
    movementProgress: movementProgress,
    strengthProgressList: strengthProgressList,
    strengthProgress: strengthProgress,
    averageGainPct: averageGainPct,
    strengthStaleness: strengthStaleness,
    hasStrengthData: hasStrengthData,
    addLiftEntry: addLiftEntry,
    setBaseline: setBaseline,
    addMovement: addMovement,
    removeMovement: removeMovement,
    liftUnit: liftUnit,
    setLiftUnit: setLiftUnit,
    weightFmt: weightFmt,
    liftBodyweight: liftBodyweight,
    setBodyweight: setBodyweight,
    movementExtraLoad: movementExtraLoad,
    needsBodyweight: needsBodyweight,
    anyNeedsBodyweight: anyNeedsBodyweight,
    trainingCommitment: trainingCommitment,
    ADHERENCE_WINDOW_DAYS: ADHERENCE_WINDOW_DAYS,
    WEEKLY_STRENGTH_DAYS: WEEKLY_STRENGTH_DAYS,
    needsSetup: needsSetup,
    bodyIsProvisional: bodyIsProvisional,
    completeSetup: completeSetup,
    skipSetup: skipSetup,
    loadDemoData: loadDemoData,
    isDemo: isDemo,
    backupStatus: backupStatus,
    markExported: markExported,
    renderBackupNag: renderBackupNag,
    showToast: showToast,
    wireChrome: wireChrome,
    renderLedger: renderLedger,
    usingLocalStorageFallback: !hasWindowStorage && hasLocalStorage,
    hasAnyStorage: hasWindowStorage || hasLocalStorage
  };
})(window);

