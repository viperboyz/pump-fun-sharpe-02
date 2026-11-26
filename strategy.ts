// Sharpe Sprint scalper, fourth writing pass.
//
// The shape is settled now: quiet-at-birth screen, one small stake, fast
// exits, tiny probes for late coins, and every holding priced from the
// reserves at the moment we decide to buy. What this pass adds is a split
// personality for exits: a full-size holding and a probe are not the same
// bet, so they no longer share one set of exit rules. A probe is a census
// ticket, not a conviction trade — it gets out quickly, on a modest win or
// a small loss, instead of sitting around for nine hundred slots bleeding
// fees and drift. The full-size holding keeps the patient rules: a wide
// target, a real stop, and time to run.
//
// Still no clock, no randomness, no I/O: the same replay gives the same
// orders every time.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lamports for a full entry: 0.05 SOL. */
  stakeLamports: number;
  /** Lamports for a late probe entry: 0.011 SOL. */
  probeLamports: number;
  /** Fewest distinct buyers a newborn coin must have gathered. */
  minBuyers: number;
  /** Most distinct buyers it may have: past this the crowd is already in. */
  maxBuyers: number;
  /** Fewest trades a coin must have printed. */
  minTrades: number;
  /** Least net SOL inflow, buys minus sells, in lamports. */
  minNetSol: number;
  /** Least total traded volume, buys plus sells, in lamports. */
  minFlowLamports: number;
  /** Least real SOL sitting in the curve, in lamports. */
  minRealSol: number;
  /** Most SOL the creator may have bought for themselves, in lamports. */
  maxDevBuy: number;
  /** Ceiling on the price now versus the birth price, in bps (14000 = 1.40x). */
  maxRunupBps: number;
  /** A full entry must land within this many slots of the coin first appearing. */
  maxAge: number;
  /** Stop-loss below the entry price, in bps (300 = -3%). */
  slBps: number;
  /** Take-profit above the entry price, in bps (20000 = +200%). */
  tpBps: number;
  /** Longest a holding may stay open, in slots. */
  maxHold: number;
  /** Slots with no trade after which a holding is given up for dead. */
  staleSlots: number;
  /** Trailing stop switches on once the price sits this far above entry, bps (0 = off). */
  trailArmBps: number;
  /** Trailing stop sells after giving back this much from the peak, bps. */
  trailBps: number;
  /** Worst fill accepted against the reserves at decision time, bps. */
  slipBps: number;
  /** Stop-loss for a probe holding, in bps below its entry price. */
  probeSlBps: number;
  /** Take-profit for a probe holding, in bps above its entry price. */
  probeTpBps: number;
  /** Longest a probe holding may stay open, in slots. */
  probeHold: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 50_000_000,
  probeLamports: 11_000_000,
  minBuyers: 5,
  maxBuyers: 6,
  minTrades: 5,
  minNetSol: 200_000_000,
  minFlowLamports: 100_000_000,
  minRealSol: 2_000_000_000,
  maxDevBuy: 500_000_000,
  maxRunupBps: 14000,
  maxAge: 1,
  slBps: 300,
  tpBps: 20000,
  maxHold: 900,
  staleSlots: 300,
  trailArmBps: 0,
  trailBps: 0,
  slipBps: 500,
  probeSlBps: 200,
  probeTpBps: 10000,
  probeHold: 300,
};

/** One coin's life story, kept up to date from the batches as they arrive. */
interface CoinFile {
  mint: string;
  creator: string;
  firstSlot: number;
  /** Birth price, kept as virtual quote over virtual token reserves. */
  birthQuote: bigint;
  birthToken: bigint;
  buyers: Set<string>;
  trades: number;
  netLamports: bigint;
  grossLamports: bigint;
  devBought: bigint;
  devSold: boolean;
  lastTradeSlot: number;
}

/** What we remember about a holding: the price we decided on, its peak, its kind. */
interface Holding {
  atQuote: bigint;
  atToken: bigint;
  sinceSlot: number;
  /** Highest price ratio reached since entry, in bps over the entry price. */
  bestBps: bigint;
  /** True when this holding is a small late probe rather than a full entry. */
  probe: boolean;
}

/** How much the price has moved from a base, in basis points (10000 = flat). */
function priceRatioBps(quote: bigint, token: bigint, baseQuote: bigint, baseToken: bigint): bigint {
  if (baseQuote === 0n || baseToken === 0n || token === 0n) return 10000n;
  return (quote * baseToken * 10000n) / (token * baseQuote);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const files = new Map<string, CoinFile>();
  const holdings = new Map<string, Holding>();
  /** Notes taken when a buy goes out, waiting for the position to land. */
  const awaiting = new Map<string, Holding>();
  const entered = new Set<string>();

  function fileFor(mint: string, creator: string, slot: number, vq: bigint, vt: bigint): CoinFile {
    let f = files.get(mint);
    if (f === undefined) {
      f = {
        mint,
        creator,
        firstSlot: slot,
        birthQuote: vq,
        birthToken: vt,
        buyers: new Set<string>(),
        trades: 0,
        netLamports: 0n,
        grossLamports: 0n,
        devBought: 0n,
        devSold: false,
        lastTradeSlot: slot,
      };
      files.set(mint, f);
    }
    return f;
  }

  /** Learn from this batch's events: births, trades, and who did what. */
  function ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        fileFor(e.mint, e.creator, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      } else if (e.event === 'TradeEvent') {
        const f = fileFor(e.mint, e.creator, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const sol = BigInt(e.sol_amount);
        f.trades += 1;
        f.lastTradeSlot = e.slot;
        if (e.is_buy) {
          f.buyers.add(e.user);
          f.netLamports += sol;
          if (e.user === f.creator) f.devBought += sol;
        } else {
          f.netLamports -= sol;
          if (e.user === f.creator) f.devSold = true;
        }
        f.grossLamports += sol;
      }
    }
  }

  /** Is an order of this side for this mint still travelling to the market? */
  function inFlight(state: BotState, side: 'buy' | 'sell', mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === side && p.order.mint === mint) return true;
    }
    return false;
  }

  /**
   * Settle the book against reality. A holding that just landed adopts the
   * note taken when its buy was decided; a holding with no note is measured
   * fresh. Notes for buys that never landed (rejected, failed) are thrown
   * away once nothing is in flight for them anymore. Holdings that are gone
   * are forgotten.
   */
  function settle(state: BotState): void {
    for (const mint of [...holdings.keys()]) {
      if (!state.positions.has(mint)) holdings.delete(mint);
    }
    for (const mint of [...awaiting.keys()]) {
      if (!state.positions.has(mint) && !inFlight(state, 'buy', mint)) awaiting.delete(mint);
    }
    for (const mint of state.positions.keys()) {
      if (holdings.has(mint)) continue;
      const note = awaiting.get(mint);
      if (note !== undefined) {
        holdings.set(mint, note);
        awaiting.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      holdings.set(mint, {
        atQuote: curve.virtual_quote_reserves,
        atToken: curve.virtual_token_reserves,
        sinceSlot: state.slot,
        bestBps: 10000n,
        probe: false,
      });
    }
  }

  /** The quiet-at-birth screen: every clause must hold at this moment. */
  function screen(state: BotState, f: CoinFile): boolean {
    if (f.buyers.size < params.minBuyers || f.buyers.size > params.maxBuyers) return false;
    if (f.trades < params.minTrades) return false;
    if (f.netLamports < BigInt(params.minNetSol)) return false;
    if (f.grossLamports < BigInt(params.minFlowLamports)) return false;
    if (f.devSold) return false;
    if (f.devBought > BigInt(params.maxDevBuy)) return false;
    const curve = state.curves.get(f.mint);
    if (curve === undefined || curve.complete) return false;
    if (curve.real_quote_reserves < BigInt(params.minRealSol)) return false;
    const runup = priceRatioBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, f.birthQuote, f.birthToken);
    if (runup > BigInt(params.maxRunupBps)) return false;
    return true;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    ingest(batch);
    settle(state);
    const orders: OrderInput[] = [];
    const slot = state.slot;
    const txFee = state.txFeeLamports();
    // Free slots for new entries: the cap counts holdings plus buys still
    // in flight, and we count our own fresh buys as we place them.
    let room = state.hello.caps.max_open_positions - state.committedPositionCount();

    // ---- Leave first. Every holding is judged against its own exit rules. ----
    for (const [mint, holding] of state.positions) {
      const book = holdings.get(mint);
      const curve = state.curves.get(mint);
      if (book === undefined || curve === undefined || curve.complete) continue;
      if (inFlight(state, 'sell', mint)) continue;
      const ratio = priceRatioBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, book.atQuote, book.atToken);
      if (ratio > book.bestBps) book.bestBps = ratio;
      // A probe answers to the quick rules; a full holding to the patient ones.
      const stop = book.probe ? params.probeSlBps : params.slBps;
      const target = book.probe ? params.probeTpBps : params.tpBps;
      const lifetime = book.probe ? params.probeHold : params.maxHold;
      const file = files.get(mint);
      const dumped = file !== undefined && file.devSold;
      const silent = file !== undefined && slot - file.lastTradeSlot >= params.staleSlots;
      const aged = slot - book.sinceSlot >= lifetime;
      const trailed =
        params.trailArmBps > 0 &&
        book.bestBps >= 10000n + BigInt(params.trailArmBps) &&
        ratio <= book.bestBps - BigInt(params.trailBps);
      if (
        ratio <= 10000n - BigInt(stop) ||
        ratio >= 10000n + BigInt(target) ||
        dumped ||
        silent ||
        aged ||
        trailed
      ) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: params.slipBps });
      }
    }

    // ---- Then look for entries, oldest coins first. ----
    for (const f of files.values()) {
      if (room <= 0) break;
      if (entered.has(f.mint)) continue;
      if (state.positions.has(f.mint)) continue;
      if (!screen(state, f)) continue;
      const young = slot - f.firstSlot <= params.maxAge;
      // Late to the screen is not the same as useless: a small probe still
      // counts toward the distinct-mint guardrail.
      const want = young ? BigInt(params.stakeLamports) : BigInt(params.probeLamports);
      const cap = state.maxBuyLamports(f.mint);
      const size = want < cap ? want : cap;
      if (size <= 0n) continue;
      if (state.freeCashLamports() < size + txFee) continue;
      orders.push({ side: 'buy', mint: f.mint, quote_lamports: size, max_slippage_bps: params.slipBps });
      const curve = state.curves.get(f.mint)!;
      awaiting.set(f.mint, {
        atQuote: curve.virtual_quote_reserves,
        atToken: curve.virtual_token_reserves,
        sinceSlot: slot,
        bestBps: 10000n,
        probe: !young,
      });
      entered.add(f.mint);
      room -= 1;
    }

    return orders;
  }

  return { onBatch };
}
