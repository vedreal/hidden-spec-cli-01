# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vedreal/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vedreal/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an AI-written edit to a tree of text files, in whichever of
the four formats the patch happens to be written: a unified diff (often
with the wrong line numbers), `SEARCH`/`REPLACE` blocks, a V4A patch, or a
JSON tool call. It is the entry for the
[hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on [make.fun](https://make.fun).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format` is `unified`, `search-replace`, `v4a`, `json` or `auto`
  (the default: the format is detected from the patch itself).
- `--check` reports what would change without writing anything.
- `--strict` matches old lines exactly (tier 0 only).
- `PATCH` is a file, or `-` / omitted to read from stdin; `--` ends
  the options.

Old lines are matched at the first of three tiers where they occur at
least once: exact, trailing whitespace ignored, surrounding whitespace
ignored (and re-indented at that tier). A patch is applied atomically:
when any edit fails, no file is written and every failure is reported.

Exit codes: `0` with one line per changed path and an `ok: <n> files`
summary; `1` with one `error: <code> <path>` line per failed edit and a
`failed: <k> of <n> edits` summary; `2` with a single `error: usage`,
`error: no-patch`, `error: format` or `error: parse <N>` line.

## Layout

- `main.ts` — the CLI and the four format readers (Node 22, stdlib only).
- `runner.ts` — the trial hand-over, byte-identical from the kit.
- `SPEC.md` — the specification this tool implements.

## License

MIT. See `LICENSE`.
