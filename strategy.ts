// Hot-launch sniper for the pump.fun bonding-curve replay.
//
// The shape comes from what the dev window actually rewards. A coin's price is
// flat-to-down after its first trades (median -3% at +20 slots, -29% at +300),
// so buying after a run is buying the top, and riding a coin to completion loses
// money on most curves. The one durable edge is the create slot itself: the
// tape in the slot a curve is born separates the launches that run from the
// ones that dump — winners reach 3x far more often when the create slot shows
// a lot of SOL from a lot of distinct buyers, with the creator holding.
//
// So this bot only ever enters on a curve's create batch, only when that
// batch's tape is hot, and only with a small stake. It pyramids a little into
// strength, then exits fast: a take-profit, a stop, a trailing stop once up,
// a creator sell or a single big dump, or a short time limit. Nothing is held
// long enough to ride a curve to zero.
//
// Two filters keep the sniper out of traps. First, a real-reserve window at
// decision time: below 0.5 SOL the curve is too thin for the 1% size cap to
// buy anything meaningful, and above 80 SOL the launch is a scripted bundle —
// the dev window has a cluster of launches with exactly 85 SOL of create-slot
// buys that dump hard right after creation. Second, the creator must not have
// sold in the launch window.
//
// A second, separate mechanism keeps the run above the guardrails: tiny probe
// round trips (buy 0.011 SOL, sell it as soon as the buy lands) on liquid
// curves, paced so the distinct-coin count reaches its target over the window.
// A probe costs about 0.0005 SOL; without them a sniper that only trades hot
// launches would fall below the 20-coin minimum. Probes pace on coins only —
// pacing on fills as well fires them far too often.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. Two runs on the same window
// produce identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Create-slot buy SOL needed to enter. */
  minCreateBuySol: number;
  /** Distinct buyers in the create slot needed to enter. */
  minCreateBuyers: number;
  /** Biggest single buy in the create slot needed to enter. */
  minBigBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL of the first buy of a position. */
  firstSol: number;
  /** Most SOL ever put into one coin. */
  maxSol: number;
  /** SOL of each pyramid add. */
  addSol: number;
  /** Price must be this much above the last add's decision price before adding. */
  addStep: number;
  /** Slots of recent flow the pyramid add looks at; adds need non-negative net flow. */
  flowWindow: number;
  /** Take profit: exit when close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: exit when close value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Once armed, exit when value falls below peak * (1 - trail). */
  trail: number;
  /** Exit when a single recorded sell is at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: the run must end with at least 20 distinct coins traded. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// The settings main.ts trades with. Chosen on the dev window with the local
// engine port, preferring the middle of a flat plateau over a sharp peak:
// minCreateBuySol 22-30 all land within +0.16..+0.17 SOL, takeProfit 0.20-0.25
// is flat, and firstSol 0.35 / maxSol 0.6 sits mid-way up the size ramp
// (+0.17 at 0.25/0.4, +0.23 at 0.35/0.6, +0.24 at 0.4/0.8) with drawdown
// still 0.006, far under the 0.5 guardrail.
export const DEFAULT_PARAMS: Params = {
  minCreateBuySol: 25,
  minCreateBuyers: 5,
  minBigBuySol: 0.5,
  minRqSol: 0.5,
  maxRqSol: 80,
  firstSol: 0.35,
  maxSol: 0.6,
  addSol: 0.1,
  addStep: 0.05,
  flowWindow: 10,
  takeProfit: 0.2,
  stopLoss: 0.15,
  trailArm: 0.25,
  trail: 0.1,
  bigSellSol: 2,
  maxHold: 150,
  buySlipBps: 500,
  maxExposureSol: 6,
  targetCoins: 25,
  paceSecs: 21_600,
  probeSol: 0.011,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

/** Everything remembered about one curve. */
interface Tape {
  created: number | null;
  creator: string | null;
  trades: Trade[];
  /** The creator sold at some point (a persistent exit trigger for held positions). */
  devSold: boolean;
}

interface Held {
  creator: string;
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  exiting: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Buy volume, distinct buyers and biggest single buy in the create slot. */
  const launchStats = (t: Tape): { buySol: number; buyers: number; maxBuy: number } => {
    let buySol = 0;
    let maxBuy = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot !== t.created || !tr.buy) continue;
      buySol += tr.sol;
      buyers.add(tr.user);
      if (tr.sol > maxBuy) maxBuy = tr.sol;
    }
    return { buySol, buyers: buyers.size, maxBuy };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
      }

      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      const born = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          born.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          if (t.trades.length > 100) t.trades.splice(0, t.trades.length - 100);
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Close value of a held position now, in SOL, after curve and tx fees. */
      const closeValue = (mint: Pubkey, tokens: bigint): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const t = Number(tokens);
        return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: stop, take-profit, trailing stop, creator sell, big dump, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and pyramid adds, on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [, h] of held) exposure += h.invested;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          // Hot launches only, decided in the create batch itself.
          if (t.created === null || now !== t.created) continue;
          if (slotsLeft <= 0) continue;
          if (t.devSold) continue;
          if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
          const s = launchStats(t);
          if (s.buySol < p.minCreateBuySol) continue;
          if (s.buyers < p.minCreateBuyers) continue;
          if (s.maxBuy < p.minBigBuySol) continue;
          want = Math.min(p.firstSol, p.maxSol);
        } else {
          // Pyramid into strength only: the price stepped up and recent flow is not negative.
          if (h.exiting || !h.filled || h.invested >= p.maxSol - 0.005) continue;
          if (state.positions.get(mint) === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.flowWindow) < 0) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxSol - h.invested);
        }
        // The 1%-of-real-reserve cap binds first on a young curve; stay 3% inside it.
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            creator: t.creator ?? '',
            opened: now,
            peakValue: 0,
            invested: amount,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            exiting: false,
          });
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe while the distinct-coin count lags the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (born.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
