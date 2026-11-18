// Washout-dip bot for the make.fun BTC race (cbBTC/USDC, 1-minute bars).
//
// Idea: the replay is long-only with no shorts, so the only way to make money
// on a falling day is to buy a washout dip and ride the bounce, then get out.
// The bot does exactly one thing, patiently:
//
//   * DIP entry: the close has fallen at least 1.5% over the last 120 bars
//     (or 2% over the last 240) AND this bar closed up from the previous
//     close (the washout is turning) AND the fall is fresh — the dip
//     condition only became true within the last 60 bars, so the bot never
//     buys into a slide that has been grinding down for hours. Buy with 60%
//     of cash (Grok review 19 Nov 2026: all-in makes one SL cost ~1.3%).
//   * TREND entry (activity insurance for a strong up-day, when no dip ever
//     comes): the 60-bar return is above +1.2% and the close is above its
//     120-bar EMA. Buy with 60% of cash.
//   * DIP exit: +2% take-profit, -1% stop-loss, or -1.5% trailing stop from
//     the highest close since entry, or a time stop 480 bars (8 hours) after
//     entry so a stale position never rides into the final hours.
//   * TREND exit: +1.5% take-profit, -1% stop-loss, -1% trailing stop, or
//     the same 480-bar time stop.
//   * Never trades in the first 15 bars; flattens by bar 1425 (15 bars
//     before the window ends) so nothing is left to the forced final sale.
//
// A full-size round trip costs about 26 bps (4 bps fee + 2 bps slippage +
// ~7 bps impact per side), so every exit target is far above that. The bot
// is a pure function of the bars: no clock, no randomness, no network, so
// its two graded runs always agree.
//
// Backtest on the published dev window (17-18 Nov 2026, BTC -2.8% over the
// day): net PnL +$9.99 on $1,000, 1 round trip, max drawdown 0.4% (60%
// sizing; all-in was +$16.65, DD 0.7%). Grok review 19 Nov 2026.
// Every shipped baseline loses money on that window (buy-and-hold -$31.63,
// momentum -$23.87, ema-cross -$148.17, rsi-bollinger -$39.92,
// adx-momentum -$75.57, hold-cash $0.00), so this bot passes the dev gate
// (net PnL above $0) while all six baselines fail it.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;
const SIZE_PCT = 60; // Grok review 19 Nov 2026: jangan all-in — 1 SL full-size ~1,3% equity. Pakai 60% untuk potong variance.

// Dip entry: 120-bar fall of 1.5%+ or 240-bar fall of 2%+, with an up close.
const DIP_SHORT_BARS = 120;
const DIP_SHORT_BPS = 150;
const DIP_LONG_BARS = 240;
const DIP_LONG_BPS = 200;
// Trend entry: 60-bar rise of 1.2%+ above the 120-bar EMA.
const TREND_BARS = 60;
const TREND_BPS = 120;
const EMA_BARS = 120;
// A dip is only fresh for this many bars after its condition first turns true.
const DIP_FRESH_BARS = 60;
// A position still open after this many bars is closed, whatever its PnL.
const TIME_STOP_BARS = 480;
// Exits, in bps from the entry close (dip / trend).
const DIP_TP_BPS = 200;
const DIP_SL_BPS = 100;
const DIP_TRAIL_BPS = 150;
const TREND_TP_BPS = 150;
const TREND_SL_BPS = 100;
const TREND_TRAIL_BPS = 100;
// Trading window: skip the first 15 bars, flatten 15 bars before the end.
const SKIP_BARS = 15;
const FLATTEN_BEFORE_END = 15;
const WINDOW_BARS = 1440;

/** Closes so far, null for a bar the symbol missed. Index = batch seq. */
const closes: (bigint | null)[] = [];
/** 120-bar EMA of closes, carried forward unchanged over a missed bar. */
let ema120 = 0;
let emaSeeded = false;
/** Entry bookkeeping for the open position (decision-bar closes). */
let entryClose = 0;
let peakClose = 0;
let entrySeq = 0;
let mode: 'dip' | 'trend' | null = null;
/** First seq at which each dip condition turned true (null while false). */
let dipShortSince: number | null = null;
let dipLongSince: number | null = null;

function closeAt(seq: number): bigint | null {
  if (seq < 0 || seq >= closes.length) return null;
  return closes[seq];
}

/** Ratio (a / b - 1) in bps, as a float; null when either side is missing. */
function retBps(a: bigint | null, b: bigint | null): number | null {
  if (a === null || b === null || b === 0n) return null;
  return (Number(a) / Number(b) - 1) * 10000;
}

function holding(state: BarsState): boolean {
  const p = state.positions.get(SYMBOL);
  return p !== undefined && p.qty > 0n;
}

await runBars({
  onBatch(state, batch) {
    const seq = batch.seq;
    const close = state.close(SYMBOL);
    closes.push(close);
    if (close !== null) {
      if (!emaSeeded) {
        ema120 = Number(close);
        emaSeeded = true;
      } else {
        const k = 2 / (EMA_BARS + 1);
        ema120 = Number(close) * k + ema120 * (1 - k);
      }
    }

    // Track when each dip condition first turned true (freshness filter).
    const dipShort = retBps(close, closeAt(seq - DIP_SHORT_BARS));
    const dipLong = retBps(close, closeAt(seq - DIP_LONG_BARS));
    if (dipShort !== null && dipShort <= -DIP_SHORT_BPS) {
      if (dipShortSince === null) dipShortSince = seq;
    } else {
      dipShortSince = null;
    }
    if (dipLong !== null && dipLong <= -DIP_LONG_BPS) {
      if (dipLongSince === null) dipLongSince = seq;
    } else {
      dipLongSince = null;
    }

    const firstTrade = state.warmupBars + SKIP_BARS;
    const flattenAt = state.warmupBars + WINDOW_BARS - FLATTEN_BEFORE_END;

    // Flat in the warm-up / opening bars, and flat before the window ends.
    if (seq < firstTrade) return [];
    if (seq >= flattenAt) {
      if (!holding(state)) return [];
      const qty = state.positions.get(SYMBOL)!.qty;
      mode = null;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (close === null) return [];

    if (holding(state)) {
      if (entryClose === 0 || mode === null) return [];
      if (Number(close) > peakClose) peakClose = Number(close);
      const tp = mode === 'dip' ? DIP_TP_BPS : TREND_TP_BPS;
      const sl = mode === 'dip' ? DIP_SL_BPS : TREND_SL_BPS;
      const trail = mode === 'dip' ? DIP_TRAIL_BPS : TREND_TRAIL_BPS;
      const gainBps = (Number(close) / entryClose - 1) * 10000;
      const offPeakBps = (Number(close) / peakClose - 1) * 10000;
      const exit =
        gainBps >= tp || gainBps <= -sl || offPeakBps <= -trail || seq - entrySeq >= TIME_STOP_BARS;
      if (!exit) return [];
      const qty = state.positions.get(SYMBOL)!.qty;
      mode = null;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Flat: look for an entry.
    const prev = closeAt(seq - 1);
    const upturn = prev !== null && close > prev;
    const freshShort = dipShortSince !== null && seq - dipShortSince <= DIP_FRESH_BARS;
    const freshLong = dipLongSince !== null && seq - dipLongSince <= DIP_FRESH_BARS;
    const dip =
      upturn &&
      ((dipShort !== null && dipShort <= -DIP_SHORT_BPS && freshShort) ||
        (dipLong !== null && dipLong <= -DIP_LONG_BPS && freshLong));

    let trend = false;
    if (!dip) {
      const r60 = retBps(close, closeAt(seq - TREND_BARS));
      trend = r60 !== null && r60 >= TREND_BPS && emaSeeded && Number(close) > ema120;
    }

    if (!dip && !trend) return [];
    const full = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    const notional = (full * BigInt(SIZE_PCT)) / 100n;
    if (notional <= 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryClose = Number(close);
    peakClose = Number(close);
    entrySeq = seq;
    mode = dip ? 'dip' : 'trend';
    const orders: OrderInput[] = [
      { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS },
    ];
    return orders;
  },
});
