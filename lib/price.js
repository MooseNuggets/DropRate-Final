// ============================================================================
// DROPRATE — $DROP price oracle guard (ADDITIVE, gacha only)
//
// Crates are priced in USD but paid in $DROP, so we need a $DROP/USD price to
// quote. A pump.fun micro-cap has thin liquidity, so a naive spot read can be
// flash-manipulated to buy crates for pennies. This module hardens that:
//   - aggregate several sources with a MEDIAN (one bad feed can't swing it)
//   - compare against a TWAP (time-weighted recent history)
//   - reject if spot deviates from TWAP beyond a bound (manipulation smell)
//   - clamp to sane absolute min/max
//
// All pure/deterministic. The actual price FETCHES (Jupiter, pool reserves) are
// injected by the caller, so this whole guard is unit-testable offline.
// ============================================================================

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (a.length === 0) throw new Error("price: no valid samples");
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// samples: [{ t, price }] with t in ms ascending. Time-weighted average over
// the window (each price weighted by how long it stood).
export function twap(samples) {
  const s = samples.filter((x) => Number.isFinite(x.price) && x.price > 0).sort((a, b) => a.t - b.t);
  if (s.length === 0) throw new Error("price: no twap samples");
  if (s.length === 1) return s[0].price;
  let num = 0, den = 0;
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (dt <= 0) continue;
    num += s[i - 1].price * dt; // price held over [t_{i-1}, t_i)
    den += dt;
  }
  return den > 0 ? num / den : s[s.length - 1].price;
}

export function deviationBps(a, b) {
  if (b === 0) return Infinity;
  return Math.abs(a - b) / b * 10000;
}

// Produce a price we're willing to quote against, or throw if it looks unsafe.
//   spotSources: array of independent spot prices (Jupiter, pool, CEX...)
//   history:     [{t,price}] recent samples for the TWAP
//   opts: { maxDeviationBps=1500 (15%), min, max }
export function safePrice(spotSources, history, opts = {}) {
  const maxDev = opts.maxDeviationBps ?? 1500;
  const spot = median(spotSources);
  const ref = twap(history);
  const dev = deviationBps(spot, ref);
  if (dev > maxDev) {
    const err = new Error(`price: spot ${spot} deviates ${dev.toFixed(0)}bps from TWAP ${ref} (> ${maxDev})`);
    err.code = "PRICE_UNSAFE";
    throw err;
  }
  // quote against the MORE CONSERVATIVE (higher) of spot/twap so a dip can't be
  // exploited to buy crates cheap; higher $DROP price => fewer tokens per crate.
  let price = Math.max(spot, ref);
  if (opts.min != null) price = Math.max(price, opts.min);
  if (opts.max != null) price = Math.min(price, opts.max);
  return { price, spot, twap: ref, deviationBps: dev };
}
