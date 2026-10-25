---
status: accepted
---

# A built-in ruleset that targets tiers by rank, not by name

The source code ships no profiles and no tier names, yet every profile should route sensibly without writing rules. The built-in ruleset therefore targets rank positions, `@top`, `@middle` and `@bottom`, resolved against each profile's tier ranks. `@middle` is the upper median by rank index, so ambiguity rounds toward the stronger tier, and with one tier every keyword resolves to it. User rulesets may mix rank keywords with tier names; names are validated per profile and keywords always resolve.

## Considered options

- **Rulesets only from config (written by `/tier init`).** Keeps a single rule dialect, but a hand-written profile without rules would be invalid.
- **Fractional (`@0.5`) or offset (`@top-1`) targets.** More expressive, but harder to read in decision logs.

## Consequences

- Built-in tier rules: work=plan or work=review, or depth of at least 1.5, go to `@top`; work=mechanical or work=research with depth below 1.0 go to `@bottom`; everything else goes to `@middle`. One floor rule: risky=true lifts the tier to at least `@middle`. Depth is judged by its value, not its confidence; these thresholds come from recorded H2O-Lightning-4B answers (DESIGN.md 8.5).
- With two tiers, `@middle` and `@top` collapse to the stronger tier, so a two-tier profile leans toward the stronger tier by design.
