# Render FPS Implementation Plan

> Execute inline with regression tests before production changes.

**Goal:** Separate measured render throughput from the observer's rAF rate.
**Architecture:** A browser-injected recorder captures rAF and an optional explicit completed-frame hook. Existing kit `report().frames` counters are sampled at both measurement boundaries; unsupported render counting returns null. GPU probes and the nested perf report remain intact.
**Tech Stack:** Node ESM, node:test, Playwright.
**Spec:** User request of 2026-10-14.

## Constraints and review focus
Preserve existing JSON keys and GPU measurements; add unambiguous render fields.
Cover idle after warmup, demand bursts, 30 FPS, missing counters, counter resets, throwing reports, and first-interval contamination after reset.
No automatic inference from WebGL draws or rAF callbacks: multipass/offscreen rendering is ambiguous.

## Task 1: Window-based recorder
- [x] Add failing recorder tests for static/demand/capped loops, with kit counters and explicit hook; missing integration yields null.
- [x] Implement `installMeasurement()` in scripts/measurement.mjs and test reset/collect using a controlled browser clock.
- [x] Wire into measure.mjs and separate render/raf console columns, preserving nested perf and GPU JSON.
- [x] Document semantics and run full suite plus deterministic CLI integration (real-browser opt-in; browser download unavailable); verify patch applies to base.
