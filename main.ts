// Entry point for the Pump.fun Sharpe Sprint bot: wires this bot's strategy
// into the make.fun replay harness. All trading logic lives in strategy.ts.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
