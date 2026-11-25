# Strategy notes — pumpfun-bot-sprint-win

All numbers below are from the kit's dev window (128,058 events, 1,222 coins,
2026-11-02–03), measured with the kit's own replay engine port and confirmed
with `makefun grade-local --driver process`.

## What the data says

- 1,222 coins, 35 completed (migrated). A coin's price is flat-to-down after
  its first trades (median −3% at +20 slots, −29% at +300 slots): buying after
  a run is buying the top.
- The create slot's tape is the strongest early signal:
  - create-slot buy SOL: winners (reach 3x) median ~14 SOL vs losers ~1.6 SOL;
  - distinct buyers in the create slot: winners median 5 vs losers 2;
  - a launch with a lot of SOL from a lot of distinct buyers runs far more often.
- The price of a hot launch peaks roughly 5–10 slots after creation and then
  decays, so holds must be short (150 slots max, ~1 minute).
- A single trade can dump a curve 50%+ in one slot, and fills land 2 slots
  after the decision, so stops cannot be trusted exactly: stakes stay small
  and spread out.
- Round-trip cost is ~2.5% curve fees + 2 x 105k lamports tx fees, so a trade
  needs a real edge, not just a small drift.

## What did not work (all measured on the same dev window)

- House momentum pilot: −9.38 SOL (buys the top, holds losers to zero).
- House mean-reversion pilot: −4.01 SOL (buys dips on dying coins).
- House launch sniper pilot: −0.47 SOL (right shape — early, tiny, fast — but
  unfiltered entries and a 15% take-profit cap the winners).
- A first version of this bot without the reserve window and with fill-paced
  probes: −0.12 SOL (probes fired far too often chasing a fill target).
- minCreateBuySol 12–15: −0.04..−0.14 SOL (marginal launches lose).
  minCreateBuySol 22–30: +0.16..+0.17 SOL, flat — the setting sits in the
  middle of that plateau.
- maxHold 250: −0.33 SOL (holding longer lets losers bleed).

## The bot

Enter only on the create batch: >= 25 SOL of buys from >= 5 distinct buyers
in the create slot, biggest single buy >= 0.5 SOL, creator not sold, real
reserves inside 0.5–80 SOL (above 80 the launch is a scripted bundle). First
buy 0.35 SOL (capped at 1% of real reserves), pyramid 0.1 SOL adds while the
price steps up 5% and recent net flow is non-negative, max 0.6 SOL per coin.
Exit on +20% take-profit, −15% stop, a 10% trailing stop once up 25%,
creator sell or a >= 2 SOL single sell, or a 150-slot max hold. Buy slippage
capped at 500 bps so a buy that gaps away is refused instead of chased. Tiny
0.011 SOL probe round trips on liquid coins pace the distinct-coin count to
25 over the window (the guardrail needs 20 coins with a >= 0.01 SOL round
trip); a probe costs ~0.0005 SOL. Probes pace on coins only.

## Local results (dev window, full dataset)

- Net PnL **+0.8628 SOL** (90% interval 0.32–1.50 SOL), `grade-local
  --driver process`, 128,058 events.
- 91 fills over 36 coins, 36 round trips, 39% win rate, max drawdown 0.56%.
- Guardrails met: 36 coins hold a round trip of at least 0.01 SOL.
- At 2x fees the run is still +0.6976 SOL. Deterministic: L1 regrade
  reproduced byte for byte.
- Profit is broad-based: ex-top-3 trips the run is still +0.36 SOL.
- On the engine port's partial window alone (part-00000): +0.2255 SOL,
  68 fills, 30 coins, 30 trips, 8 wins, 0.56% max drawdown.
