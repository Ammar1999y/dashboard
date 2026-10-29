---
name: diagnose
description: Diagnosis loop for a hard bug or performance regression. Run only when asked.
disable-model-invocation: true
argument-hint: '[the symptom]'
---

Adapted from mattpocock/skills `diagnosing-bugs` (MIT).

## 1. A loop that goes red

Before any theory, have **one command you have already run** that drives the real code path and fails on **the reported symptom**, not on a nearby one. It must be deterministic and take seconds. In order of preference: a failing `bun test` case at the seam that reaches the bug, a request against the running API, a CLI call diffed against a known-good output, a replayed captured payload, a throwaway harness. No browser driving.

A flaky bug needs a higher reproduction rate, not a clean repro: loop the trigger, add stress, narrow the timing window. If no loop can be built, stop, list what was tried, and ask for the environment or a captured artifact.

If you catch yourself reading code to build a theory before this command exists, stop.

## 2. Minimise

Cut inputs, callers, config and steps one at a time, re-running after each cut, until every remaining element is load-bearing.

## 3. Hypothesise

3–5 ranked hypotheses, each falsifiable: "if X is the cause, changing Y makes it disappear". Show the list before testing, then continue without waiting; the owner may re-rank it.

## 4. Instrument

One variable per probe, each tied to a prediction. Tag every debug log with one prefix (`[DEBUG-a4f2]`) so cleanup is a single grep. For performance: baseline measurement first, then bisect.

## 5. Fix

Write the regression test first, at a seam that reproduces the real pattern. If you forced the red by mutating code or a fixture, diff against a pristine copy to prove the mutation landed. If no correct seam exists, that is a finding: report it rather than writing a test that gives false confidence.

Done when: the original loop is green, the regression test passes, no `[DEBUG-` prefix remains, throwaway harnesses are deleted, and the reply names the hypothesis that held.
