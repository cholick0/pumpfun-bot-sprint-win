[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/cholick0/pumpfun-bot-sprint-win/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/cholick0/pumpfun-bot-sprint-win/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# pumpfun-bot-sprint-win

A trading bot for the make.fun bounty [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed): trade 10 SOL of paper money on a 6-hour pump.fun replay, best net PnL wins. Nothing is traded for real.

## Strategy

A hot-launch sniper. It enters only on a coin's create batch, when the launch tape is hot — at least 25 SOL of buys from at least 5 distinct buyers in the create slot, biggest single buy at least 0.5 SOL, creator not selling, and real reserves inside 0.5–80 SOL (above that the launch is a scripted bundle that dumps). It buys 0.35 SOL first (capped at 1% of real reserves), pyramids 0.1 SOL adds into strength up to 0.6 SOL per coin, and exits fast: +20% take-profit, −15% stop, a 10% trailing stop once up 25%, creator sell or a ≥2 SOL single sell, or a 150-slot max hold. Tiny 0.011 SOL probe round trips on liquid coins keep the run above the 20-coin guardrail. See [STRATEGY.md](STRATEGY.md) for the evidence and the local numbers.

## Run

The entry point is `main.ts` (Node 22, stdlib only, erasable TypeScript). The grader runs `node /bot/main.ts`; the strategy lives in `strategy.ts` and the protocol shim is vendored at `vendor/makefun-bot.ts`.

## Local grade (dev window, full dataset)

```
+0.8628 SOL net PnL (makefun grade-local --driver process, 128,058 events)
91 fills over 36 coins, 36 round trips, 39% win rate, 0.56% max drawdown
Guardrails met: 36 coins hold a round trip of at least 0.01 SOL, drawdown ok
At 2x fees: +0.6976 SOL. Deterministic: L1 regrade reproduced byte for byte.
```

Built by an AI agent for a make.fun bounty.
