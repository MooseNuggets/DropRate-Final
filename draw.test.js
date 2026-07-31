// ============ DROPRATE CONFIG — the only file you should need to edit ============
export const CONFIG = {
  // Token
  MINT: process.env.DROP_MINT || "",        // set in Vercel env after pump.fun deploy
  DECIMALS: 6,                              // pump.fun standard

  // Tickets
  TOKENS_PER_TICKET: 10_000,                // 10k $DROP = 1 ticket
  TICKET_CAP: 100,                          // max tickets per wallet (1M tokens)

  // Snapshots
  WINDOW_HOURS: 6,                          // recurring window length
  OFFSET_MIN_MINUTES: 5,                    // random offset bounds inside window
  OFFSET_MAX_MINUTES: 350,                  //   (5..350 of a 360-min window)
  K_CONSECUTIVE: 4,                         // snapshots in a row required (~24h)

  // Eligibility runs from the very first snapshot. The mint address never
  // changes at pump.fun graduation — just make sure the bonding curve address
  // is in the exclusions table before the first snapshot fires.
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
