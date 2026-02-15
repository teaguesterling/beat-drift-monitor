#!/usr/bin/env node

/**
 * Beat Drift Monitor - Test Runner
 *
 * Runs all scenarios from JSON files against the beat tracker algorithm.
 * Outputs results in a format compatible with standard test runners.
 *
 * Usage:
 *   node run_tests.js                    # Run all tests (all.json)
 *   node run_tests.js --suite=validation # Run validation suite
 *   node run_tests.js --scenario=name    # Run specific scenario
 *   node run_tests.js --verbose          # Show trace details
 *   node run_tests.js --json             # Output JSON results
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import the core module
import {
  createBeatTracker,
  createTraceBuffer,
  CONSTANTS,
  State
} from '../core/beat_tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// ONSET GENERATORS
// ============================================================================

function generatePerfectTempo(bpm, beats, startTime = 0) {
  const period = 60000 / bpm;
  const onsets = [];
  for (let i = 0; i < beats; i++) {
    onsets.push(startTime + i * period);
  }
  return onsets;
}

function generateLinearDrift(startBpm, endBpm, beats, startTime = 0) {
  const onsets = [startTime];
  let t = startTime;

  for (let i = 1; i < beats; i++) {
    const progress = i / (beats - 1);
    const currentBpm = startBpm + (endBpm - startBpm) * progress;
    const period = 60000 / currentBpm;
    t += period;
    onsets.push(t);
  }

  return onsets;
}

function generateExponentialDrift(startBpm, endBpm, beats, startTime = 0) {
  const onsets = [startTime];
  let t = startTime;

  for (let i = 1; i < beats; i++) {
    // Exponential interpolation
    const progress = i / (beats - 1);
    const expProgress = Math.pow(progress, 2); // Quadratic gives increasing rate
    const currentBpm = startBpm + (endBpm - startBpm) * expProgress;
    const period = 60000 / currentBpm;
    t += period;
    onsets.push(t);
  }

  return onsets;
}

function generateWithJitter(bpm, beats, jitterMs, startTime = 0) {
  const base = generatePerfectTempo(bpm, beats, startTime);
  // Use seeded random for reproducibility
  let seed = 12345;
  const seededRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5;
  };
  return base.map(t => t + seededRandom() * 2 * jitterMs);
}

function generateWithMissedBeats(bpm, beats, missIndices, startTime = 0) {
  const all = generatePerfectTempo(bpm, beats, startTime);
  const missSet = new Set(missIndices);
  return all.filter((_, i) => !missSet.has(i));
}

function generateTwoTempo(cal_bpm, cal_beats, play_bpm, play_beats, startTime = 0) {
  const section1 = generatePerfectTempo(cal_bpm, cal_beats, startTime);
  const lastTime = section1[section1.length - 1];
  const period2 = 60000 / play_bpm;
  const section2 = generatePerfectTempo(play_bpm, play_beats, lastTime + period2);
  return [...section1, ...section2];
}

function generateSectionChange(bpm1, beats1, bpm2, beats2, startTime = 0) {
  const section1 = generatePerfectTempo(bpm1, beats1, startTime);
  const lastTime = section1[section1.length - 1];
  const period2 = 60000 / bpm2;
  const section2 = generatePerfectTempo(bpm2, beats2, lastTime + period2);
  return [...section1, ...section2];
}

function generateThreeSection(bpm1, beats1, bpm2, beats2, bpm3, beats3, startTime = 0) {
  const section1 = generatePerfectTempo(bpm1, beats1, startTime);
  const lastTime1 = section1[section1.length - 1];
  const period2 = 60000 / bpm2;
  const section2 = generatePerfectTempo(bpm2, beats2, lastTime1 + period2);
  const lastTime2 = section2[section2.length - 1];
  const period3 = 60000 / bpm3;
  const section3 = generatePerfectTempo(bpm3, beats3, lastTime2 + period3);
  return [...section1, ...section2, ...section3];
}

function generateOnsets(generator) {
  switch (generator.type) {
    case 'perfect':
      return generatePerfectTempo(generator.bpm, generator.beats, 0);

    case 'linear_drift':
      return generateLinearDrift(generator.start_bpm, generator.end_bpm, generator.beats, 0);

    case 'exponential_drift':
      return generateExponentialDrift(generator.start_bpm, generator.end_bpm, generator.beats, 0);

    case 'jitter':
      return generateWithJitter(generator.bpm, generator.beats, generator.jitter_ms, 0);

    case 'missed_beats':
      return generateWithMissedBeats(generator.bpm, generator.beats, generator.miss_indices, 0);

    case 'two_tempo':
      return generateTwoTempo(
        generator.calibration_bpm,
        generator.calibration_beats,
        generator.play_bpm,
        generator.play_beats,
        0
      );

    case 'section_change':
      return generateSectionChange(
        generator.section1_bpm,
        generator.section1_beats,
        generator.section2_bpm,
        generator.section2_beats,
        0
      );

    case 'three_section':
      return generateThreeSection(
        generator.section1_bpm,
        generator.section1_beats,
        generator.section2_bpm,
        generator.section2_beats,
        generator.section3_bpm,
        generator.section3_beats,
        0
      );

    default:
      throw new Error(`Unknown generator type: ${generator.type}`);
  }
}

// ============================================================================
// TEST RUNNER
// ============================================================================

function runScenario(scenario, options = {}) {
  const trace = createTraceBuffer(10000);
  const updates = [];

  const tracker = createBeatTracker({
    onUpdate: (data) => updates.push({ ...data }),
    trace,
    constants: options.constants || {}
  });

  tracker.reset();

  // Generate onsets
  let onsets = scenario.onsets;
  if (scenario.generator) {
    onsets = generateOnsets(scenario.generator);
  }

  if (!onsets || onsets.length === 0) {
    return {
      scenario: scenario.name,
      passed: false,
      error: 'No onsets generated',
      checks: [],
      trace: [],
      updates: []
    };
  }

  // Feed onsets to tracker
  for (const timestamp of onsets) {
    tracker.addOnset(timestamp);
  }

  // Evaluate expectations
  const results = {
    scenario: scenario.name,
    description: scenario.description,
    passed: true,
    checks: [],
    trace: trace.getAll(),
    updates,
    finalState: tracker.getState(),
    onsetCount: onsets.length
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
      } else {
        results.checks.push({
          after_onset: exp.after_onset,
          passed: false,
          error: `Onset ${exp.after_onset} not found (only ${updates.length} updates)`
        });
        results.passed = false;
      }
    }
  }

  tracker.destroy();

  return results;
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);

  const verbose = args.includes('--verbose') || args.includes('-v');
  const jsonOutput = args.includes('--json');
  const scenarioFilter = args.find(a => a.startsWith('--scenario='))?.split('=')[1];
  const suiteArg = args.find(a => a.startsWith('--suite='))?.split('=')[1];

  // Load scenarios from specified suite (default: all.json)
  const suiteName = suiteArg || 'all';
  const scenariosPath = join(__dirname, 'scenarios', `${suiteName}.json`);
  let scenariosData;

  try {
    scenariosData = JSON.parse(readFileSync(scenariosPath, 'utf-8'));
  } catch (err) {
    console.error(`Error loading scenarios: ${err.message}`);
    process.exit(1);
  }

  let scenarios = scenariosData.scenarios;

  // Filter if requested
  if (scenarioFilter) {
    scenarios = scenarios.filter(s => s.name.includes(scenarioFilter));
    if (scenarios.length === 0) {
      console.error(`No scenarios matching "${scenarioFilter}"`);
      process.exit(1);
    }
  }

  // Run tests
  const results = [];
  let passed = 0;
  let failed = 0;

  if (!jsonOutput) {
    console.log(`\nRunning ${scenarios.length} test scenarios...\n`);
  }

  for (const scenario of scenarios) {
    const result = runScenario(scenario);
    results.push(result);

    if (result.passed) {
      passed++;
      if (!jsonOutput) {
        console.log(`  \u2713 ${scenario.name}`);
      }
    } else {
      failed++;
      if (!jsonOutput) {
        console.log(`  \u2717 ${scenario.name}`);
        for (const check of result.checks) {
          if (!check.passed) {
            // Output in a format blq can parse
            console.log(`    test/${scenario.name}:${check.after_onset}: error: ${check.error}`);
          }
        }
      }
    }

    if (verbose && !jsonOutput) {
      console.log(`    Onsets: ${result.onsetCount}`);
      console.log(`    Final state: ${result.finalState?.state}`);
      console.log(`    Grid hits: ${result.finalState?.gridHits}`);
      console.log(`    Final period: ${result.finalState?.period?.toFixed(2)}ms`);
      console.log(`    Target period: ${result.finalState?.targetPeriod?.toFixed(2)}ms`);

      // Show first few tracking entries and last few
      const trackingEntries = result.trace.filter(t => t.state === 'TRACKING');
      const firstTracking = trackingEntries.slice(0, 5);
      const lastTracking = trackingEntries.slice(-3);

      console.log(`    First tracking entries:`);
      for (const t of firstTracking) {
        console.log(`      onset=${t.onsetCount} implied=${t.impliedPeriod?.toFixed(1)} period=${t.periodBefore?.toFixed(1)}->${t.periodAfter?.toFixed(1)} drift=${t.drift?.toFixed(2)} event=${t.event}`);
      }
      console.log(`    Last tracking entries:`);
      for (const t of lastTracking) {
        console.log(`      onset=${t.onsetCount} implied=${t.impliedPeriod?.toFixed(1)} period=${t.periodAfter?.toFixed(1)} drift=${t.drift?.toFixed(2)} event=${t.event}`);
      }
      console.log('');
    }
  }

  // Output results
  if (jsonOutput) {
    console.log(JSON.stringify({
      version: scenariosData.version,
      total: scenarios.length,
      passed,
      failed,
      results
    }, null, 2));
  } else {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed}/${scenarios.length} passed`);
    if (failed > 0) {
      console.log(`${failed} failed`);
    }
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
