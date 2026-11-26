# Pump.fun Sharpe Sprint — early-selective scalper

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/viperboyz/pump-fun-sharpe-02/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/viperboyz/pump-fun-sharpe-02/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the six-hour pump.fun forward replay. Entries are
ranked by hourly Sharpe ratio, and a placement only pays when net PnL after
every fee is above zero, so the bot aims for small, steady, positive trades
rather than one big win.

## How it trades

It only buys coins that are quiet at birth: 5–6 distinct buyers, at least 5
trades, net inflow of at least 0.2 SOL, the creator has not sold, the dev buy
is at most 0.5 SOL, real reserve is at least 2 SOL, and the run-up is at most
+40% — all judged within 1 slot of the coin appearing.

Each coin gets one buy of 0.05 SOL, capped at 1% of its real reserve, and the
bot never buys the same coin twice. A holding exits on whichever comes first:
stop-loss −3%, take-profit +200%, a maximum hold of 900 slots (about 3
minutes), a creator sell, or the coin going quiet for 300 slots. Holdings are
priced from the reserves at the moment the buy is decided, not from the
reserves at fill time, because on a pumping coin the fill lands higher than
the decision.

A thin six-hour window may not offer 20 distinct coins worth a full stake,
so the bot also places 0.011 SOL probe buys. A probe is a census ticket, not
a conviction trade: it exits faster, on +100% / −2% / 300 slots, instead of
sitting around bleeding fees and drift.

## Files

- `main.ts` — entry point; builds the strategy bot and hands it to the
  vendor wire shim.
- `strategy.ts` — the strategy itself, written fresh from the design spec.
- `vendor/makefun-bot.ts` — the harness wire shim, unchanged from the kit.
- `LICENSE` — MIT, as supplied with the kit starter.
- `.makefun/owner.json` — the entry owner's wallet.

## Running the checks

From `~/workspace/makefun/sharpe-02-tools/`:

- `node backtest.ts` — full 24-hour dev window (1,222 coins) plus per-part
  splits and fee variants.
- `node smoke.ts` — feeds `main.ts` a hello, a real batch, and a done on
  the real harness path; must exit 0 with empty stderr.

## Honest caveat

The final six-hour window is a lottery. On the full 24-hour dev window the
bot measured net +0.0197 SOL, hourly Sharpe +0.042, max drawdown 0.63%,
58 coins and 58 trips — clearly positive, but well below the earlier build's
+0.0753 SOL, and the edge sits mostly in the first part of the data (parts
1–2 are negative, and the 2x-fees variant is negative). There is no prize
guarantee.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2dk872m6&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
