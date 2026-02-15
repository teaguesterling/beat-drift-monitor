# Beat Drift Monitor

Real-time tempo drift detection for drummers. Uses your device's microphone to track kick drum hits and show whether you're rushing or dragging relative to your calibrated tempo.

**[Try it live](https://teaguesterling.github.io/beat-drift-monitor/)**

## Features

- **PLL-based beat tracking** — Maintains a beat grid and measures drift, tolerant of missed beats and syncopation
- **Visual metronome** — Ring display shows current position in the beat cycle
- **Tempo feel detection** — Detects half-time and double-time playing
- **LED strip drift indicator** — Quick visual feedback for rushing (red) or dragging (blue)
- **Auto song gap detection** — Resets calibration between songs
- **Mobile optimized** — Works on phone propped on drum throne

## How It Works

1. **Calibration**: Play 8 steady beats to establish your target tempo
2. **Tracking**: The algorithm maintains a beat grid and tracks how your playing deviates
3. **Feedback**: Visual indicators show drift in real-time

The tracker uses a Phase-Locked Loop (PLL) approach:
- Onsets near expected grid positions adjust the tempo estimate
- Off-grid hits (syncopation, ghost notes) are discounted
- Tempo adapts quickly to follow you, while the target stays fixed for drift measurement

## Versions

| Version | Description |
|---------|-------------|
| **v3** | Ring metronome + tempo feel detection (half-time/double-time) |
| **v2** | LED strip display + PLL tracking |
| **v1** | Original interval-based detection |

## Development

### Test Harness

The test harness (`test/test_harness.html`) provides:
- Synthetic test scenarios (perfect tempo, drift, missed beats, jitter)
- Visual trace of algorithm behavior
- Live audio testing with debug output
- Adjustable algorithm constants

### Running Tests

```bash
# Run all tests
node test/run_tests.js

# Run validation suite
node test/run_tests.js --suite=validation

# Run specific scenario
node test/run_tests.js --scenario=steady_rush_2bpm --verbose
```

### Algorithm

See [core/ALGORITHM.md](core/ALGORITHM.md) for detailed specification including:
- State machine (IDLE → CALIBRATING → TRACKING → WAITING)
- Grid position calculation
- Tempo multiple detection (half-time/double-time)
- Debug trace format

### Project Structure

```
beat-drift-monitor/
├── core/
│   ├── beat_tracker.js    # Core algorithm (ES module)
│   └── ALGORITHM.md       # Algorithm specification
├── web-standalone/
│   ├── drift-monitor-v3.html  # Latest: ring metronome
│   ├── drift-monitor-v2.html  # LED strip version
│   └── drift-monitor-v1.html  # Original version
├── test/
│   ├── test_harness.html  # Interactive testing UI
│   ├── run_tests.js       # CLI test runner
│   └── scenarios/         # Test scenario definitions
└── .github/workflows/
    └── pages.yml          # GitHub Pages deployment
```

## Browser Support

Requires:
- Web Audio API
- `getUserMedia` for microphone access
- Modern browser (Chrome, Firefox, Safari, Edge)

## License

MIT
