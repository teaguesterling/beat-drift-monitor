/**
 * Beat Drift Monitor - Core Algorithm
 *
 * PLL-based beat grid tracker that detects tempo drift relative to a
 * calibrated reference tempo.
 *
 * @version 2.1.0
 * @see ALGORITHM.md for specification
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export const CONSTANTS = {
  CAL_BEATS: 8,              // Onsets required for calibration
  ADAPT_FAST: 0.08,          // Period adaptation rate
  ADAPT_SLOW: 0.005,         // Target period adaptation rate
  GRID_TOLERANCE: 0.35,      // Fraction of period that counts as "on-grid"
  SILENCE_TIMEOUT_MS: 4000,  // Gap before WAITING state
  PERIOD_HISTORY: 12,        // Recent periods to store
  MIN_PERIOD_MS: 200,        // ~300 BPM
  MAX_PERIOD_MS: 1500,       // ~40 BPM
};

// ============================================================================
// STATE ENUM
// ============================================================================

export const State = {
  IDLE: 'IDLE',
  CALIBRATING: 'CALIBRATING',
  TRACKING: 'TRACKING',
  WAITING: 'WAITING'
};

// ============================================================================
// DEBUG TRACE
// ============================================================================

/**
 * Creates a trace buffer that records onset processing details.
 * @param {number} maxSize - Maximum trace entries to keep
 * @returns {object} Trace buffer interface
 */
export function createTraceBuffer(maxSize = 1000) {
  const entries = [];

  return {
    add(entry) {
      entries.push({ ...entry, _index: entries.length });
      if (entries.length > maxSize) {
        entries.shift();
      }
    },

    getAll() {
      return [...entries];
    },

    getLast(n = 1) {
      return entries.slice(-n);
    },

    clear() {
      entries.length = 0;
    },

    get length() {
      return entries.length;
    },

    // Export as CSV for analysis
    toCSV() {
      if (entries.length === 0) return '';

      const headers = Object.keys(entries[0]).filter(k => !k.startsWith('_'));
      const lines = [headers.join(',')];

      for (const entry of entries) {
        const values = headers.map(h => {
          const v = entry[h];
          if (v === null || v === undefined) return '';
          if (typeof v === 'string') return `"${v}"`;
          if (typeof v === 'number') return v.toFixed(4);
          if (typeof v === 'boolean') return v ? '1' : '0';
          return String(v);
        });
        lines.push(values.join(','));
      }

      return lines.join('\n');
    },

    // Export as JSON
    toJSON() {
      return JSON.stringify(entries, null, 2);
    }
  };
}

// ============================================================================
// BEAT TRACKER
// ============================================================================

/**
 * Creates a beat tracker instance.
 *
 * @param {object} options
 * @param {function} options.onUpdate - Callback for state updates
 * @param {object} options.trace - Optional trace buffer
 * @param {object} options.constants - Optional constant overrides
 * @returns {object} Beat tracker interface
 */
export function createBeatTracker(options = {}) {
  const {
    onUpdate = () => {},
    trace = null,
    constants = {}
  } = options;

  // Merge constants with defaults
  const C = { ...CONSTANTS, ...constants };

  // ---- State ----
  let period = 0;            // ms between beats
  let phase = 0;             // timestamp of last grid alignment
  let targetPeriod = 0;      // slowly-adapting reference period
  let confidence = 0;        // 0-1 lock quality

  // Calibration
  let calOnsets = [];
  let state = State.IDLE;

  // Statistics
  let onsetCount = 0;
  let gridHits = 0;
  let gridMisses = 0;
  let recentPeriods = [];

  // Silence detection
  let lastOnsetTime = 0;
  let silenceCheckInterval = null;

  // ---- Internal helpers ----

  function emitUpdate() {
    const currentBpm = period > 0 ? 60000 / period : null;
    const targetBpm = targetPeriod > 0 ? 60000 / targetPeriod : null;
    const drift = (currentBpm && targetBpm) ? currentBpm - targetBpm : 0;

    const data = {
      state,
      currentBpm: currentBpm ? Math.round(currentBpm * 10) / 10 : null,
      targetBpm: targetBpm ? Math.round(targetBpm * 10) / 10 : null,
      drift: Math.round(drift * 10) / 10,
      confidence: Math.round(confidence * 100),
      beatCount: calOnsets.length,
      calibrationNeeded: C.CAL_BEATS,
      gridHits,
      gridMisses,
      period,
      targetPeriod
    };

    onUpdate(data);
    return data;
  }

  function traceOnset(entry) {
    if (trace) {
      trace.add(entry);
    }
  }

  /**
   * Find the dominant period from a set of intervals.
   * Handles missed beats by clustering at fundamental and multiples.
   */
  function findDominantPeriod(intervals) {
    if (intervals.length === 0) return 0;

    const sorted = [...intervals].sort((a, b) => a - b);
    const valid = sorted.filter(i => i > C.MIN_PERIOD_MS && i < 2000);
    if (valid.length === 0) return 0;

    // Take lower 60% as candidates for base period
    const candidates = valid.slice(0, Math.max(1, Math.ceil(valid.length * 0.6)));
    const candidateMedian = candidates[Math.floor(candidates.length / 2)];

    // Verify: do larger intervals cluster at 2x, 3x?
    let score = 0;
    for (const iv of valid) {
      const ratio = iv / candidateMedian;
      const nearestInt = Math.round(ratio);
      const fractionalError = Math.abs(ratio - nearestInt);
      if (fractionalError < 0.15 && nearestInt >= 1 && nearestInt <= 4) {
        score++;
      }
    }

    if (score >= valid.length * 0.5) {
      return candidateMedian;
    }

    // Fallback: simple median
    return valid[Math.floor(valid.length / 2)];
  }

  // ---- Public API ----

  function reset() {
    period = 0;
    phase = 0;
    targetPeriod = 0;
    confidence = 0;
    calOnsets = [];
    recentPeriods = [];
    onsetCount = 0;
    gridHits = 0;
    gridMisses = 0;
    state = State.CALIBRATING;
    emitUpdate();
  }

  function enterWaiting() {
    state = State.WAITING;
    confidence = 0;
    emitUpdate();
  }

  function startSilenceWatch(getTime = () => performance.now()) {
    if (silenceCheckInterval) clearInterval(silenceCheckInterval);
    silenceCheckInterval = setInterval(() => {
      if (state === State.IDLE) return;

      const now = getTime();
      const gap = now - lastOnsetTime;

      if (lastOnsetTime > 0 && gap > C.SILENCE_TIMEOUT_MS) {
        if (state === State.TRACKING || state === State.CALIBRATING) {
          enterWaiting();
        }
      }
    }, 500);
  }

  function stopSilenceWatch() {
    if (silenceCheckInterval) {
      clearInterval(silenceCheckInterval);
      silenceCheckInterval = null;
    }
  }

  function addOnset(timestamp) {
    lastOnsetTime = timestamp;
    onsetCount++;

    // Capture state before processing
    const periodBefore = period;
    const targetPeriodBefore = targetPeriod;

    // If waiting between songs, start fresh calibration
    if (state === State.WAITING) {
      calOnsets = [timestamp];
      state = State.CALIBRATING;

      traceOnset({
        timestamp,
        state,
        event: 'resume_from_waiting',
        periodBefore,
        periodAfter: period,
        targetPeriodBefore,
        targetPeriodAfter: targetPeriod,
        confidence,
        onsetCount
      });

      emitUpdate();
      return;
    }

    // ---- CALIBRATION PHASE ----
    if (state === State.CALIBRATING) {
      calOnsets.push(timestamp);

      if (calOnsets.length < C.CAL_BEATS + 1) {
        traceOnset({
          timestamp,
          state,
          event: 'calibrating',
          beatCount: calOnsets.length,
          calibrationNeeded: C.CAL_BEATS,
          onsetCount
        });

        emitUpdate();
        return;
      }

      // Compute intervals and find dominant period
      const intervals = [];
      for (let i = 1; i < calOnsets.length; i++) {
        intervals.push(calOnsets[i] - calOnsets[i - 1]);
      }

      const basePeriod = findDominantPeriod(intervals);

      if (basePeriod > 0) {
        period = basePeriod;
        targetPeriod = basePeriod;
        phase = timestamp;
        confidence = 0.5;
        recentPeriods = [basePeriod];
        state = State.TRACKING;

        traceOnset({
          timestamp,
          state,
          event: 'calibration_complete',
          intervals: intervals.join(';'),
          basePeriod,
          periodAfter: period,
          targetPeriodAfter: targetPeriod,
          currentBpm: 60000 / period,
          targetBpm: 60000 / targetPeriod,
          drift: 0,
          confidence: confidence * 100,
          onsetCount
        });
      }

      emitUpdate();
      return;
    }

    // ---- TRACKING PHASE ----
    if (state !== State.TRACKING || period === 0) return;

    // Grid position calculation
    const timeSincePhase = timestamp - phase;
    const beatFraction = timeSincePhase / period;
    const nearestBeat = Math.round(beatFraction);
    const offset = beatFraction - nearestBeat; // -0.5 to +0.5
    const absOffset = Math.abs(offset);

    let impliedPeriod = 0;
    let onGrid = false;
    let event = 'off_grid';

    if (absOffset < C.GRID_TOLERANCE) {
      // ---- ON-GRID HIT ----
      onGrid = true;
      event = 'on_grid';
      gridHits++;

      impliedPeriod = timeSincePhase / nearestBeat;

      // Validate implied period
      if (impliedPeriod > C.MIN_PERIOD_MS && impliedPeriod < C.MAX_PERIOD_MS && nearestBeat > 0) {
        // Fast adaptation: track current tempo
        period = period + C.ADAPT_FAST * (impliedPeriod - period);

        // Slow adaptation: running recalibration of target
        targetPeriod = targetPeriod + C.ADAPT_SLOW * (period - targetPeriod);

        // Phase correction: snap grid toward this onset
        phase = timestamp - (nearestBeat * period) + (offset * period * 0.3);

        // Track for smoothing
        recentPeriods.push(impliedPeriod);
        if (recentPeriods.length > C.PERIOD_HISTORY) recentPeriods.shift();

        // Increase confidence
        confidence = Math.min(1, confidence + 0.05);
      }
    } else {
      // ---- OFF-GRID HIT ----
      gridMisses++;
      confidence = Math.max(0, confidence - 0.02);
    }

    // Half-tempo detection
    if (nearestBeat >= 2 && gridHits > 8) {
      // Simplified: if we're consistently seeing beats at every other grid line
      // This would need more sophisticated tracking in practice
    }

    // Double-tempo detection
    if (absOffset > 0.35 && absOffset < 0.65 && gridMisses > gridHits * 0.5 && gridMisses > 6) {
      const halfPeriod = period / 2;
      if (halfPeriod > C.MIN_PERIOD_MS) {
        event = 'double_tempo_correction';
        period = halfPeriod;
        targetPeriod = halfPeriod;
        recentPeriods = recentPeriods.map(p => p / 2);
        phase = timestamp;
        gridHits = 0;
        gridMisses = 0;
        confidence = Math.max(0.3, confidence - 0.2);
      }
    }

    // Calculate outputs
    const currentBpm = 60000 / period;
    const targetBpm = 60000 / targetPeriod;
    const drift = currentBpm - targetBpm;

    traceOnset({
      timestamp,
      state,
      event,
      onGrid,
      nearestBeat,
      offset: Math.round(offset * 1000) / 1000,
      impliedPeriod: impliedPeriod ? Math.round(impliedPeriod * 100) / 100 : null,
      periodBefore: Math.round(periodBefore * 100) / 100,
      periodAfter: Math.round(period * 100) / 100,
      targetPeriodBefore: Math.round(targetPeriodBefore * 100) / 100,
      targetPeriodAfter: Math.round(targetPeriod * 100) / 100,
      currentBpm: Math.round(currentBpm * 100) / 100,
      targetBpm: Math.round(targetBpm * 100) / 100,
      drift: Math.round(drift * 100) / 100,
      confidence: Math.round(confidence * 100),
      gridHits,
      gridMisses,
      onsetCount
    });

    emitUpdate();
  }

  function setTarget(bpm) {
    targetPeriod = 60000 / bpm;
    period = targetPeriod;
    phase = performance.now();
    confidence = 0.7;
    state = State.TRACKING;
    calOnsets = new Array(C.CAL_BEATS + 1).fill(0);
    emitUpdate();
  }

  function destroy() {
    stopSilenceWatch();
  }

  // ---- Getters for testing ----

  function getState() {
    return {
      state,
      period,
      phase,
      targetPeriod,
      confidence,
      gridHits,
      gridMisses,
      onsetCount,
      calOnsets: [...calOnsets],
      recentPeriods: [...recentPeriods]
    };
  }

  return {
    addOnset,
    setTarget,
    reset,
    startSilenceWatch,
    stopSilenceWatch,
    destroy,
    getState,
    get constants() { return { ...C }; }
  };
}

// ============================================================================
// SYNTHETIC ONSET GENERATORS
// ============================================================================

/**
 * Generate onset timestamps for a perfect tempo.
 * @param {number} bpm - Beats per minute
 * @param {number} beats - Number of beats to generate
 * @param {number} startTime - Start timestamp (ms)
 * @returns {number[]} Array of onset timestamps
 */
export function generatePerfectTempo(bpm, beats, startTime = 0) {
  const period = 60000 / bpm;
  const onsets = [];
  for (let i = 0; i < beats; i++) {
    onsets.push(startTime + i * period);
  }
  return onsets;
}

/**
 * Generate onset timestamps with linear tempo drift.
 * @param {number} startBpm - Starting tempo
 * @param {number} endBpm - Ending tempo
 * @param {number} beats - Number of beats
 * @param {number} startTime - Start timestamp (ms)
 * @returns {number[]} Array of onset timestamps
 */
export function generateLinearDrift(startBpm, endBpm, beats, startTime = 0) {
  const onsets = [startTime];
  let t = startTime;

  for (let i = 1; i < beats; i++) {
    // Linear interpolation of BPM
    const progress = i / (beats - 1);
    const currentBpm = startBpm + (endBpm - startBpm) * progress;
    const period = 60000 / currentBpm;
    t += period;
    onsets.push(t);
  }

  return onsets;
}

/**
 * Generate onset timestamps with a sudden tempo change.
 * @param {number} bpm1 - First section tempo
 * @param {number} beats1 - Beats in first section
 * @param {number} bpm2 - Second section tempo
 * @param {number} beats2 - Beats in second section
 * @param {number} startTime - Start timestamp (ms)
 * @returns {object} { onsets, changeIndex }
 */
export function generateSuddenChange(bpm1, beats1, bpm2, beats2, startTime = 0) {
  const section1 = generatePerfectTempo(bpm1, beats1, startTime);
  const lastTime = section1[section1.length - 1];
  const period2 = 60000 / bpm2;
  const section2 = generatePerfectTempo(bpm2, beats2, lastTime + period2);

  return {
    onsets: [...section1, ...section2],
    changeIndex: beats1
  };
}

/**
 * Generate onset timestamps with missed beats.
 * @param {number} bpm - Tempo
 * @param {number} beats - Total beats
 * @param {number[]} missIndices - Which beat indices to skip
 * @param {number} startTime - Start timestamp (ms)
 * @returns {number[]} Array of onset timestamps
 */
export function generateWithMissedBeats(bpm, beats, missIndices, startTime = 0) {
  const all = generatePerfectTempo(bpm, beats, startTime);
  const missSet = new Set(missIndices);
  return all.filter((_, i) => !missSet.has(i));
}

/**
 * Generate onset timestamps with timing jitter.
 * @param {number} bpm - Base tempo
 * @param {number} beats - Number of beats
 * @param {number} jitterMs - Maximum jitter in ms (uniform distribution)
 * @param {number} startTime - Start timestamp (ms)
 * @returns {number[]} Array of onset timestamps
 */
export function generateWithJitter(bpm, beats, jitterMs, startTime = 0) {
  const base = generatePerfectTempo(bpm, beats, startTime);
  return base.map(t => t + (Math.random() - 0.5) * 2 * jitterMs);
}

// ============================================================================
// TEST RUNNER
// ============================================================================

/**
 * Run a test scenario against the beat tracker.
 * @param {object} scenario - Test scenario definition
 * @param {object} options - Tracker options
 * @returns {object} Test results
 */
export function runScenario(scenario, options = {}) {
  const trace = createTraceBuffer(10000);
  const updates = [];

  const tracker = createBeatTracker({
    onUpdate: (data) => updates.push({ ...data }),
    trace,
    constants: options.constants || {}
  });

  tracker.reset();

  // Generate onsets based on scenario type
  let onsets = scenario.onsets;

  if (scenario.generator) {
    const gen = scenario.generator;
    switch (gen.type) {
      case 'perfect':
        onsets = generatePerfectTempo(gen.bpm, gen.beats, 0);
        break;
      case 'linear_drift':
        onsets = generateLinearDrift(gen.start_bpm, gen.end_bpm, gen.beats, 0);
        break;
      case 'sudden_change':
        const result = generateSuddenChange(gen.bpm1, gen.beats1, gen.bpm2, gen.beats2, 0);
        onsets = result.onsets;
        break;
      case 'missed_beats':
        onsets = generateWithMissedBeats(gen.bpm, gen.beats, gen.miss_indices, 0);
        break;
      case 'jitter':
        onsets = generateWithJitter(gen.bpm, gen.beats, gen.jitter_ms, 0);
        break;
    }
  }

  // Feed onsets to tracker
  for (const timestamp of onsets) {
    tracker.addOnset(timestamp);
  }

  // Evaluate expectations
  const results = {
    scenario: scenario.name,
    passed: true,
    checks: [],
    trace: trace.getAll(),
    updates,
    finalState: tracker.getState()
  };

  if (scenario.expectations) {
    for (const exp of scenario.expectations) {
      const afterIdx = exp.after_onset - 1;
      if (afterIdx >= 0 && afterIdx < updates.length) {
        const update = updates[afterIdx];
        const check = {
          after_onset: exp.after_onset,
          expected: exp,
          actual: {
            drift: update.drift,
            state: update.state,
            confidence: update.confidence
          },
          passed: true
        };

        // Check drift bounds
        if (exp.drift_min !== undefined && update.drift < exp.drift_min) {
          check.passed = false;
          check.error = `drift ${update.drift} < expected min ${exp.drift_min}`;
        }
        if (exp.drift_max !== undefined && update.drift > exp.drift_max) {
          check.passed = false;
          check.error = `drift ${update.drift} > expected max ${exp.drift_max}`;
        }
        if (exp.state !== undefined && update.state !== exp.state) {
          check.passed = false;
          check.error = `state ${update.state} !== expected ${exp.state}`;
        }

        results.checks.push(check);
        if (!check.passed) results.passed = false;
      }
    }
  }

  tracker.destroy();

  return results;
}
