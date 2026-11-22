[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Freshaaaa/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Freshaaaa/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Build a static site faster

A faster drop-in for makefun-site 1.0.0. `solve.js` answers every case byte-identically to the reference (same front matter, template dialect, Markdown subset, slug rule and report), and `main.ts` is the reference driver unchanged.

## How it is faster

- **Templates are compiled to JS functions** (`new Function`, with an interpreter fallback if compilation ever fails). Scopes are prototype-chain objects (null-prototype base), so a lookup is a property read instead of a scope-chain walk with `hasOwn` per segment. `{{ }}` goes through a single combined text+escape helper.
- **Bulk inline Markdown**: the inline renderer finds the next special character with one regex and copies literal runs whole, instead of escaping character by character.
- **Fast slugify**: an ASCII fast path plus a per-case cache (NFKD + combining-mark stripping only runs for non-ASCII titles). Slugs are computed once per tag, not two or three times.
- **Hand-rolled front-matter parser and line classifier**: `indexOf` scanning and `charCode` checks instead of regexes on the hot paths, with the exact same error strings as the reference.
- **No duplicate work**: a post's card (word count + tag list) is built once and reused for its own page.
- **No state leaks between cases**: every cache is created fresh inside `run()`.

## Verification

On the kit's practice set (3 cases, 250–480 Markdown sources each) the output is byte-identical to the baseline and to `practice/reference/expected.json` on all 3 cases. Median CPU time over 8 interleaved runs of `node main.ts` on the practice set: **~769 ms vs ~1,232 ms for the house baseline — about 1.6x faster**.

<sub>Entered on [make.fun](https://make.fun/?ref=pstpm556&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
