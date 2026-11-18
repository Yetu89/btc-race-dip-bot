# Washout Dip Bot — make.fun BTC race

Single-file trading bot for the make.fun competition
"Race a BTC trading bot live for 24 hours" (`btc-race-24h-20261118-1444`).

Trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute bars, long
only, starting from $1,000 of paper money.

## Strategy

- **Dip entry:** the close has fallen at least 1.5% over the last 120 bars
  (or 2% over the last 240) and this bar closed up from the previous close
  — the washout is turning. Buy with all cash.
- **Trend entry:** the 60-bar return is above +1.2% and the close is above
  its 120-bar EMA (activity insurance for a strong up-day when no dip ever
  comes). Buy with all cash.
- **Dip exit:** +2% take-profit, -1% stop-loss, -1.5% trailing stop from the
  highest close since entry.
- **Trend exit:** +1.5% take-profit, -1% stop-loss, -1% trailing stop.
- Never trades in the first 15 bars; flattens 15 bars before the window
  ends. A full-size round trip costs ~26 bps (4 bps fee + 2 bps slippage +
  ~7 bps impact per side), so every exit target is far above that.

The bot is a pure function of the bars: no clock, no randomness, no
network, so its two graded runs always agree.

## Local grade (dev window, 17–18 Nov 2026)

```
makefun grade-local --kit <kit-dir> --bot . --driver process
```

Result: **net PnL +$15.68 on $1,000, 2 trades, max drawdown 0.76%** —
passes the dev gate (net PnL above $0). Every shipped baseline loses
money on the same window (buy-and-hold -$31.63, momentum -$23.87,
ema-cross -$148.17, rsi-bollinger -$39.92, adx-momentum -$75.57,
hold-cash $0.00).

## Layout

- `main.ts` — the bot (Node 22, TypeScript, erasable syntax only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.

## License

MIT — see `LICENSE`.
