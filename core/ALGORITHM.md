# Beat Drift Monitor - Algorithm Specification

## Overview

The beat drift monitor detects tempo drift relative to a calibrated reference tempo. It uses a Phase-Locked Loop (PLL) approach that maintains a predicted beat grid and measures how incoming onsets deviate from that grid.

## Key Concepts

### Beat Grid
A conceptual grid of expected beat times defined by:
- **phase**: The timestamp of the last grid alignment point
- **period**: The time between beats (ms). BPM = 60000 / period

### Drift
The difference between the *current* detected tempo and the *target* reference tempo:
```
drift_bpm = current_bpm - target_bpm
```
- Positive drift = rushing (playing faster than target)
- Negative drift = dragging (playing slower than target)

### Confidence
A 0-1 value indicating how well-locked the tracker is. Increases with on-grid hits, decreases with off-grid hits.

## State Machine

```
┌──────┐   start()   ┌─────────────┐   CAL_BEATS onsets   ┌──────────┐
│ IDLE │ ──────────► │ CALIBRATING │ ───────────────────► │ TRACKING │
└──────┘             └─────────────┘                      └────┬─────┘
                            ▲                                  │
                            │                                  │ silence
                            │         resume with onset        ▼
                            └──────────────────────────────┌────────┐
                                                           │WAITING │
                                                           └────────┘
```

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `CAL_BEATS` | 8 | Number of onsets required for initial calibration |
| `ADAPT_FAST` | 0.08 | Period adaptation rate (IIR filter coefficient) |
| `GRID_TOLERANCE` | 0.35 | Fraction of period that counts as "on-grid" (±35%) |
| `SILENCE_TIMEOUT_MS` | 4000 | Gap before entering WAITING state |
| `PERIOD_HISTORY` | 12 | Number of recent periods to store |
| `MIN_PERIOD_MS` | 200 | Minimum valid period (~300 BPM) |
| `MAX_PERIOD_MS` | 1500 | Maximum valid period (~40 BPM) |

## Algorithm Steps

### 1. Calibration Phase

Collect `CAL_BEATS + 1` onset timestamps, then:

1. Compute intervals between consecutive onsets
2. Filter to valid range (200-2000ms)
3. Find dominant period using clustering:
   - Take lower 60% of sorted intervals as candidates
   - Use median as candidate base period
   - Verify larger intervals are multiples (1x, 2x, 3x) with ≤15% error
   - If ≥50% of intervals fit model, use candidate median
   - Otherwise, fall back to simple median
4. Initialize:
   - `period = dominant_period`
   - `targetPeriod = dominant_period`
   - `phase = last_onset_timestamp`
   - `confidence = 0.5`

### 2. Tracking Phase

For each onset at `timestamp`:

#### 2.1 Grid Position Calculation
```
timeSincePhase = timestamp - phase
beatFraction = timeSincePhase / period
nearestBeat = round(beatFraction)
offset = beatFraction - nearestBeat    // Range: -0.5 to +0.5
```

#### 2.2 On-Grid Hit (|offset| < GRID_TOLERANCE)

```
impliedPeriod = timeSincePhase / nearestBeat

// Validate implied period
if (impliedPeriod > MIN_PERIOD_MS && impliedPeriod < MAX_PERIOD_MS && nearestBeat > 0):

    // Fast adaptation: track current tempo
    period = period + ADAPT_FAST * (impliedPeriod - period)

    // NOTE: targetPeriod is NOT updated during tracking.
    // It remains fixed at calibrated value so drift can be measured.
    // Target only changes on: calibration, song gap, or explicit setTarget().

    // Phase correction: snap grid toward this onset
    phase = timestamp - (nearestBeat * period) + (offset * period * 0.3)

    // Increase confidence
    confidence = min(1, confidence + 0.05)
```

#### 2.3 Off-Grid Hit (|offset| ≥ GRID_TOLERANCE)

```
// Don't adjust grid - this is likely syncopation or noise
confidence = max(0, confidence - 0.02)
```

#### 2.4 Tempo Multiple Detection

The tracker detects when the player switches to half-time or double-time feel, without changing the actual grid tempo.

**Beat Position Tracking**
```
// Track which grid beats onsets land on
recentBeatPositions.push(nearestBeat)  // Keep last 16 positions
```

**Half-time detection** (tempoMultiple = 0.5):
Player consistently hits every other beat (e.g., beats 2, 4, 6, 8...)
```
if (recentBeatPositions.length >= 8 && gridHits > 8):
    evenCount = count of positions where nearestBeat % 2 === 0
    evenRatio = evenCount / recentBeatPositions.length

    if (evenRatio > 0.75):
        tempoMultiple = 0.5
        tempoMultipleConfidence += 0.1
```

**Double-tempo detection** (tempoMultiple = 2):
Onsets consistently land at half-beat positions, triggering grid halving
```
if (|offset| in [0.35, 0.65] && gridMisses > gridHits * 0.5 && gridMisses > 6):
    if (period / 2 > MIN_PERIOD_MS):
        period /= 2
        targetPeriod /= 2
        tempoMultiple = 2
        tempoMultipleConfidence = 0.7
```

**Confidence decay**: Double-time confidence decays with consistent on-grid hits, returning to normal feel when confidence drops below 0.3.

**Output fields**:
- `tempoMultiple`: 0.5 (half-time), 1 (normal), or 2 (double-time)
- `tempoMultipleConfidence`: 0-100, confidence in the detection
- `tempoMultipleLabel`: "half-time", "normal", or "double-time"

### 3. Output Calculation

```
currentBpm = 60000 / period
targetBpm = 60000 / targetPeriod
drift = currentBpm - targetBpm
```

## Debug Trace Format

Each onset produces a trace record:

```javascript
{
  timestamp: number,        // onset time (ms, performance.now())
  state: string,           // CALIBRATING | TRACKING | WAITING

  // Grid position
  nearestBeat: number,     // Which grid beat this onset aligned to
  offset: number,          // -0.5 to +0.5 fraction offset from grid
  onGrid: boolean,         // Whether |offset| < GRID_TOLERANCE

  // Period tracking (before → after)
  impliedPeriod: number,   // Period implied by this onset
  periodBefore: number,
  periodAfter: number,
  targetPeriodBefore: number,
  targetPeriodAfter: number,

  // Derived values
  currentBpm: number,
  targetBpm: number,
  drift: number,
  confidence: number,

  // Tempo multiple
  tempoMultiple: number,           // 0.5, 1, or 2
  tempoMultipleConfidence: number, // 0-100
  tempoMultipleLabel: string,      // "half-time", "normal", "double-time"

  // Statistics
  gridHits: number,
  gridMisses: number
}
```

## Test Scenarios

### Scenario Types

1. **perfect_tempo**: Onsets at exact intervals. Expect drift ≈ 0.
2. **steady_offset**: Calibrate at X BPM, play at Y BPM. Expect drift ≈ Y-X.
3. **gradual_speedup**: Tempo increases linearly over time.
4. **gradual_slowdown**: Tempo decreases linearly over time.
5. **chorus_lag**: Pattern change causes sudden tempo drop (simulates drummer adjusting to busier kick pattern).
6. **missed_beats**: Some onsets missing. Grid should persist.
7. **syncopation**: Off-beat onsets. Should not destabilize grid.
8. **recovery**: Return to original tempo after drift.

### Test Vector Format

```javascript
{
  name: "scenario_name",
  description: "Human-readable description",
  calibration_bpm: 120,           // Initial calibration tempo

  // Onset sequence (times in ms from start)
  onsets: [0, 500, 1000, ...],

  // Or generate from pattern
  generator: {
    type: "linear_drift",
    start_bpm: 120,
    end_bpm: 130,
    duration_beats: 64
  },

  // Expected behavior at checkpoints
  expectations: [
    { after_onset: 16, drift_min: 0, drift_max: 2, state: "TRACKING" },
    { after_onset: 32, drift_min: 3, drift_max: 5 }
  ]
}
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.3.0 | 2026-02 | Add tempo multiple detection (half-time/double-time) with visual metronome |
| 2.2.0 | 2025-02 | Remove ADAPT_SLOW - target now fixed during tracking for proper drift detection |
| 2.1.0 | 2025-02 | Extract to standalone module with debug tracing |
| 2.0.0 | 2025-02 | PLL-based grid tracking, replaces interval averaging |
| 1.0.0 | 2025-02 | Simple interval averaging between consecutive onsets |
