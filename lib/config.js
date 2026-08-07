// ============ DROPRATE CONFIG — the only file you should need to edit ============
export const CONFIG = {
  // Token
  MINT: process.env.DROP_MINT || "",        // set in Vercel env after pump.fun deploy
  DECIMALS: 6,                              // pump.fun standard

  // Tickets
  TOKENS_PER_TICKET: 10_000,                // 10k $DROP = 1 ticket
  TICKET_CAP: 100,                          // max tickets per wallet (1M tokens)

  // Snapshots — 1h windows, random moment inside each
  WINDOW_HOURS: 1,
  OFFSET_MIN_MINUTES: 3,                    // random offset bounds inside window
  OFFSET_MAX_MINUTES: 55,                   //   (3..55 of a 60-min window)
  K_CONSECUTIVE: 4,                         // snapshots in a row required (~4h hold)
  SELL_LOOKBACK: 12,                        // snapshots scanned for sells (~12h);
                                            // ANY balance decrease or exit inside
                                            // this window = disqualified until a
                                            // clean streak spans it again

  // Eligibility runs from the very first snapshot.
  ELIGIBILITY_START: null,
};

// raw on-chain amount for one ticket (token has DECIMALS decimals)
export const RAW_PER_TICKET =
  BigInt(CONFIG.TOKENS_PER_TICKET) * 10n ** BigInt(CONFIG.DECIMALS);

export function ticketsFor(balanceRaw) {
  const t = balanceRaw / RAW_PER_TICKET;          // BigInt floor division
  const n = t > BigInt(CONFIG.TICKET_CAP) ? CONFIG.TICKET_CAP : Number(t);
  return n;
}
