// ============================================================================
// DROPRATE — buying a game, from the button to the copy in your wallet.
//
// Deliberately a SEPARATE module rather than more code inside store.html. The
// checkout is the part most likely to need changing, and a 74KB page paste for
// every tweak is how small fixes stop happening.
//
// Drop it in with one line, anywhere on the page:
//     <script type="module" src="/buy.js"></script>
// then open it from anything:
//     DropRateBuy.open(productId)
//
// THE FLOW — five calls, two wallet prompts.
//   quote     what it costs in each currency, and what the chain will charge
//   open      claims a copy, locks the price for 15 minutes
//   buildpay  unsigned transfer to the treasury      <- buyer signs #1
//   verify    finds that payment on-chain
//   mint      unsigned mint, pre-signed by DropRate  <- buyer signs #2
//   confirm   checks the chain, records the copy
//
// Payment and mint are separate on purpose. If the mint fails — wallet closed,
// blockhash expired, no SOL for rent — the payment is already recorded and the
// mint can simply be retried. A buyer who has paid can never end up with
// nothing, which is the failure this whole shape exists to prevent.
//
// WHY THE RECEIPT, RATHER THAN DROPPING STRAIGHT INTO THE GAME
//   A game that starts playing itself the moment you pay is a game you rented.
//   A copy that appears in your library with a serial number on it is a thing
//   you own. The receipt is the difference, and it's the whole pitch.
// ============================================================================

import * as web3 from 'https://esm.sh/@solana/web3.js@1.95.3';

const API = '/api/crate';
const LIB_KEY = 'droprate-library';

let wallet = null;
let OWNER = null;

// ---- plumbing --------------------------------------------------------------
const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

async function api(body) {
  let r, j;
  try { r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { return { error: 'network error — check your connection' }; }
  try { j = await r.json(); } catch { j = { error: 'server error (' + r.status + ')' }; }
  return j;
}
const dapi = (body) => api({ ns: 'devmarket', ...body });

function detectWallet() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.solana) return window.solana;
  return null;
}

async function connect() {
  const p = detectWallet();
  if (!p) throw new Error('No Solana wallet found. Install Phantom or Solflare, then try again.');
  const r = await p.connect();
  wallet = p;
  OWNER = ((r && r.publicKey) ? r.publicKey : p.publicKey).toString();
  return OWNER;
}
const ensureWallet = async () => OWNER || connect();

async function signMsg(action) {
  const ts = Math.floor(Date.now() / 1000);
  const message = `DROPRATE devmarket ${action} wallet:${OWNER} ts:${ts}`;
  const res = await wallet.signMessage(new TextEncoder().encode(message), 'utf8');
  const sig = (res && res.signature) ? res.signature : res;
  const bytes = sig instanceof Uint8Array ? sig : new Uint8Array(sig);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return { message, signature: btoa(s) };
}

/* The server says which kind it built rather than us sniffing bytes — a legacy
   and a v0 transaction both start with a signature count, so guessing from the
   first byte is a coin flip that fails in production, not in testing. */
function decodeTx(b64, versioned) {
  const bytes = b64ToBytes(b64);
  return versioned ? web3.VersionedTransaction.deserialize(bytes) : web3.Transaction.from(bytes);
}

const fmtAmount = (raw, decimals) => {
  const s = String(raw).padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 4)}` : whole;
};
const money = (cents) => '$' + (cents / 100).toFixed(2);

// ---- the local library -----------------------------------------------------
// Instant to read and survives a refresh. The server's native-buy-library is
// the authority — this is just so the receipt doesn't vanish on reload.
function libraryAdd(entry) {
  try {
    const all = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
    if (!all.some((x) => x.asset_address === entry.asset_address)) all.unshift(entry);
    localStorage.setItem(LIB_KEY, JSON.stringify(all.slice(0, 200)));
  } catch { /* private window, quota, whatever — the server still has it */ }
}
export function libraryRead() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch { return []; }
}

// ---- styles ----------------------------------------------------------------
// Falls back to its own palette so the module works on a page that doesn't
// define DropRate's tokens.
const CSS = `
.drb-back{position:fixed;inset:0;z-index:9999;background:rgba(4,6,14,.78);
  backdrop-filter:blur(7px);display:grid;place-items:center;padding:20px;
  animation:drb-fade .18s ease}
@keyframes drb-fade{from{opacity:0}to{opacity:1}}
.drb{width:100%;max-width:440px;background:var(--panel,#141930);
  border:1px solid var(--line,#28305a);border-radius:18px;overflow:hidden;
  box-shadow:0 30px 80px -30px rgba(0,0,0,.9);
  font-family:var(--font,'Poppins',system-ui,sans-serif);color:var(--ice,#f3f5ff);
  animation:drb-rise .22s cubic-bezier(.2,.8,.3,1)}
@keyframes drb-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.drb-hd{display:flex;align-items:center;gap:12px;padding:18px 20px;
  border-bottom:1px solid var(--line,#28305a)}
.drb-hd h3{font-family:var(--display,'Chakra Petch',sans-serif);font-size:1.02rem;
  letter-spacing:.03em;margin:0;flex:1;text-transform:uppercase}
.drb-x{background:none;border:0;color:var(--dim2,#6b73a0);font-size:22px;line-height:1;
  cursor:pointer;padding:2px 6px;border-radius:6px}
.drb-x:hover{color:var(--ice,#f3f5ff)}
.drb-bd{padding:20px}
.drb-game{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  margin-bottom:16px}
.drb-title{font-family:var(--display,'Chakra Petch',sans-serif);font-size:1.22rem;
  letter-spacing:.02em}
.drb-price{font-family:var(--mono,monospace);font-size:1.06rem;color:var(--gold,#ffc24b)}
.drb-lbl{font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.15em;
  text-transform:uppercase;color:var(--dim2,#6b73a0);display:block;margin-bottom:9px}

.drb-ccy{display:grid;gap:8px;margin-bottom:16px}
.drb-opt{display:flex;align-items:center;gap:12px;width:100%;text-align:left;
  background:var(--panel2,#1a2039);border:1px solid var(--line,#28305a);
  border-radius:11px;padding:13px 15px;cursor:pointer;color:inherit;
  font-family:inherit;transition:border-color .14s,background .14s}
.drb-opt:hover{border-color:var(--gold,#ffc24b)}
.drb-opt[aria-pressed="true"]{border-color:var(--gold,#ffc24b);
  background:rgba(255,194,75,.08);box-shadow:0 0 0 2px rgba(255,194,75,.14)}
.drb-opt:focus-visible{outline:2px solid var(--gold,#ffc24b);outline-offset:2px}
.drb-cn{font-family:var(--display,sans-serif);font-weight:700;letter-spacing:.05em;
  font-size:.86rem;flex:0 0 54px}
.drb-ca{font-family:var(--mono,monospace);font-size:12.5px;color:var(--dim,#98a1c8);flex:1}
.drb-save{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.1em;
  text-transform:uppercase;background:var(--gold,#ffc24b);color:#241a04;
  border-radius:999px;padding:3px 8px;font-weight:700}

.drb-fee{display:flex;justify-content:space-between;gap:10px;
  font-size:12.5px;color:var(--dim,#98a1c8);padding:11px 14px;
  background:var(--panel2,#1a2039);border:1px solid var(--line,#28305a);
  border-radius:10px;margin-bottom:16px}
.drb-fee b{color:var(--ice,#f3f5ff);font-family:var(--mono,monospace);font-weight:500}

.drb-go{width:100%;border:0;border-radius:11px;padding:14px;cursor:pointer;
  background:linear-gradient(180deg,var(--gold,#ffc24b),var(--gold-deep,#e8941b));
  color:#241a04;font-family:var(--display,sans-serif);font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;font-size:.88rem;
  transition:filter .14s}
.drb-go:hover:not(:disabled){filter:brightness(1.08)}
.drb-go:disabled{opacity:.45;cursor:not-allowed}
.drb-go:focus-visible{outline:2px solid var(--gold,#ffc24b);outline-offset:3px}
.drb-ghost{background:none;border:1px solid var(--line,#28305a);color:var(--dim,#98a1c8);
  border-radius:11px;padding:12px;width:100%;cursor:pointer;font-family:var(--display,sans-serif);
  font-weight:700;letter-spacing:.05em;text-transform:uppercase;font-size:.8rem;margin-top:9px}
.drb-ghost:hover{color:var(--ice,#f3f5ff);border-color:var(--dim2,#6b73a0)}

/* progress — the steps are real and ordered, so show them as such */
.drb-steps{display:grid;gap:2px;margin:4px 0 18px}
.drb-st{display:flex;align-items:center;gap:11px;padding:9px 0;font-size:13.5px;
  color:var(--dim2,#6b73a0)}
.drb-st .dot{width:8px;height:8px;border-radius:50%;background:var(--line,#28305a);
  flex:0 0 auto;transition:background .2s}
.drb-st.now{color:var(--ice,#f3f5ff)}
.drb-st.now .dot{background:var(--gold,#ffc24b);
  animation:drb-pulse 1.1s ease-in-out infinite}
.drb-st.done{color:var(--dim,#98a1c8)}
.drb-st.done .dot{background:#5fd39b;animation:none}
@keyframes drb-pulse{0%,100%{opacity:1}50%{opacity:.28}}
.drb-note{font-size:12.5px;color:var(--dim2,#6b73a0);text-align:center;margin:0}

.drb-err{background:rgba(255,107,107,.09);border:1px solid rgba(255,107,107,.32);
  color:#ff8095;border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px}

/* receipt */
.drb-seal{text-align:center;padding:4px 0 16px}
.drb-seal .ring{width:52px;height:52px;margin:0 auto 12px;border-radius:50%;
  border:2px solid #5fd39b;display:grid;place-items:center;color:#5fd39b;font-size:24px}
.drb-seal h4{font-family:var(--display,sans-serif);font-size:1.16rem;margin:0 0 4px;
  letter-spacing:.02em}
.drb-seal p{margin:0;color:var(--dim,#98a1c8);font-size:13.5px}
.drb-rows{border:1px solid var(--line,#28305a);border-radius:11px;overflow:hidden;
  margin-bottom:16px}
.drb-row{display:flex;justify-content:space-between;gap:12px;padding:11px 14px;
  font-size:13px;border-bottom:1px solid var(--line,#28305a)}
.drb-row:last-child{border-bottom:0}
.drb-row span{color:var(--dim2,#6b73a0)}
.drb-row b{font-family:var(--mono,monospace);font-weight:500;text-align:right;
  word-break:break-all;font-size:12px}
.drb-row a{color:var(--gold,#ffc24b);font-family:var(--mono,monospace);font-size:12px}
@media(max-width:460px){.drb-bd{padding:16px}}
@media(prefers-reduced-motion:reduce){.drb,.drb-back,.drb-st .dot{animation:none!important}}
`;

function injectCss() {
  if (document.getElementById('drb-css')) return;
  const s = document.createElement('style');
  s.id = 'drb-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---- modal shell -----------------------------------------------------------
let back = null;
function shell(title, bodyHtml) {
  injectCss();
  if (!back) {
    back = document.createElement('div');
    back.className = 'drb-back';
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    document.addEventListener('keydown', escClose);
  }
  back.innerHTML =
    `<div class="drb" role="dialog" aria-modal="true" aria-label="${title}">
       <div class="drb-hd"><h3>${title}</h3><button class="drb-x" aria-label="Close">&times;</button></div>
       <div class="drb-bd">${bodyHtml}</div>
     </div>`;
  back.querySelector('.drb-x').addEventListener('click', close);
  return back.querySelector('.drb-bd');
}
function escClose(e) { if (e.key === 'Escape') close(); }
export function close() {
  if (back) back.remove();
  back = null;
  document.removeEventListener('keydown', escClose);
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// ---- step 1: what does it cost ---------------------------------------------
export async function open(productId) {
  const bd = shell('Buy', '<p class="drb-note">Checking price…</p>');
  const q = await dapi({ action: 'native-buy-quote', product_id: Number(productId) });
  if (q.error) {
    bd.innerHTML = `<div class="drb-err">${esc(q.error)}</div>
      <button class="drb-ghost" data-close>Close</button>`;
    bd.querySelector('[data-close]').addEventListener('click', close);
    return;
  }
  if (q.supply_model === 'finite' && q.available === 0) {
    bd.innerHTML = `<div class="drb-err">This run has sold out.</div>
      <button class="drb-ghost" data-close>Close</button>`;
    bd.querySelector('[data-close]').addEventListener('click', close);
    return;
  }
  renderPicker(q, productId);
}

function renderPicker(q, productId) {
  const order = ['DROP', 'USDC', 'SOL'].filter((c) => q.quotes[c]);
  if (!order.length) {
    shell('Buy', `<div class="drb-err">No payment method is available right now — the price feed is down. Try again in a minute.</div>`);
    return;
  }
  const usdcUsd = q.quotes.USDC ? q.quotes.USDC.usd : null;

  const opts = order.map((c) => {
    const v = q.quotes[c];
    const saving = (c === 'DROP' && usdcUsd) ? Math.round((1 - v.usd / usdcUsd) * 100) : 0;
    return `<button class="drb-opt" role="button" aria-pressed="${c === order[0]}" data-ccy="${c}">
        <span class="drb-cn">${c === 'DROP' ? '$DROP' : c}</span>
        <span class="drb-ca">${fmtAmount(v.amount_raw, v.decimals)}</span>
        ${saving > 0 ? `<span class="drb-save">Save ${saving}%</span>` : ''}
      </button>`;
  }).join('');

  const supply = q.supply_model === 'finite'
    ? `<span>${q.available} of ${q.available + (q.minted_count || 0)} left</span>` : '';

  const bd = shell('Buy', `
    <div class="drb-game">
      <span class="drb-title">${esc(q.title)}</span>
      <span class="drb-price">${money(q.price_cents)}</span>
    </div>
    <span class="drb-lbl">Pay with</span>
    <div class="drb-ccy">${opts}</div>
    <div class="drb-fee">
      <span>Network fee${supply ? '' : ''}</span>
      <b>~${q.network_fee_sol} SOL</b>
    </div>
    <button class="drb-go" data-go>Buy this game</button>
    <p class="drb-note" style="margin-top:12px">
      You'll approve twice — once to pay, once to mint the copy into your wallet.
    </p>
  `);

  let chosen = order[0];
  bd.querySelectorAll('.drb-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      chosen = btn.dataset.ccy;
      bd.querySelectorAll('.drb-opt').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    });
  });
  bd.querySelector('[data-go]').addEventListener('click', () => run(productId, chosen, q));
}

// ---- steps 2-6: the purchase ------------------------------------------------
const STEPS = [
  ['pay', 'Pay the developer'],
  ['verify', 'Confirm the payment on-chain'],
  ['mint', 'Mint your copy'],
  ['record', 'Add it to your library'],
];

function progress(title, activeKey, message, errorHtml) {
  const rows = STEPS.map(([key, label], i) => {
    const at = STEPS.findIndex(([k]) => k === activeKey);
    const cls = i < at ? 'done' : i === at ? 'now' : '';
    return `<div class="drb-st ${cls}"><span class="dot"></span>${label}</div>`;
  }).join('');
  const bd = shell(title, `${errorHtml || ''}<div class="drb-steps">${rows}</div>
    <p class="drb-note">${esc(message)}</p>`);
  return bd;
}

function failure(message, retryLabel, onRetry) {
  const bd = shell('Something went wrong', `
    <div class="drb-err">${esc(message)}</div>
    ${onRetry ? `<button class="drb-go" data-retry>${esc(retryLabel)}</button>` : ''}
    <button class="drb-ghost" data-close>Close</button>`);
  if (onRetry) bd.querySelector('[data-retry]').addEventListener('click', onRetry);
  bd.querySelector('[data-close]').addEventListener('click', close);
}

async function run(productId, currency, quote) {
  try {
    progress('Buy', 'pay', 'Connecting your wallet…');
    await ensureWallet();
  } catch (e) {
    return failure(e.message, 'Try again', () => run(productId, currency, quote));
  }

  // --- claim a copy and lock the price
  progress('Buy', 'pay', 'Reserving your copy…');
  const order = await dapi({ action: 'native-buy-open', product_id: Number(productId), buyer: OWNER, pay_currency: currency });
  if (order.error) {
    const soldOut = /sold out/i.test(order.error);
    return failure(soldOut ? 'Someone bought the last copy while you were deciding.' : order.error,
      soldOut ? null : 'Try again', soldOut ? null : () => run(productId, currency, quote));
  }

  // --- pay
  progress('Buy', 'pay', 'Approve the payment in your wallet.');
  const bp = await dapi({ action: 'native-buy-buildpay', order_id: order.order_id, payer: OWNER });
  if (bp.error) return failure(bp.error, 'Try again', () => run(productId, currency, quote));

  try {
    const tx = decodeTx(bp.transaction, !!bp.versioned);
    await wallet.signAndSendTransaction(tx);
  } catch (e) {
    return failure('Payment was rejected or cancelled in your wallet. Nothing has been charged.',
      'Try again', () => run(productId, currency, quote));
  }

  // --- verify: the payment has to be found on-chain before anything is minted
  progress('Buy', 'verify', 'Waiting for the network to confirm…');
  const paid = await poll(
    () => dapi({ action: 'native-buy-verify', order_id: order.order_id }),
    (r) => r.state === 'paid' || r.state === 'complete',
    (r) => r.error && !/payment-not-found/i.test(r.error),
    30, 2500
  );
  if (!paid.ok) {
    return failure(
      paid.result?.error === 'payment-not-found'
        ? "We couldn't find your payment on-chain. If your wallet says it went through, wait a moment and retry — nothing is lost."
        : (paid.result?.error || 'Could not confirm the payment.'),
      'Check again', () => resume(order, productId, quote));
  }

  await mintStep(order, productId, quote);
}

/* Split out because it is the retry target. Payment is already recorded at this
   point, so a failed mint is never a lost purchase — the buyer comes back here
   and nothing else has to happen again. */
async function mintStep(order, productId, quote) {
  progress('Buy', 'mint', 'Approve the mint — this is the copy going into your wallet.');
  const m = await dapi({ action: 'native-buy-mint', order_id: order.order_id });
  if (m.error) {
    if (/already minted/i.test(m.error)) return receipt(order, quote, m.asset, productId);
    return failure(m.error, 'Try again', () => mintStep(order, productId, quote));
  }

  let sig;
  try {
    const tx = decodeTx(m.transaction, !!m.versioned);
    const r = await wallet.signAndSendTransaction(tx);
    sig = r?.signature || r;
  } catch (e) {
    return failure(
      "The mint was cancelled, or your wallet didn't have enough SOL for the copy's on-chain rent (about " +
      (m.network_fee_sol || 0.0034) + " SOL). Your payment is safe and recorded — you can finish this any time.",
      'Mint my copy', () => mintStep(order, productId, quote));
  }

  progress('Buy', 'record', 'Registering your copy…');
  const done = await poll(
    () => dapi({ action: 'native-buy-confirm', order_id: order.order_id, asset_address: m.asset_address, mint_sig: sig }),
    (r) => r.state === 'complete',
    (r) => r.error,
    30, 2500
  );
  if (!done.ok) {
    return failure(
      done.result?.error ||
      "Your copy was minted but we couldn't record it yet. It's yours on-chain either way — retry and it'll catch up.",
      'Finish up', () => mintStep(order, productId, quote));
  }

  receipt(order, quote, m.asset_address, productId, done.result.copy_number);
}

/* Poll until done, failed, or we give up. Chain reads lag writes — a "not found"
   two seconds after a transaction lands is normal, not an error. */
async function poll(fn, isDone, isFatal, tries, delayMs) {
  let result;
  for (let i = 0; i < tries; i++) {
    result = await fn();
    if (isDone(result)) return { ok: true, result };
    if (isFatal(result)) return { ok: false, result };
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, result };
}

// ---- the receipt -----------------------------------------------------------
function receipt(order, quote, asset, productId, copyNumber) {
  const entry = {
    product_id: Number(productId),
    title: quote.title,
    asset_address: asset,
    copy_number: copyNumber || order.copy_number,
    order_id: order.order_id,
    price_cents: quote.price_cents,
    currency: order.pay_currency,
    at: new Date().toISOString(),
  };
  libraryAdd(entry);

  const short = (s) => String(s).slice(0, 6) + '…' + String(s).slice(-6);
  const bd = shell('Yours', `
    <div class="drb-seal">
      <div class="ring">&#10003;</div>
      <h4>${esc(quote.title)}</h4>
      <p>Copy #${entry.copy_number} is in your wallet.</p>
    </div>
    <div class="drb-rows">
      <div class="drb-row"><span>Paid</span><b>${money(quote.price_cents)} in ${esc(order.pay_currency)}</b></div>
      <div class="drb-row"><span>Copy</span><b>#${entry.copy_number}</b></div>
      <div class="drb-row"><span>Asset</span>
        <a href="https://solscan.io/token/${encodeURIComponent(asset)}" target="_blank" rel="noopener">${short(asset)}</a></div>
    </div>
    <button class="drb-go" data-play>Play now</button>
    <button class="drb-ghost" data-close>I'll play later</button>
    <p class="drb-note" style="margin-top:12px">
      It's in your library whenever you want it. Sell it and access ends by itself.
    </p>
  `);
  bd.querySelector('[data-play]').addEventListener('click', () => {
    window.location.href = '/play.html?id=' + encodeURIComponent(productId);
  });
  bd.querySelector('[data-close]').addEventListener('click', () => {
    close();
    document.dispatchEvent(new CustomEvent('droprate:purchased', { detail: entry }));
  });
}

/* Re-enter a purchase that was interrupted after payment. */
async function resume(order, productId, quote) {
  progress('Buy', 'verify', 'Checking your payment…');
  const v = await dapi({ action: 'native-buy-verify', order_id: order.order_id });
  if (v.state === 'paid' || v.state === 'complete') return mintStep(order, productId, quote);
  return failure(v.error || 'Still cannot find the payment.', 'Check again', () => resume(order, productId, quote));
}

// ---- public surface --------------------------------------------------------
window.DropRateBuy = { open, close, libraryRead };
export default { open, close, libraryRead };
