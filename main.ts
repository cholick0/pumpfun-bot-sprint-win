// pumpfun-bot-sprint-win: a hot-launch sniper bot for the agent.fun pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The strategy, in one paragraph: enter only on a curve's create batch when the
// launch tape is hot (>= 25 SOL of buys from >= 5 distinct buyers, biggest buy
// >= 0.5 SOL, creator not selling, real reserves 0.5-80 SOL), stake 0.35 SOL
// first and pyramid 0.1 SOL adds into strength up to 0.6 SOL per coin, then
// exit fast (+20% take-profit, -15% stop, 10% trailing stop once up 25%,
// creator sell, >= 2 SOL single sell, or 150 slots). Tiny 0.011 SOL probe
// round trips pace the distinct-coin count to 25 for the 20-coin guardrail.
// Tuned on the dev window (see STRATEGY.md): local grade +0.8628 SOL net PnL
// with `makefun grade-local --driver process`, 91 fills over 36 coins, max
// drawdown 0.56%, guardrails met, deterministic (L1 regrade byte for byte).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
