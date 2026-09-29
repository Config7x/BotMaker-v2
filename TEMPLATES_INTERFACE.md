# BotMaker v2 Template Worker Contract & Interface Specification

This document defines the execution contract and interface specification for Telegram bot templates in `botmaker-v2`.

## 1. Overview

Every bot template in `botmaker-v2` is implemented as a modular update handler module that adheres to a standardized, stateless/event-driven interface.

Instead of running dedicated long-polling/webhook loops inside individual template files, template modules export a single `handle` function (or an object containing `metadata` and a `handle` function). The runner or worker invokes `handle` for each incoming Telegram update.

---

## 2. The `handle` Signature

```javascript
async function handle({ update, bot, api, db }) {
  // Process update and invoke api calls
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `update` | `Object` | The raw Telegram Update object (e.g. `{ update_id, message, callback_query, ... }`). |
| `bot` | `Object` | Information about the current bot instance (e.g. `{ id, name, owner_id, token, config }`). |
| `api` | `Object` | API wrapper providing async methods for Telegram Bot API calls. |
| `db` | `Object` | Database wrapper providing key-value and document persistence operations per bot. |

---

## 3. The `api` Wrapper Specification

The `api` object encapsulates all interactions with the Telegram Bot API. During production execution, `api` routes calls to Telegram HTTP API endpoints. During unit testing, `api` is mocked to verify calls without making actual network requests.

### Supported Methods:

- `sendMessage(chatId, text, options)`
- `sendPhoto(chatId, photo, options)`
- `sendDocument(chatId, document, options)`
- `sendPoll(chatId, question, options, extraOptions)`
- `answerCallbackQuery(callbackQueryId, options)`
- `editMessageText(chatId, messageId, text, options)`
- `pinChatMessage(chatId, messageId, options)`
- `getChatMember(chatId, userId)`
- `copyMessage(chatId, fromChatId, messageId, options)`
- `forwardMessage(chatId, fromChatId, messageId, options)`

---

## 4. The `db` Persistence Wrapper Specification

Each template receives a `db` instance scoped to the active `bot.id`.

### Supported Methods:

- `async get(key)`: Retrieves a value by string key.
- `async set(key, value)`: Stores a value by string key.
- `async delete(key)`: Deletes a key.
- `async find(collectionName, filter)`: Returns an array of items matching `filter` in a collection.
- `async save(collectionName, item)`: Inserts or updates an item in a named collection.

---

## 5. Security & HTML Sanitization Guidelines

To prevent HTML Injection in Telegram messages formatted with `parse_mode: 'HTML'`:

1. All dynamic user-supplied strings (such as usernames, messages, file names, product descriptions) **MUST** be sanitized before insertion into HTML strings.
2. Use the provided `escapeHtml` utility from `src/utils/html.js`:
   ```javascript
   const { escapeHtml } = require('../../utils/html');
   const safeText = escapeHtml(userInput);
   ```
3. Character Escaping mapping:
   - `&` -> `&amp;`
   - `<` -> `&lt;`
   - `>` -> `&gt;`
   - `"` -> `&quot;`
   - `'` -> `&#39;`

---

## 6. Template Standards & Limitations Policy

Templates must accurately represent capabilities and state explicit limitations to users:

1. **`shop`**: Catalog browsing and order request submission without embedded payment gateways.
2. **`uploader`**: File uploads within Telegram Bot API limits (20MB downloads / 50MB file references). Explicitly state no unlimited cloud storage guarantee.
3. **`post_composer`**: Post layout preview and publication with inline buttons. Explicitly state inline button colors are achieved strictly via emoji indicators (🔴 🟢 🔵 🟡 ⚪) due to Telegram API limits. Require channel admin verification before publishing.
4. **`channel_manager`**: Focused channel command suite (post, pin, info). Explicitly state non-claim of full channel admin capabilities (e.g. member bans, permissions management).
5. **`quiz`**: Quiz entertainment with questions, option choices, score tracking, and leaderboards.
6. **`downloader`**: HTTPS direct link small file downloads (<20MB) with strict SSRF protection against private IP ranges. Explicitly disclaim universal video/site scraping abilities.

---

## 7. Template Discovery (`src/webhook.js` + `src/templateManager.js`)

Templates are discovered dynamically — there is no static registry file:

1. Each built-in template lives in its own directory `src/templates/<id>/` with an `index.js` entry that exports `metadata` and `handle` (a legacy flat file `src/templates/<id>.js` or `src/templates/<id>/<id>.js` is also accepted by the webhook loader).
2. Admin-installed ZIP templates are extracted by `src/templateManager.js` to a directory outside `src/templates`, registered in the `custom_templates` table (`source_dir`, `enabled`), and loaded from there.
3. The webhook dispatcher (`loadTemplateModule`) resolves a template id to its module at dispatch time; unknown or disabled ids are rejected.

Containerized templates (#10 VPN Shop, #11 Config Auto-Scraper) are the exception: they never run in-process. `src/containerTemplates.js` registers their wizard metadata, but updates to those bots are skipped by the platform webhook (`{ skipped: 'containerized' }`) because each instance runs in its own Docker container.
