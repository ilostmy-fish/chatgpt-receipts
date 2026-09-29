# Receipts

Firefox extension that shows which model actually answered each ChatGPT reply, and flags it when you
get rerouted to a different model than the one you picked. It reads the model slugs from the
conversation traffic the page already receives and puts a badge in each reply's action bar.
Clicking the toolbar icon opens a stats popup.

## Install

Requires **Firefox 128 or newer**. Firefox 128 added support for running a manifest content script in the page's `MAIN` world, which Receipts needs to wrap ChatGPT's `window.fetch` before the app captures it.

### Temporary install for development

1. Clone this fork and check out the Firefox branch:
   ```sh
   git clone https://github.com/ilostmy-fish/chatgpt-receipts.git
   cd chatgpt-receipts
   git checkout firefox
   ```
2. In Firefox, open `about:debugging`.
3. Click **This Firefox**.
4. Click **Load Temporary Add-on...** and select `manifest.json` from this folder.
5. Reload any open `chatgpt.com` tabs.

The temporary add-on is removed when Firefox restarts. After editing the extension, use **Reload** on its card in `about:debugging`.

### Validate and package

Mozilla's `web-ext` tool can lint, run, and package the extension:

```sh
web-ext lint
web-ext run
web-ext build
```

A built package must be signed by Mozilla for normal installation in release Firefox. The manifest includes a stable Gecko extension ID for signing and declares that the extension does not transmit collected data outside the local browser.

## Reading the badge

`gpt-5-4-auto-thinking · rerouted from gpt-5-6-thinking · effort extended · 2.1s`

A message's metadata can carry four slugs. Seen in the wild:

| field                  | example                 | meaning                                  |
| ---------------------- | ----------------------- | ---------------------------------------- |
| `default_model_slug`   | `gpt-5-6-thinking`      | model selected in the picker             |
| `requested_model_slug` | `gpt-5-4-auto-thinking` | what the router asked for                |
| `model_slug`           | `gpt-5-4-thinking`      | intermediate hop                         |
| `resolved_model_slug`  | `gpt-5-4-auto-thinking` | what actually answered                   |

- **First item**: what answered (`resolved_model_slug`, else `model_slug`).
- **rerouted from**: what you picked, when it differs from what answered. "Picked" is the model
  your browser sent if the extension saw the send, else `default_model_slug`, else `model_slug`.
  Never shown when you picked an Auto model.
- **effort**: the effort/thinking setting from your request, else from the metadata.
- **Time**: total time from send to end of stream.
- **Amber badge**: rerouted.
- **from page attr**: no network data yet; fell back to the page's `data-message-model-slug`.

The sent model and time only exist for turns sent while the extension was running.

Hover for every captured metadata field. Click to copy the raw record as JSON.

## Stats popup

Click the toolbar icon. Everything is scoped by the time range at the top (24h / 7 days / 30 days
/ All):

- **Replies**, **Rerouted**, and **Reroute rate**. The rate only counts replies where you picked a
  specific model, since Auto can't be rerouted.
- **Answered by**: replies per model that actually answered. Hover a bar for its share.
- **Reroutes**: each picked → served pair, how often, and when it last happened.
- **Latest reroutes**: with a link to open that chat.
- **Response time**: average and fastest per model, for replies sent while the extension was running.

Only visible text replies count. Thinking traces and hidden helper messages are left out.
**Reset data** (click twice) erases everything the extension has stored.

## How it works

- `inject.js` runs in the page context at `document_start` and wraps `window.fetch`. For
  `/backend-api/` responses it tees the body: SSE streams (sending a message) and conversation JSON
  (opening a chat). It walks every payload generically, so it handles the full-message format, the
  delta-encoded `{p, o, v}` patch format, and stream-level metadata events.
- `content.js` receives the data and saves it per chat in `browser.storage.local`, one entry per
  conversation id (`chat:<id>`, the uuid after `/c/` in the URL). Opening a chat loads its entry,
  so every turn keeps its badge across reloads and browser restarts. The chat id comes from the
  network payload first, since a brand-new chat has no id in the URL until the first reply lands.
  Storage is uncapped (`unlimitedStorage`) and is wiped only if you remove the extension or hit
  Reset data.
- `shared.js` holds the picked/served/rerouted rule, used by both the badges and the popup.
- `popup.html` / `popup.js` / `popup.css`: the stats popup, computed from the same storage.
- `icons/icon.svg` (48/128px) and `icons/icon-small.svg` (16/32px, simplified) are the icon
  sources; the PNGs are rendered from them.

## Debugging

If badges don't appear, open a chat, open devtools (F12) → Console, and run this. It copies a
report to the clipboard: whether the extension loaded, every `/backend-api/` response it saw with
how many messages it found in each, and which `data-*` attributes the chat DOM uses. No message
text is included. (DevTools may ask you to type `allow pasting` first.)

```js
copy(JSON.stringify({
  injected: !!window.__cmbInstalled,
  log: window.__cmbLog,
  assistantNodes: document.querySelectorAll('[data-message-author-role="assistant"]').length,
  withId: document.querySelectorAll('[data-message-author-role="assistant"][data-message-id]').length,
  badges: document.querySelectorAll('.cmb-badge').length,
  dataAttrs: [...new Set([...document.querySelectorAll('main *')].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => n.startsWith('data-')))],
}, null, 2))
```

For a live feed of every captured update, run `localStorage.cmbDebug = '1'` and reload; updates are
logged as `[model-badge]`. Remove the key to turn it off.

## License

MIT. See [LICENSE](LICENSE).
