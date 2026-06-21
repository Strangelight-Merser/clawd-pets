# Contributing to Clawd Pets

Thanks for your interest! Clawd Pets is a small, **read-only** macOS desktop pet that watches your Claude tasks. Issues and PRs are welcome.

## Dev setup

Requires macOS + Node.js ≥ 18.

```bash
npm install     # installs Electron (no runtime deps of our own)
npm start       # run the pet in dev (no install)
npm test        # state-inference unit tests (node --test)
npm run app     # build + install "Clawd Pets.app" into /Applications
npm run check   # print one collect() result to sanity-check the data layer
```

## How state inference is tested

Task status (`running` / `error` / `awaiting` / …) is **inferred**, not read from a flag — see [`src/collector.js`](src/collector.js) and the tests in [`test/collector.test.js`](test/collector.test.js). If you touch the inference logic, add or adjust a test: the suite is the spec, and a monitoring tool that's confidently wrong is worse than none.

## Ground rules

- **Stay read-only and local-first.** Never write to or modify anything under `~/.claude` or Claude config; never send transcript content off the machine.
- **No third-party runtime dependencies.** Build/test devDependencies are fine.
- **macOS-only** for now (it reads macOS-specific paths and uses the menu bar).
- Match the surrounding code style; keep diffs focused.

## Good first issues

Check the issues labeled **`good first issue`** / **`help wanted`** — things like cross-platform support, an interactive reply/approve action, and better stale-vs-running detection for sandbox Cowork.

## License

By contributing, you agree your contributions are licensed under this project's [MIT License](LICENSE).
