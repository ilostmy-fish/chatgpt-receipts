// Isolated-world content script: receives model metadata from inject.js, saves it per chat, and
// renders a badge under each assistant message.
(() => {
  const TAG = '__chatgpt_model_badge__';
  const CHAT_PREFIX = 'chat:';
  const RENDER_THROTTLE_MS = 150;
  const SAVE_DEBOUNCE_MS = 1000;
  const CHAT_ID_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Every record we know about, by message id. A record that belongs to a chat is the same object
  // held in that chat's `messages`, so updating one updates the other.
  const records = new Map();
  // chat id -> Promise<{ id, updatedAt, messages: { [messageId]: record } }>
  const chats = new Map();
  const dirtyChats = new Set();

  const chatIdFromUrl = () => location.pathname.match(CHAT_ID_RE)?.[1] ?? null;

  function mergeInto(target, src) {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      target[k] = v && typeof v === 'object' ? { ...(target[k] || {}), ...v } : v;
    }
    return target;
  }

  // ---- persistence -------------------------------------------------------------------------
  // One browser.storage.local entry per chat ("chat:<conversation id>"). Opening a chat loads its
  // entry, so every turn gets its badge even if ChatGPT's history payload leaves the metadata out.
  // The requested model and response time only exist at send time; this is the only copy of them.

  function loadChat(chatId) {
    if (!chats.has(chatId)) {
      const key = CHAT_PREFIX + chatId;
      chats.set(chatId, browser.storage.local.get(key).then((got) => {
        const chat = got[key] || { id: chatId, updatedAt: 0, messages: {} };
        for (const [msgId, saved] of Object.entries(chat.messages)) {
          // Anything that reached memory before its chat was known wins over the saved copy.
          const live = records.get(msgId);
          const rec = live ? mergeInto(saved, live) : saved;
          chat.messages[msgId] = rec;
          records.set(msgId, rec);
        }
        scheduleRender();
        return chat;
      }));
    }
    return chats.get(chatId);
  }

  let saveTimer = 0;
  async function saveNow() {
    clearTimeout(saveTimer);
    const ids = [...dirtyChats];
    dirtyChats.clear();
    if (!ids.length) return;
    const batch = {};
    for (const id of ids) batch[CHAT_PREFIX + id] = await chats.get(id);
    browser.storage.local.set(batch);
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }
  window.addEventListener('pagehide', saveNow);

  async function applyUpdates(updates) {
    for (const { conversationId, ...u } of updates) {
      const chatId = conversationId || chatIdFromUrl();
      const chat = chatId ? await loadChat(chatId) : null;

      let rec = records.get(u.id);
      if (!rec) {
        rec = { id: u.id };
        records.set(u.id, rec);
      }
      mergeInto(rec, u);
      rec.updatedAt = Date.now();

      if (chat) {
        chat.messages[u.id] = rec;
        chat.updatedAt = rec.updatedAt;
        dirtyChats.add(chatId);
      }
    }
    scheduleSave();
    scheduleRender();
  }

  // Serialize batches so updates to one message always apply in arrival order.
  let queue = Promise.resolve();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== true) return;
    const { updates } = e.data;
    queue = queue.then(() => applyUpdates(updates)).catch((err) => console.warn('[model-badge]', err));
  });

  // ---- rendering ---------------------------------------------------------------------------

  function describe(rec, domSlug) {
    const m = rec?.meta || {};
    const s = rec?.stream || {};
    const r = rec?.request || {};
    const { picked, served, rerouted, effort, fromNetwork } = Receipts.classify(rec, domSlug);
    if (!served) return null;

    const parts = [{ text: served, cls: 'cmb-model' }];
    if (rerouted) parts.push({ text: `rerouted from ${picked}` });
    if (effort != null) parts.push({ text: `effort ${effort}` });
    if (rec?.elapsedMs != null) parts.push({ text: `${(rec.elapsedMs / 1000).toFixed(1)}s` });
    if (!fromNetwork) parts.push({ text: 'from page attr', cls: 'cmb-dim' });

    const tooltip = [];
    for (const [label, obj] of [['meta', m], ['stream', s], ['request', r]]) {
      for (const [k, v] of Object.entries(obj)) tooltip.push(`${label}.${k} = ${v}`);
    }
    if (domSlug) tooltip.push(`page data-message-model-slug = ${domSlug}`);
    tooltip.push('', 'Click to copy raw record');

    return {
      parts,
      warn: rerouted,
      title: tooltip.join('\n'),
      sig: JSON.stringify([parts, rerouted, tooltip]),
    };
  }

  function fill(badge, view) {
    badge.replaceChildren();
    view.parts.forEach((p, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'cmb-sep';
        sep.textContent = '\u00b7';
        badge.append(sep);
      }
      const span = document.createElement('span');
      if (p.cls) span.className = p.cls;
      span.textContent = p.text;
      badge.append(span);
    });
    badge.classList.toggle('cmb-warn', view.warn);
    badge.title = view.title;
  }

  // ChatGPT has shipped two layouts. Old: the message element carries data-message-author-role and
  // data-message-id. New: each reply sits in a unit whose data-chatgpt-search-unit-key ends in
  // ":assistant", and its content div carries data-chatgpt-selection-message-id.
  const idOf = (el) =>
    el?.getAttribute('data-message-id') ?? el?.getAttribute('data-chatgpt-selection-message-id');

  function assistantTargets() {
    const out = [];
    for (const el of document.querySelectorAll('[data-message-author-role="assistant"][data-message-id]')) {
      out.push(el);
    }
    for (const el of document.querySelectorAll('[data-chatgpt-selection-message-id]')) {
      const unit = el.closest('[data-chatgpt-search-unit-key]');
      const role =
        unit?.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role') ??
        unit?.getAttribute('data-chatgpt-search-unit-key')?.split(':').pop();
      if (role === 'assistant') out.push(el);
    }
    return out;
  }

  // The reply's action bar (copy / rate / share / regenerate / more). Accounts get different
  // layouts: the redesign marks the bar with .turn-action-controls; the classic one uses a
  // role="group" row holding button[data-testid="copy-turn-action-button"]. In the redesign the
  // turn also holds the user's message and its own bar, which comes before the reply, so take the
  // first bar after the reply. While a reply is still streaming it has no bar yet.
  const TURN_SEL = '[data-content-search-turn-key], [data-turn-key], [data-turn-id-container], article';
  const BAR_SEL = '.turn-action-controls, button[data-testid="copy-turn-action-button"]';

  function actionRowFor(el) {
    const turn = el.closest(TURN_SEL);
    if (!turn) return null;
    const hit = [...turn.querySelectorAll(BAR_SEL)].find(
      (n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(n),
    );
    if (!hit) return null;
    const bar = hit.matches('button') ? hit.closest('[role="group"]') ?? hit.parentElement : hit;
    const buttons = bar.querySelectorAll('button');
    return buttons.length ? buttons[buttons.length - 1].parentElement : bar;
  }

  // Inline after the last action button when the bar exists, otherwise directly under the reply.
  function place(badge, el) {
    const row = actionRowFor(el);
    const placed = row ? badge.parentElement === row : badge.previousElementSibling === el;
    if (!placed) {
      if (row) row.append(badge);
      else el.after(badge);
    }
    badge.classList.toggle('cmb-inline', Boolean(row));
  }

  function render() {
    // ChatGPT is a single-page app: switching chats changes the URL without a reload.
    const urlChat = chatIdFromUrl();
    if (urlChat) loadChat(urlChat);

    const keep = new Set();
    for (const el of assistantTargets()) {
      const id = idOf(el);
      const view = describe(records.get(id), el.getAttribute('data-message-model-slug'));
      if (!view) continue;

      let badge = document.querySelector(`.cmb-badge[data-for="${CSS.escape(id)}"]`);
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'cmb-badge';
        badge.dataset.for = id;
      }
      place(badge, el);
      keep.add(badge);
      if (badge.dataset.sig !== view.sig) {
        fill(badge, view);
        badge.dataset.sig = view.sig;
      }
    }

    // Drop badges whose reply React replaced or removed.
    for (const b of document.querySelectorAll('.cmb-badge')) {
      if (!keep.has(b)) b.remove();
    }
  }

  let renderTimer = 0;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, RENDER_THROTTLE_MS);
  }

  document.addEventListener('click', (e) => {
    const badge = e.target.closest?.('.cmb-badge');
    if (!badge) return;
    const rec = records.get(badge.dataset.for);
    navigator.clipboard.writeText(JSON.stringify(rec ?? { id: badge.dataset.for }, null, 2));
    badge.classList.add('cmb-copied');
    setTimeout(() => badge.classList.remove('cmb-copied'), 600);
  });

  function start() {
    new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true });
    scheduleRender();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
