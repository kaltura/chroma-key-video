# Device Benchmark Results

Community-submitted results from the [self-service bench page](https://kaltura.github.io/chroma-key-video/test/bench.html). Each row is one benchmark run (a submission may include a synthetic run and a real-footage run). Key/dissolve/CPU are per-frame render cost at 1280x720; fps x12 is the per-player range with 12 concurrent players.

Run it on your device and share your numbers — the **Share results** button on the bench page files them here automatically.

| Date | Platform | Browser | GPU | Source | Backend | Key ms | +Dissolve ms | CPU ms | fps x1 | fps x12 | Jank /120 | Issue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08-21 | macOS | Chrome 151 | ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version) | footage | webgl | 1.044 | 1.586 | 5.89 | 24 | 24-24.5 | 0 | [#1](https://github.com/kaltura/chroma-key-video/issues/1) |
