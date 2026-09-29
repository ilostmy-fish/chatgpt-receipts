// How a saved record is read. Shared by content.js (badges) and popup.js (stats) so both always
// agree on what "rerouted" means.
(() => {
  const firstKey = (obj, re) => Object.keys(obj).find((k) => re.test(k));

  // Picked: the model your browser sent, if the extension saw the send; otherwise
  // default_model_slug, the picker's model when the message went out. Served: resolved_model_slug.
  // requested_model_slug and model_slug are router hops in between (e.g. picked gpt-5-6-thinking,
  // requested gpt-5-4-auto-thinking, model_slug gpt-5-4-thinking); they stay in the tooltip.
  function classify(rec, domSlug) {
    const m = rec?.meta || {};
    const s = rec?.stream || {};
    const r = rec?.request || {};
    const slug = (key) => m[key] ?? s[key];
    const picked = r.model ?? slug('default_model_slug') ?? slug('model_slug') ?? null;
    const served = slug('resolved_model_slug') ?? slug('model_slug') ?? domSlug ?? null;
    // Choosing Auto means any model is fair game.
    const pickedAuto = /(^|-)auto($|-)/.test(picked ?? '');
    return {
      picked,
      pickedAuto,
      served,
      rerouted: Boolean(served && picked && !pickedAuto && picked !== served),
      effort: r[firstKey(r, /effort|thinking|reasoning/i)] ?? m[firstKey(m, /effort/i)] ?? null,
      fromNetwork: Boolean(slug('resolved_model_slug') ?? slug('model_slug')),
    };
  }

  // Replies worth counting: visible text answers, not thinking traces or hidden system messages.
  const isReply = (rec) => (rec.contentType ?? 'text') === 'text' && !rec.hidden;

  globalThis.Receipts = { classify, isReply };
})();
