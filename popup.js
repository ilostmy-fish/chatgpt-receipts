// Toolbar popup: stats over every reply content.js has saved (chrome.storage.local, "chat:<id>").
(() => {
  const DAY_MS = 86_400_000;
  const RANGE_DAYS = { 1: 1, 7: 7, 30: 30, all: Infinity };
  const TOP_MODELS = 6;
  const TOP_PAIRS = 5;
  const RECENT = 5;

  const $ = (sel) => document.querySelector(sel);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const warnIcon = () => $('#warn-icon').content.firstElementChild.cloneNode(true);
  const fmtInt = (n) => n.toLocaleString();
  const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '\u2013');
  const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  // Remembered per viewer; the popup's own origin, so plain localStorage is fine.
  let range = '7';
  try { range = localStorage.getItem('receipts.range') || range; } catch {}
  if (!(range in RANGE_DAYS)) range = '7';

  let replies = [];

  async function load() {
    const all = await chrome.storage.local.get(null);
    replies = [];
    for (const [key, chat] of Object.entries(all)) {
      if (!key.startsWith('chat:') || !chat?.messages) continue;
      for (const rec of Object.values(chat.messages)) {
        if (!Receipts.isReply(rec)) continue;
        const c = Receipts.classify(rec);
        if (!c.served) continue;
        replies.push({
          ...c,
          chatId: chat.id,
          at: rec.createdAt ? rec.createdAt * 1000 : rec.updatedAt || 0,
          elapsedMs: rec.elapsedMs,
        });
      }
    }
    render();
  }

  function summarize(list) {
    const served = new Map();
    const pairs = new Map();
    const timing = new Map();
    const chats = new Set();
    let rerouted = 0;
    let eligible = 0;

    for (const r of list) {
      chats.add(r.chatId);
      const s = served.get(r.served) ?? { model: r.served, n: 0, reroutedIn: 0 };
      s.n++;
      served.set(r.served, s);
      if (r.picked && !r.pickedAuto) eligible++;

      if (r.rerouted) {
        rerouted++;
        s.reroutedIn++;
        const key = `${r.picked}\u0000${r.served}`;
        const p = pairs.get(key) ?? { picked: r.picked, served: r.served, n: 0, last: 0 };
        p.n++;
        p.last = Math.max(p.last, r.at);
        pairs.set(key, p);
      }
      if (r.elapsedMs != null) {
        const t = timing.get(r.served) ?? { model: r.served, sum: 0, n: 0, min: Infinity };
        t.sum += r.elapsedMs;
        t.n++;
        t.min = Math.min(t.min, r.elapsedMs);
        timing.set(r.served, t);
      }
    }

    return {
      total: list.length,
      chats: chats.size,
      rerouted,
      eligible,
      served: [...served.values()].sort((a, b) => b.n - a.n),
      pairs: [...pairs.values()].sort((a, b) => b.n - a.n || b.last - a.last),
      timing: [...timing.values()].sort((a, b) => b.sum / b.n - a.sum / a.n),
      recent: list.filter((r) => r.rerouted).sort((a, b) => b.at - a.at).slice(0, RECENT),
    };
  }

  function render() {
    for (const b of document.querySelectorAll('.range button')) {
      b.setAttribute('aria-checked', String(b.dataset.range === range));
    }
    const cutoff = Date.now() - RANGE_DAYS[range] * DAY_MS;
    const s = summarize(replies.filter((r) => r.at >= cutoff));

    $('#stats').hidden = s.total === 0;
    $('#empty').hidden = s.total > 0;
    if (!s.total) {
      $('#empty').textContent = replies.length
        ? 'No replies in this time range.'
        : "No replies yet. Open a ChatGPT chat and they'll show up here.";
      return;
    }

    $('#k-replies').textContent = fmtInt(s.total);
    $('#k-replies-sub').textContent = `in ${plural(s.chats, 'chat')}`;
    $('#k-rerouted').textContent = fmtInt(s.rerouted);
    $('#k-warn').replaceChildren(...(s.rerouted ? [warnIcon()] : []));
    $('#k-rate').textContent = pct(s.rerouted, s.eligible);
    $('#k-rate-sub').textContent = `of ${fmtInt(s.eligible)} non-Auto`;

    renderBars(s);
    renderPairs(s);
    renderRecent(s);
    renderTiming(s);
  }

  function renderBars(s) {
    let rows = s.served.slice(0, TOP_MODELS);
    const rest = s.served.slice(TOP_MODELS);
    if (rest.length) {
      rows = [...rows, {
        model: `Other (${plural(rest.length, 'model')})`,
        n: rest.reduce((sum, r) => sum + r.n, 0),
        reroutedIn: rest.reduce((sum, r) => sum + r.reroutedIn, 0),
        other: true,
      }];
    }
    const max = Math.max(...rows.map((r) => r.n));
    $('#bars').replaceChildren(...rows.map((r) => {
      const row = el('div', 'bar-row');
      row.tabIndex = 0;
      const bar = el('div', 'bar');
      bar.style.width = `calc((100% - 44px) * ${r.n / max})`;
      const line = el('div', 'bar-line');
      line.append(bar, el('span', 'bar-val', fmtInt(r.n)));
      row.append(el('div', r.other ? 'bar-name is-other' : 'bar-name', r.model), line);
      row.dataset.tip = JSON.stringify([
        plural(r.n, 'reply', 'replies'),
        `${pct(r.n, s.total)} of replies \u00b7 ${fmtInt(r.reroutedIn)} rerouted here`,
      ]);
      return row;
    }));
  }

  function renderPairs(s) {
    $('#pairs-empty').hidden = s.pairs.length > 0;
    $('#pairs').replaceChildren(...s.pairs.slice(0, TOP_PAIRS).map((p) => {
      const names = el('div', 'pair-names');
      names.append(el('div', 'mono', p.picked), el('div', 'mono pair-to', `\u2192 ${p.served}`));
      const meta = el('div', 'pair-meta');
      meta.append(el('div', 'pair-n', `\u00d7${fmtInt(p.n)}`), el('div', 'muted', ago(p.last)));
      const li = el('li', 'pair');
      li.append(warnIcon(), names, meta);
      return li;
    }));
  }

  function renderRecent(s) {
    $('#recent-section').hidden = s.recent.length === 0;
    $('#recent').replaceChildren(...s.recent.map((r) => {
      const link = el('a', null, 'Open');
      link.href = `https://chatgpt.com/c/${r.chatId}`;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.title = `Picked ${r.picked}, got ${r.served}`;
      const li = el('li', 'recent');
      li.append(el('span', 'when', ago(r.at)), el('span', 'mono', r.served), link);
      return li;
    }));
  }

  function renderTiming(s) {
    $('#timing-empty').hidden = s.timing.length > 0;
    $('#timing').hidden = s.timing.length === 0;
    $('#timing tbody').replaceChildren(...s.timing.map((t) => {
      const tr = el('tr');
      tr.append(
        el('td', 'mono', t.model),
        el('td', 'num', fmtSec(t.sum / t.n)),
        el('td', 'num', fmtSec(t.min)),
        el('td', 'num', fmtInt(t.n)),
      );
      return tr;
    }));
  }

  // ---- tooltip for the bars: value first, detail second -------------------------------------

  const tip = $('#tip');
  function showTip(row) {
    const [value, detail] = JSON.parse(row.dataset.tip);
    tip.replaceChildren(el('strong', null, value), el('span', null, detail));
    tip.hidden = false;
    const r = row.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + 6))}px`;
    tip.style.top = `${r.top - t.height - 4 >= 4 ? r.top - t.height - 4 : r.bottom + 4}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  for (const [on, off] of [['pointerover', 'pointerout'], ['focusin', 'focusout']]) {
    document.addEventListener(on, (e) => {
      const row = e.target.closest?.('.bar-row');
      if (row) showTip(row);
    });
    document.addEventListener(off, (e) => {
      const row = e.target.closest?.('.bar-row');
      if (row && !row.contains(e.relatedTarget)) hideTip();
    });
  }

  // ---- controls ------------------------------------------------------------------------------

  $('.range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    range = b.dataset.range;
    try { localStorage.setItem('receipts.range', range); } catch {}
    render();
  });

  // Two clicks to erase, so a stray click can't wipe history.
  let armed = 0;
  const resetBtn = $('#reset');
  function disarm() {
    clearTimeout(armed);
    armed = 0;
    resetBtn.textContent = 'Reset data';
    resetBtn.classList.remove('is-armed');
  }
  resetBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = setTimeout(disarm, 3000);
      resetBtn.textContent = 'Click again to erase';
      resetBtn.classList.add('is-armed');
      return;
    }
    disarm();
    await chrome.storage.local.clear();
    await load();
  });

  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;

  // Replies that land while the popup is open show up live.
  let reloadTimer = 0;
  chrome.storage.onChanged.addListener(() => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 300);
  });

  load();
})();
