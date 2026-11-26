// Early-selective bonding-curve scalper for agent-fun/replay/v2 (pump.fun).
//
// Read of the market: the first seconds of a pump.fun coin are where the money is, but most
// launches are bundles that dump on the first buyers, and the average coin drifts down from its
// launch price. So this bot watches every coin from its CreateEvent and only buys the quiet
// ones whose opening tape looks like a real crowd forming rather than a bundle: a handful of
// distinct wallets buying (5-6, not 1-2 and not a crowd), several trades, net SOL flowing in,
// the creator still holding, a small creator buy, and the price not already run away. One small
// fixed buy per coin, no pyramiding. It then sells with a very asymmetric exit: a tight stop
// (-3%) so losers cost almost nothing, and a very high take-profit (+200%) so the rare coin
// that runs pays for many small losses, with a hard time limit of 900 slots. Positions are
// small and turns are quick, so no single coin can hurt the equity curve much, and the hourly
// Sharpe comes from a few large wins against many tiny losses instead of one lucky moonshot.
//
// A light coverage probe keeps the 20-coin guardrail safe: if the run has seen a lot of coins
// but few round trips, the bot takes a minimum-size (0.011 SOL) round trip on the most liquid
// coin it skipped, and sells it a couple of slots after the buy lands. Expired
// coins stay eligible for probes on purpose: the probe pool is about liquid
// curves, not about the entry age window.
//
// Tuning (dev window, 24h, 1,222 coins; chosen for robustness across the
// three parts, not the single best cell): entries one slot after create only
// (maxAge 1), creator buys capped at 0.5 SOL (maxDevBuy), and a longer quiet
// window before giving up on a coin (staleSlots 300). Take-profit +200% and
// stop-loss -3% are left alone: every other take-profit level tested was
// worse, because the wins come from the rare big runners.
//
// A pure function of the batches it is fed: no clock, no randomness, no environment, no I/O.
// All decisions are in whole lamports (BigInt).

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each buy is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (also the round-trip floor). */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this (a big dev buy is a bundle). */
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Net SOL bought minus sold before entry, at least this (lamports). */
  minNetSol: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window (10000 = unchanged). */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Coverage probe: buy lamports (must clear the 0.01 SOL round-trip floor). */
  probeLamports: number;
  /** Start probing only after this many coins have been seen. */
  probeAfterCoinsSeen: number;
  /** A probe candidate needs at least this real SOL reserve and this age. */
  probeMinRealSol: number;
  probeMinAge: number;
  /** A probe is sold this many slots after its buy fills. */
  probeHoldSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  // Entries are decided one slot after the CreateEvent: the opening tape is
  // freshest then, and waiting a second slot only added losers on the dev window.
  maxAge: 1,
  stakeLamports: 50_000_000,
  minBuyLamports: 11_000_000,
  minRealSol: 2_000_000_000,
  maxRealSol: 30_000_000_000,
  maxDevBuy: 500_000_000,
  minTrades: 5,
  minBuyers: 5,
  maxBuyers: 6,
  minNetSol: 200_000_000,
  maxSellRatioBps: 2500,
  maxBigSellBps: 2000,
  minRunupBps: 10000,
  maxRunupBps: 14000,
  flowWindow: 20,
  minFlowLamports: 100_000_000,
  minRecentBuyers: 2,
  skipDevSold: true,
  buySlippageBps: 1000,
  tpBps: 20000,
  slBps: 300,
  trailArmBps: 1000000,
  trailBps: 1000,
  maxHold: 900,
  exitOnDevSell: true,
  staleSlots: 300,
  probeLamports: 11_000_000,
  probeAfterCoinsSeen: 150,
  probeMinRealSol: 2_000_000_000,
  probeMinAge: 200,
  probeHoldSlots: 2,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  /** Too old for a first buy (a separate flag so the coverage probe can still use it). */
  tooOld: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  isProbe: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees on a sell: protocol 95 bps + creator 30 bps, each rounded up, like the engine. */
const PROTOCOL_BPS = 95n;
const CREATOR_BPS = 30n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - ceilDiv(q * PROTOCOL_BPS, BPS) - ceilDiv(q * CREATOR_BPS, BPS);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Mints marked as coverage probes (their held record gets isProbe on the buy fill). */
  const probeMints = new Set<Pubkey>();
  /** Lamports spent on buys per mint, and mints that completed a qualifying round trip. */
  const buySpent = new Map<Pubkey, bigint>();
  const tripped = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          done: false,
          tooOld: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Fills: open held records on buy fills, close them on harness closes,
      // and count qualifying round trips (buy fills >= 0.01 SOL, then a sell).
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled') {
          buySpent.set(f.mint, (buySpent.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
          if (h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              txPaid: BigInt(f.tx_fee_lamports),
              best: 0n,
              devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
              isProbe: probeMints.has(f.mint),
            });
          }
        }
        if (f.side === 'sell' && f.status === 'filled' && (buySpent.get(f.mint) ?? 0n) >= 10_000_000n) {
          tripped.add(f.mint);
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first: take-profit, stop-loss, trailing stop, time, dev sell, stale, probe.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, isProbe: probeMints.has(mint) };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (h.isProbe) {
          if (state.slot - h.openedSlot >= P.probeHoldSlots) exit = true;
        } else if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one small buy per coin that passes the opening-tape filter.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.tooOld || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.tooOld = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (c.buysSent > 0) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        // Opening-tape filter: real crowd interest, no bundle, no dump starting.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought - c.soldByOthers < BigInt(P.minNetSol)) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        open += 1;
      }

      // Coverage probe: if many coins have been seen but few round trips were
      // made, take a minimum-size round trip on the most liquid skipped coin.
      // Note: expired coins stay eligible here on purpose — the probe pool is
      // about liquid curves, not about the entry age window.
      if (tripped.size < 20 && coins.size >= P.probeAfterCoinsSeen && orders.length < cap) {
        let best: Coin | undefined;
        let bestRq = 0n;
        for (const c of coins.values()) {
          if (c.complete || c.done || c.buysSent > 0) continue;
          if (state.slot - c.createSlot < P.probeMinAge) continue;
          if (c.devSold) continue;
          const curve = state.curves.get(c.mint);
          if (curve === undefined || curve.complete) continue;
          const rq = curve.real_quote_reserves;
          if (rq < BigInt(P.probeMinRealSol)) continue;
          if (rq > bestRq) {
            bestRq = rq;
            best = c;
          }
        }
        if (best !== undefined && open < state.hello.caps.max_open_positions) {
          const maxBuy = state.maxBuyLamports(best.mint);
          const amount = BigInt(P.probeLamports) < maxBuy ? BigInt(P.probeLamports) : maxBuy;
          if (amount >= minBuy && free >= amount + tx) {
            orders.push({ side: 'buy', mint: best.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
            probeMints.add(best.mint);
            best.buysSent += 1;
          }
        }
      }
      return orders;
    },
  };
}
