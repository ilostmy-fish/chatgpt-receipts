// Runs in the page's MAIN world at document_start so it wraps fetch before ChatGPT's code grabs it.
// It tees conversation responses (SSE streams and JSON), pulls model metadata out of every message
// it sees, and hands the results to content.js via window.postMessage. The page's own copy of the
// response is untouched.
(() => {
  if (window.__cmbInstalled) return;
  window.__cmbInstalled = true;

  const TAG = '__chatgpt_model_badge__';
  const SLUG_KEYS = ['model_slug', 'resolved_model_slug', 'default_model_slug'];
  // Metadata keys worth keeping. Broad on purpose so new routing fields show up in the tooltip.
  const INTERESTING = /slug|model|effort|thinking|reasoning|routing|router|finished_duration/i;
  const FLUSH_MS = 250;

  const debug = (() => {
    try { return localStorage.getItem('cmbDebug') === '1'; } catch { return false; }
  })();

  const isPrim = (v) => ['string', 'number', 'boolean'].includes(typeof v);
  const isObj = (v) => v !== null && typeof v === 'object';
  const hasSlugKey = (o) => isObj(o) && SLUG_KEYS.some((k) => k in o);
  const roleOf = (o) => (isObj(o.author) ? o.author.role : o.role);
  // Loose on purpose: the history endpoint's shape keeps changing. Anything with an id plus either
  // an author/role or a metadata block carrying a model slug counts as a message.
  const isMessage = (o) =>
    typeof o.id === 'string' &&
    ((roleOf(o) != null && ('content' in o || isObj(o.metadata))) || hasSlugKey(o.metadata));
  const isAssistant = (o) => {
    const role = roleOf(o);
    return role === 'assistant' || (role == null && hasSlugKey(o.metadata));
  };

  // Always-on ring buffer of what was inspected, for diagnosing from the devtools console:
  //   window.__cmbLog
  const LOG_MAX = 100;
  const log = (window.__cmbLog = []);
  function logEntry(entry) {
    log.push(entry);
    if (log.length > LOG_MAX) log.shift();
    return entry;
  }

  function pick(obj) {
    const out = {};
    if (!isObj(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (isPrim(v) && INTERESTING.test(k)) out[k] = v;
    }
    return out;
  }

  function post(updates) {
    if (!updates.length) return;
    window.postMessage({ [TAG]: true, updates }, location.origin);
    if (debug) console.debug('[model-badge]', updates);
  }

  // Collects per-message metadata from one response. Walks every JSON payload generically so it
  // survives format changes: full-message events, delta-encoded patches ({p, o, v}), batched
  // patches, and stream-level objects like server_ste_metadata.
  class Collector {
    constructor({ isStream, request, conversationId, entry }) {
      this.isStream = isStream;
      this.request = request || null;
      this.conversationId = conversationId || null;
      this.entry = entry || null;
      this.assistantIds = new Set();
      // Batch responses hold several chats, so each message keeps the chat it was found under.
      this.msgConv = new Map();
      this.currentMsgId = null;
      this.streamMeta = {};
      this.pending = new Map();
      this.stats = { messages: 0, assistant: 0, slugObjects: 0 };
    }

    add(id, patch) {
      if (!this.assistantIds.has(id)) return;
      const u = this.pending.get(id) || { id };
      for (const [k, v] of Object.entries(patch)) {
        u[k] = isObj(v) ? { ...(u[k] || {}), ...v } : v;
      }
      this.pending.set(id, u);
    }

    walk(node, owner) {
      if (!isObj(node)) return;
      if (Array.isArray(node)) {
        for (const n of node) this.walk(n, owner);
        return;
      }

      // New chats have no id in the URL until the first reply lands, so take it from the payload.
      if (typeof node.conversation_id === 'string') this.conversationId = node.conversation_id;

      if (isMessage(node)) {
        this.stats.messages++;
        this.currentMsgId = node.id;
        if (this.conversationId && !this.msgConv.has(node.id)) this.msgConv.set(node.id, this.conversationId);
        if (isAssistant(node)) {
          this.stats.assistant++;
          this.assistantIds.add(node.id);
        }
        const t = node.create_time;
        this.add(node.id, {
          contentType: node.content?.content_type,
          // For the popup's time ranges; ChatGPT sends epoch seconds.
          createdAt: typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) / 1000 || undefined : undefined,
          // Hidden helper messages (e.g. upsells) carry model slugs too; keep them out of stats.
          hidden: isObj(node.metadata) ? node.metadata.is_visually_hidden_from_conversation === true : undefined,
          meta: pick(node.metadata),
        });
        return;
      }

      // Delta-encoded patch against the message currently streaming.
      if (typeof node.p === 'string' && 'o' in node && node.p.startsWith('/message')) {
        owner = this.currentMsgId;
        const key = node.p.match(/^\/message\/metadata\/([^/]+)$/)?.[1];
        if (owner && key && isPrim(node.v) && INTERESTING.test(key)) {
          this.add(owner, { meta: { [key]: node.v } });
        } else if (owner && node.p === '/message/metadata' && isObj(node.v)) {
          this.add(owner, { meta: pick(node.v) });
        }
      }

      if (hasSlugKey(node)) {
        this.stats.slugObjects++;
        if (owner) this.add(owner, { meta: pick(node) });
        else if (this.isStream) Object.assign(this.streamMeta, pick(node));
      }

      for (const k in node) {
        if (isObj(node[k])) this.walk(node[k], owner);
      }
    }

    flush(extra) {
      if (this.isStream) {
        for (const id of this.assistantIds) {
          const patch = { stream: this.streamMeta };
          if (this.request) patch.request = this.request;
          if (extra) Object.assign(patch, extra);
          this.add(id, patch);
        }
      }
      for (const u of this.pending.values()) {
        u.conversationId = this.msgConv.get(u.id) || this.conversationId;
      }
      post([...this.pending.values()]);
      this.pending.clear();
      if (this.entry) {
        this.entry.assistantIds = [...this.assistantIds].slice(-20);
        this.entry.conversations = [...new Set(this.msgConv.values())];
      }
    }
  }

  function parseBody(init) {
    if (typeof init?.body !== 'string') return null;
    try { return JSON.parse(init.body); } catch { return null; }
  }

  function pickRequest(body) {
    if (!isObj(body)) return null;
    const req = {};
    if (typeof body.model === 'string') req.model = body.model;
    for (const [k, v] of Object.entries(body)) {
      if (isPrim(v) && /effort|thinking|reasoning/i.test(k)) req[k] = v;
    }
    return Object.keys(req).length ? req : null;
  }

  function handleEventBlock(block, collector) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    collector.walk(obj, null);
  }

  async function readStream(res, collector, startedAt) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastFlush = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          handleEventBlock(buf.slice(0, idx), collector);
          buf = buf.slice(idx + 2);
        }
        const now = performance.now();
        if (now - lastFlush > FLUSH_MS) {
          collector.flush();
          lastFlush = now;
        }
      }
      buf += decoder.decode();
      if (buf.trim()) handleEventBlock(buf, collector);
    } catch (e) {
      // Aborted (user hit stop, navigated away). Keep whatever was collected.
      if (debug) console.debug('[model-badge] stream ended early', e);
    } finally {
      collector.flush({ elapsedMs: Math.round(performance.now() - startedAt) });
    }
  }

  function inspect(input, init, res, startedAt) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!url.includes('/backend-api/')) return;
    const ct = res.headers.get('content-type') || '';
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const entry = logEntry({ path, status: res.status, type: ct.split(';')[0], handled: false });
    if (!res.ok || !res.body) return;

    const body = parseBody(init);
    // Matches both /conversation/<id> and the newer /conversations/<id>?num_turns=...
    const conversationId =
      url.match(/\/conversations?\/([0-9a-f-]{36})/i)?.[1] ||
      (typeof body?.conversation_id === 'string' ? body.conversation_id : null);

    if (ct.includes('text/event-stream')) {
      const collector = new Collector({ isStream: true, request: pickRequest(body), conversationId, entry });
      Object.assign(entry, { handled: 'sse', stats: collector.stats });
      readStream(res.clone(), collector, startedAt);
    } else if (ct.includes('json') && url.includes('conversation')) {
      const collector = new Collector({ isStream: false, conversationId, entry });
      Object.assign(entry, { handled: 'json', stats: collector.stats });
      res.clone().json().then((json) => {
        collector.walk(json, null);
        collector.flush();
      }).catch((e) => { entry.error = String(e); });
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const startedAt = performance.now();
    const res = await origFetch.call(window, input, init);
    try {
      inspect(input, init, res, startedAt);
    } catch (e) {
      if (debug) console.warn('[model-badge] inspect failed', e);
    }
    return res;
  };
})();
