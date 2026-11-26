// Pump.fun Sharpe Sprint entry point.
//
// The harness talks agent-fun/replay/v2 over stdin/stdout: one JSON line
// per message (hello, batch, done), one reply line per batch. The vendor
// shim owns that wire protocol — reading lines, keeping state current,
// validating orders — so this file only builds the strategy bot and hands
// it over. No clock, no randomness, no environment reads, so the two
// grading runs produce identical action logs.

import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';
import { runBot } from './vendor/makefun-bot.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

// Resolves once the harness sends done and the final account is in.
await runBot(strategy);
