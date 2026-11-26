# Pump.fun Sharpe Sprint — early-selective scalper

Paper-trading bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
Ranked by hourly Sharpe ratio on a 6-hour forward window; a prize needs net PnL above 0.

## Idea

The first seconds of a pump.fun coin are where the money is, but most launches are bundles
that dump on the first buyers, and the average coin drifts down from its launch price. This
bot watches every coin from its `CreateEvent` and only buys the quiet ones whose opening
tape looks like a real crowd forming rather than a bundle: 5–6 distinct wallets buying,
several trades, net SOL flowing in, the creator still holding, a small creator buy, and the
price not already run away. One small fixed buy per coin (0.05 SOL), no pyramiding.

Exits are deliberately asymmetric: a tight stop (-3%) so losers cost almost nothing, and a
very high take-profit (+200%) so the rare coin that runs pays for many small losses, with a
hard 900-slot time limit, an exit when the creator sells, and an exit when the coin goes
quiet. A minimum-size (0.011 SOL) coverage probe keeps the 20-coin guardrail safe.

## Files

- `main.ts` — thin entry point into the harness.
- `strategy.ts` — all trading logic (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit SDK, vendored byte for byte.
- `LICENSE` — MIT, as in the kit starter.

## Properties

Deterministic: no clock, no randomness, no I/O. All decisions are in whole lamports
(BigInt). Paper trading only — the replay uses market data, never real funds.

## Dev-window results

See the build report; the final 6-hour window is a fresh regime, so dev-window numbers
are a sanity check, not a promise.
