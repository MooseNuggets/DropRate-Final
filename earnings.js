// ============================================================================
// DROPRATE — the Earnings tab in the dev portal.
//
// A module rather than more markup inside devportal.html, for the same reason
// buy.js is one: the portal is 70KB, and anything that lives inside it only gets
// improved when someone is willing to re-paste 70KB.
//
// It borrows the portal's OWN wallet and signing. A second wallet connection on
// the same page would mean a developer could be signed into one identity in the
// header and another in a tab, which is exactly the kind of thing nobody notices
// until money goes to the wrong address.
//
//   import { mountEarnings } from '/earnings.js';
//   mountEarnings(document.getElementById('earnings-panel'), { apiSigned });
//
// THE PROMISE THIS PAGE MAKES
//   Money is earned the moment a copy mints — no holding period, because a copy
//   delivered on-chain cannot fail to arrive. Withdrawal is a request, not an
//   automatic push: no dust transfers, no automated outbound movement from the
//   treasury, and the developer picks the moment.
// ============================================================================

const CSS = `
.ern-cards{display:grid;gap:13px;grid-template-columns:repeat(auto-fit,minmax(228px,1fr));margin:14px 0 6px}
.ern-c{background:var(--panel2,#1a2039);border:1px solid var(--line,#28305a);border-radius:14px;padding:17px 18px}
.ern-c.live{border-color:rgba(255,194,75,.42)}
.ern-ccy{font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--dim2,#6b73a0);display:block;margin-bottom:5px}
.ern-amt{font-family:var(--display,sans-serif);font-weight:700;font-size:1.75rem;line-height:1.1;
  font-variant-numeric:tabular-nums;color:var(--ice,#f3f5ff)}
.ern-c.live .ern-amt{color:var(--gold-hi,#ffe6a8)}
.ern-lines{margin-top:12px;display:grid;gap:4px;font-size:12px;color:var(--dim2,#6b73a0)}
.ern-lines div{display:flex;justify-content:space-between;gap:10px}
.ern-lines b{color:var(--dim,#98a1c8);font-family:var(--mono,monospace);font-weight:500;font-variant-numeric:tabular-nums}
.ern-go{width:100%;margin-top:14px;border:0;border-radius:10px;padding:11px;cursor:pointer;
  font-family:var(--display,sans-serif);font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  font-size:12px;color:#241a04;background:linear-gradient(180deg,var(--gold,#ffc24b),var(--gold-deep,#e8941b))}
.ern-go:hover:not(:disabled){filter:brightness(1.07)}
.ern-go:disabled{background:none;border:1px solid var(--line,#28305a);color:var(--dim2,#6b73a0);cursor:not-allowed}
.ern-go:focus-visible{outline:2px solid var(--gold,#ffc24b);outline-offset:2px}
.ern-foot{color:var(--dim2,#6b73a0);font-size:12px;margin:8px 0 0;word-break:break-all}
.ern-h{font-family:var(--display,sans-serif);font-size:.95rem;letter-spacing:.03em;text-transform:uppercase;
  color:var(--dim,#98a1c8);margin:26px 0 10px}
.ern-tblwrap{overflow-x:auto}
.ern-tbl{width:100%;border-collapse:collapse;font-size:13px}
.ern-tbl th{text-align:left;font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--dim2,#6b73a0);font-weight:400;padding:0 12px 8px 0;
  border-bottom:1px solid var(--line,#28305a)}
.ern-tbl td{padding:10px 12px 10px 0;border-bottom:1px solid var(--line,#28305a);
  color:var(--dim,#98a1c8);font-variant-numeric:tabular-nums}
.ern-tbl td:first-child{color:var(--ice,#f3f5ff);font-family:var(--mono,monospace);font-size:12px}
.ern-pill{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  border-radius:999px;padding:3px 8px;border:1px solid var(--line,#28305a)}
.ern-pill.sent{color:#5fd39b;border-color:rgba(95,211,155,.42)}
.ern-pill.failed{color:#ff6b6b;border-color:rgba(255,107,107,.42)}
.ern-msg{border-radius:11px;padding:12px 15px;margin:12px 0;font-size:13px}
.ern-msg.bad{background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);color:#ff8095}
.ern-msg.good{background:rgba(95,211,155,.08);border:1px solid rgba(95,211,155,.3);color:#5fd39b}
.ern-msg a{color:inherit}
.ern-empty{border:1px dashed var(--line,#28305a);border-radius:14px;padding:40px 22px;text-align:center;
  color:var(--dim,#98a1c8)}
.ern-empty b{color:var(--ice,#f3f5ff);display:block;font-family:var(--display,sans-serif);
  font-size:1.05rem;margin-bottom:6px}
`;

function injectCss() {
  if (document.getElementById('ern-css')) return;
  const s = document.createElement('style');
  s.id = 'ern-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* Base units to something a person reads. Trimmed of trailing zeros, but capped
   at four decimals — past that it stops looking like money and starts looking
   like a hash. */
function amount(raw, decimals) {
  const s = String(raw || '0').padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, '');
  let frac = s.slice(s.length - decimals).replace(/0+$/, '');
  if (frac.length > 4) frac = frac.slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
}
const label = (c) => (c === 'DROP' ? '$DROP' : c);
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function mountEarnings(root, { apiSigned }) {
  injectCss();
  let busy = false;

  /* A message has to survive the reload that follows it. load() rewrites the
     whole panel, so a note written before it is wiped a heartbeat later — which
     meant a developer could withdraw real money and see no confirmation at all.
     The pending note is therefore re-applied after the re-render. */
  let pending = null;
  const paintNote = () => {
    if (!pending) return;
    const el = root.querySelector('.ern-msg-slot');
    if (el) el.innerHTML = `<div class="ern-msg ${pending.kind}">${pending.html}</div>`;
  };
  const note = (kind, html) => { pending = { kind, html }; paintNote(); };

  function card(b) {
    const live = BigInt(b.available) > 0n;
    const cta = !live
      ? 'Nothing to withdraw yet'
      : (b.can_withdraw
        ? `Withdraw ${amount(b.available, b.decimals)} ${label(b.currency)}`
        : `Minimum ${amount(b.min_withdraw, b.decimals)} ${label(b.currency)}`);
    return `<div class="ern-c ${live ? 'live' : ''}">
        <span class="ern-ccy">${esc(label(b.currency))} available</span>
        <div class="ern-amt">${amount(b.available, b.decimals)}</div>
        <div class="ern-lines">
          <div><span>Unpaid sales</span><b>${b.unpaid_sales}</b></div>
          <div><span>Withdrawn</span><b>${amount(b.withdrawn, b.decimals)}</b></div>
          <div><span>Earned all time</span><b>${amount(b.lifetime, b.decimals)}</b></div>
          ${BigInt(b.in_flight) > 0n ? `<div><span>Being sent</span><b>${amount(b.in_flight, b.decimals)}</b></div>` : ''}
        </div>
        <button class="ern-go" data-ccy="${esc(b.currency)}" ${b.can_withdraw ? '' : 'disabled'}>${esc(cta)}</button>
      </div>`;
  }

  function history(rows) {
    if (!rows || !rows.length) return '';
    const body = rows.map((p) => `<tr>
        <td>${amount(p.amount_raw, p.decimals)} ${esc(label(p.currency))}</td>
        <td>${p.order_count} ${p.order_count === 1 ? 'sale' : 'sales'}</td>
        <td>${esc(when(p.sent_at || p.requested_at))}</td>
        <td><span class="ern-pill ${esc(p.status)}">${esc(p.status)}</span></td>
        <td>${p.tx_sig
          ? `<a href="https://solscan.io/tx/${encodeURIComponent(p.tx_sig)}" target="_blank" rel="noopener">view ↗</a>`
          : (p.error ? esc(String(p.error).slice(0, 70)) : '—')}</td>
      </tr>`).join('');
    return `<div class="ern-h">Withdrawals</div><div class="ern-tblwrap"><table class="ern-tbl">
        <thead><tr><th>Amount</th><th>Covers</th><th>When</th><th>Status</th><th></th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
  }

  async function withdraw(currency, btn) {
    if (busy) return;
    busy = true;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const r = await apiSigned('native-payout-request', { currency });
    busy = false;
    if (r.ok) {
      note('good', `Sent ${amount(r.amount_raw, r.decimals)} ${esc(label(currency))} to your wallet.` +
        (r.tx_sig ? ` <a href="https://solscan.io/tx/${encodeURIComponent(r.tx_sig)}" target="_blank" rel="noopener">View transaction ↗</a>` : ''));
    } else {
      note('bad', esc(r.error || 'That did not go through.'));
    }
    btn.textContent = was;
    load();          // re-applies the note above once it has re-rendered
  }

  async function load() {
    root.innerHTML = `<div class="ern-msg-slot"></div><p class="hint">Reading your earnings…</p>`;
    const r = await apiSigned('native-payout-balance');
    if (r.error) {
      root.innerHTML = `<div class="ern-msg-slot"></div>
        <div class="ern-msg bad">${esc(r.error)}</div>`;
      return;
    }

    const anyEver = r.balances.some((b) => BigInt(b.lifetime) > 0n);
    if (!anyEver && !(r.payouts || []).length) {
      root.innerHTML = `<div class="ern-msg-slot"></div>
        <div class="ern-empty"><b>No sales yet</b>
        When someone buys one of your games, your cut lands here straight away —
        no holding period, ready to withdraw.</div>`;
      paintNote();
      return;
    }

    root.innerHTML = `<div class="ern-msg-slot"></div>
      <p class="hint">Your cut is yours the moment a copy mints — a game delivered on-chain can't
        fail to arrive, so there's nothing to hold it for. Withdraw whenever you like; you're paid
        in whatever the buyer paid with.</p>
      <div class="ern-cards">${r.balances.map(card).join('')}</div>
      <p class="ern-foot">Paid out to <b>${esc(r.wallet || '')}</b> — the wallet on your seller profile.</p>
      ${history(r.payouts)}`;

    root.querySelectorAll('[data-ccy]').forEach((btn) => {
      if (!btn.disabled) btn.addEventListener('click', () => withdraw(btn.dataset.ccy, btn));
    });
    paintNote();
  }

  load();
  return { reload: load };
}
