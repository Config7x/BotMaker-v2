# BotMaker-v2 Security Architecture & Review

**Target System:** BotMaker v2 Multi-Tenant Telegram Bot Management System  
**Document Owner:** Security & Infrastructure Architecture  
**Scope:** Security review of legacy v1 (`botmaker/`), architectural risk assessment for v2 (`botmaker-v2`), acceptance criteria, webhook vs polling analysis, untrusted code isolation, secret handling, and test plans (offline tokenless & VPS).

---

## 1. Legacy v1 (`botmaker/`) Vulnerability & Architectural Analysis

An independent inspection of the existing v1 codebase (`botmaker/src/`) revealed critical security vulnerabilities, operational bottlenecks, and design risks:

### 1.1 Insecure Untrusted Code Execution & Pre-Approval Dependencies
* **Immediate Host Code Execution during Upload (`handleCustomZip` in `src/index.js`):**
  When a user uploads a `.zip` file containing custom bot code, `index.js` executes `npm install --omit=dev` directly on the host workspace before administrator review or containerization. Any npm package with lifecycle scripts (`preinstall`, `install`, `postinstall`) in `package.json` executes arbitrary shell commands on the host server with platform privileges at upload time.
* **Flawed Static Source Scanning (`scanSource`):**
  The static analysis regex scan attempts to filter patterns such as `child_process`, `exec`, `eval`, or `net.Socket`. This is trivially bypassed using basic JS obfuscation, dynamic imports/eval (`Function("return process")()`), string concatenation, base64 encoding, WASM binaries, or disguised native C++ modules.
* **Zip Slip / Path Traversal Flaw:**
  Zip archive extraction is invoked via `execSync('unzip -q -o ...')` without path traversal sanitization. Malicious zip entries containing relative paths (`../`) can overwrite critical platform files outside the target directory.

### 1.2 Container & Isolation Fallback Weaknesses (`src/runner.js`)
* **Unsafe Host Execution Fallback:**
  When `dockerAvailable` is false, `runner.js` executes custom untrusted user code directly on the host using `spawn('node', [entry])`.
* **Weak Docker Container Hardening:**
  Even when Docker is enabled, the execution command uses `--network bridge` with a read-write host mount (`-v ${bot.dir}:/app:rw`) and defaults to the container `root` user. The container has direct egress network access to local host ports (e.g. 127.0.0.1, internal metadata services) and lacks privilege restrictions (`cap-drop=ALL`, `no-new-privileges`, read-only rootfs).

### 1.3 Polling Concurrency & Event Loop Collisions (`src/index.js` & Templates)
* **Overlapping Polling Loops:**
  `setInterval(loop, 500)` calls `getUpdates` with `timeout: 30`. Because `setInterval` triggers every 500ms without awaiting the completion of the 30-second long poll, hundreds of concurrent HTTPS GET requests stack up against Telegram's API for the same token, triggering HTTP 409 Conflict (`409 Conflict: terminated by other getUpdates request`).
* **Unbounded Process Spawning:**
  Every user bot spawns a dedicated Node.js child process (`spawn('node', ...)`). For hundreds of active bots, system memory and OS process limits are rapidly exhausted.

### 1.4 Plaintext Secret Storage & Unmasked Logging (`src/store.js` & `src/telegram.js`)
* **Unencrypted Token Persistence:**
  Bot tokens and sensitive user metadata are stored in plain JSON (`data/db.json`) on disk.
* **Secret Leakage in Console/File Logs:**
  Error output and HTTP request logs dump unmasked Telegram tokens (`/bot<TOKEN>/...`) directly into persistent files (`data/logs/bot_${bot.id}.log`).

---

## 2. Webhook vs Polling Architecture for BotMaker-v2

| Architectural Dimension | Long Polling (v1 Architecture) | Webhook Architecture (Recommended for v2) |
| :--- | :--- | :--- |
| **Connection Overhead** | $N$ persistent outbound HTTPS sockets for $N$ bots; high memory & file descriptor usage. | 0 persistent background outbound sockets; incoming HTTP POST updates handled on demand. |
| **Concurrency & Telegram Conflicts** | High risk of HTTP 409 Conflict errors if multiple process instances or pollers run simultaneously. | Guaranteed single update delivery stream; Telegram serializes update POSTs per bot token. |
| **Inbound Security Requirements** | Requires no inbound public ports or public domain/TLS cert. | Requires public HTTPS endpoint, valid TLS cert, port 443/8443/80/88, and webhook secret validation. |
| **Latency & Responsiveness** | Subject to polling interval delays or long-poll HTTP timeout reconnects. | Real-time immediate push notification upon Telegram event trigger. |
| **Resource Efficiency** | High baseline idle CPU and network socket usage. | Highly scalable; easily routes updates to stateless workers or queue systems. |

### Webhook Recommendation & Hybrid Strategy:
1. **Primary Mode (Public Multi-Tenant SaaS):** Use **Webhooks** as the default mechanism for all public multi-tenant bots. Incoming POST requests arrive at `/api/v2/webhook/:bot_id`, where the header `X-Telegram-Bot-Api-Secret-Token` is verified against the stored secret hash before queuing updates into an internal worker pool.
2. **Fallback / Lab Mode (Polling):** Retain a single sequential long-polling worker loop (using strict `async`/`await` recursion, avoiding `setInterval`) exclusively for local development or lab environments where public HTTPS ingress is unavailable.

---

## 3. Public Release Scope vs Private Lab Infrastructure

To guarantee platform security and operational reliability, feature capabilities must be segregated between the Public SaaS release and Dedicated Lab Infrastructure:

```
+-------------------------------------------------------------------+
|               Public SaaS Multi-Tenant Infrastructure             |
|                                                                   |
|   +-------------------+  +-------------------+  +-------------+   |
|   | Auto-Reply Bot    |  | Support Desk Bot  |  | Form / Store|   |
|   | (Platform Code)   |  | (Platform Code)   |  | Templates   |   |
|   +-------------------+  +-------------------+  +-------------+   |
|            |                      |                    |          |
|            +----------------------+--------------------+          |
|                                   |                               |
|            Strictly Standard Parameterized Templates              |
|            (No Arbitrary User Code / No Custom ZIPs)              |
+-------------------------------------------------------------------+
                                    |
                    DEFERRED / ISOLATED SEPARATION
                                    |
                                    v
+-------------------------------------------------------------------+
|               Dedicated Private Lab / MicroVM Host                |
|                                                                   |
|   +-----------------------------------------------------------+   |
|   | Custom User ZIP / Code Upload Execution                   |   |
|   | - Isolated Firecracker MicroVMs or gVisor Sandboxes       |   |
|   | - Isolated Egress VPC Subnets & Disk Quotas               |   |
|   | - Strict Air-Gapped / Isolated Host Environment           |   |
|   +-----------------------------------------------------------+   |
+-------------------------------------------------------------------+
```

### 3.1 Public Release Scope (Multi-Tenant SaaS)
* **Permitted Capabilities:**
  * Pre-built, platform-maintained standard templates (Auto-reply, Support Desk, E-commerce Catalog, Broadcast Manager, Form Collector).
  * No user-uploaded zip files or executable code permitted.
  * Webhook-based event router targeting shared worker runtimes with parameterized JSON configuration.
  * Encrypted secret storage in SQLite database (`better-sqlite3`).

### 3.2 Explicitly Deferred Capabilities (Requires Dedicated Lab Infrastructure)
* **Custom User ZIP Code Uploads & Execution:**
  * **Status:** **DEFERRED** from public multi-tenant SaaS.
  * **Requirement:** Must be restricted to dedicated isolated private lab infrastructure.
  * **Justification:** Executing untrusted Node/Python dependencies uploaded by arbitrary public users presents unacceptable risks of kernel exploits, local network scanning, container escape, supply-chain package compromise (`npm preinstall`), and resource exhaustion. Standard Docker bridge containers are insufficient protection against determined multi-tenant sandbox evasion; hardware-assisted virtualization (e.g., Firecracker MicroVMs, gVisor, or AWS Fargate with dedicated network isolation) is required.

---

## 4. Telegram API Constraints & Security Protocol Rules

1. **Rate Limiting & Throttling Rules:**
   * Global Bot API limit: Max 30 messages/second across all chats per bot token.
   * Single Chat limit: Max 1 message/second per chat.
   * Group Chat limit: Max 20 messages/minute in group chats.
   * Bulk Notifications / Broadcasts: Must implement token-bucket or leaky-bucket rate limiters with delay insertion (minimum 35ms between messages) to avoid HTTP 429 (`Too Many Requests: retry after X`).
2. **Webhook Security Protocols:**
   * Setting Webhooks must specify `secret_token` (1 to 256 characters using `A-Z, a-z, 0-9, _, -`).
   * Platform must reject any incoming POST request where `X-Telegram-Bot-Api-Secret-Token` header does not match the generated secret token.
   * `allowed_updates` array must be specified explicitly (e.g. `["message", "callback_query"]`) to prevent processing unnecessary Telegram payload types.
3. **Token Invalidation Handling:**
   * Upon receiving HTTP `401 Unauthorized` or `403 Forbidden` (bot blocked by user or revoked token), the runner must immediately set the bot status to `unauthorized`/`revoked` and cease further API calls to avoid IP throttling by Telegram.

---

## 5. Untrusted Code Isolation & Secret Handling (v2 Architecture)

### 5.1 Secret Management & Cryptographic Hygiene
* **Encryption at Rest:**
  All Telegram Bot tokens and secret tokens must be encrypted using AES-256-GCM before writing to the database (`better-sqlite3`). Master key derived from environment variable `BOTMAKER_MASTER_KEY`.
* **Log Redaction Pipeline:**
  All stdout/stderr logs and error traces must pass through a strict regex filter removing any string matching Telegram bot token patterns (`/([0-9]{6,12}:[A-Za-z0-9_-]{30,})/g` replaced with `[REDACTED_BOT_TOKEN]`).
* **Zero Host Token Exposure:**
  Tokens passed to template runners must be supplied via in-memory IPC or encrypted environment buffers, never written to disk or logged to files.

### 5.2 Lab Environment Sandbox Hardening (For Custom Code Execution)
If custom code execution is enabled on dedicated lab hardware, the following controls are mandatory:
* **No Pre-Install on Host:** ZIP files must never be extracted or `npm install`ed on the host OS. All unzipping and package installation must occur exclusively inside disposable, ephemeral build containers.
* **gVisor / Firecracker MicroVM Runtime:** Containers must run using gVisor (`runsc`) or Firecracker microVMs to virtualize system calls.
* **Container Security Profile:**
  * `--read-only` root filesystem with minimal temporary `/tmp` tmpfs.
  * `--user 10001:10001` (non-root execution).
  * `--security-opt no-new-privileges:true`.
  * `--cap-drop=ALL`.
  * `--memory 128m --cpus 0.25 --pids-limit 50`.
  * Egress network filtering: Restrict outbound connectivity strictly to `api.telegram.org:443` via firewall/eBPF rules. Deny access to private subnet ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`).

---

## 6. Realistic Acceptance Criteria for BotMaker-v2

### 6.1 Webhook Routing & Security
* [ ] **AC-WH-01:** System must generate a cryptographically random `secret_token` for each bot and configure Telegram via `setWebhook`.
* [ ] **AC-WH-02:** Incoming webhook updates without a valid `X-Telegram-Bot-Api-Secret-Token` header must be immediately rejected with HTTP `403 Forbidden`.
* [ ] **AC-WH-03:** Webhook endpoint must process payloads asynchronously and return HTTP `200 OK` to Telegram within 2,000ms.

### 6.2 Secret Management & Redaction
* [ ] **AC-SEC-01:** Telegram Bot Tokens stored in SQLite (`better-sqlite3`) must be encrypted using AES-256-GCM at rest.
* [ ] **AC-SEC-02:** Log output streams must sanitize and mask all occurrences of Telegram bot tokens.
* [ ] **AC-SEC-03:** No token or secret shall be passed in command-line arguments visible in `ps aux`.

### 6.3 Public Scope & Untrusted Code Guardrails
* [ ] **AC-SCP-01:** Public SaaS interface must restrict bot creation exclusively to standard parameterized templates.
* [ ] **AC-SCP-02:** Custom code zip upload functionality must be disabled by default in public release mode (`PUBLIC_SAAS_MODE=true`).
* [ ] **AC-SCP-03:** Zip extraction modules in lab mode must enforce strict path traversal validation rejecting archives with `..` or absolute paths.

### 6.4 Rate Limiting & Resilience
* [ ] **AC-RES-01:** Outbound Telegram API dispatcher must enforce a global limit of ≤ 30 msg/sec per bot token and handle HTTP 429 responses with exponential backoff.
* [ ] **AC-RES-02:** Bot runtime must cleanly catch HTTP 401/403 errors and update bot status to `unauthorized` without crashing the master process.

---

## 7. Security Test Plan (Tokenless Local Verification)

The following automated test suite validates security controls without requiring a live Telegram API token or network connection.

### 7.1 Automated Offline Test Verification Script (`test-security-v2.js`)

Below is a runnable test script demonstrating token redaction, path traversal protection, webhook secret verification, and token encryption.

```javascript
'use strict';
/**
 * BotMaker-v2 Offline Security & Validation Test Suite
 * Run via: node test-security-v2.js
 */
const crypto = require('crypto');
const path = require('path');
const assert = require('assert');

// 1. Token Masking Helper Test
function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/([0-9]{6,12}:[A-Za-z0-9_-]{30,})/g, '[REDACTED_BOT_TOKEN]');
}

// 2. AES-256-GCM Encryption Helper
const MASTER_KEY = crypto.randomBytes(32);

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptSecret(cipherText) {
  const [ivHex, tagHex, encrypted] = cipherText.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// 3. Zip Path Traversal Guard
function isSafeZipPath(targetDir, fileName) {
  const resolved = path.resolve(targetDir, fileName);
  return resolved.startsWith(path.resolve(targetDir) + path.sep);
}

// 4. Webhook Header Validator
function validateWebhookSecret(incomingHeader, expectedSecret) {
  if (!incomingHeader || !expectedSecret) return false;
  const a = Buffer.from(incomingHeader);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- EXECUTE TEST CASES ---
console.log('🧪 Running BotMaker-v2 Tokenless Security Verification...\n');

// Test 1: Log Redaction
const rawLog = 'Error connecting with token 123456789:ABCdefGHIjklMNOpqrsTUVwxyZ123456789 at host';
const sanitized = redactSecrets(rawLog);
assert(!sanitized.includes('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ123456789'), 'Token should be masked');
assert(sanitized.includes('[REDACTED_BOT_TOKEN]'), 'Replacement string should be present');
console.log('✅ PASS: Log Secret Redaction Test');

// Test 2: Token Encryption at Rest
const sampleToken = '987654321:AABbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqR';
const encrypted = encryptSecret(sampleToken);
assert(!encrypted.includes(sampleToken), 'Encrypted data must not contain raw token');
const decrypted = decryptSecret(encrypted);
assert.strictEqual(decrypted, sampleToken, 'Decrypted token must match original');
console.log('✅ PASS: AES-256-GCM Encryption at Rest Test');

// Test 3: Path Traversal Defense
assert.strictEqual(isSafeZipPath('/var/app/data', 'index.js'), true, 'Normal file should be allowed');
assert.strictEqual(isSafeZipPath('/var/app/data', '../../etc/passwd'), false, 'Path traversal should be blocked');
assert.strictEqual(isSafeZipPath('/var/app/data', 'sub/dir/bot.js'), true, 'Nested valid file should be allowed');
console.log('✅ PASS: Zip Path Traversal Sanity Test');

// Test 4: Webhook Secret Validation
const secret = 'super_secret_token_123';
assert.strictEqual(validateWebhookSecret('super_secret_token_123', secret), true, 'Valid secret accepted');
assert.strictEqual(validateWebhookSecret('wrong_secret', secret), false, 'Invalid secret rejected');
console.log('✅ PASS: Webhook Constant-Time Secret Verification Test');

console.log('\n🎉 All local tokenless security tests passed successfully!');
```

---

## 8. Dedicated VPS Verification & Deployment Test Steps

For staging or production validation on a dedicated VPS host:

### Step 1: VPS Prerequisites & Container Runtime Hardening
```bash
# 1. Update system packages
sudo apt-get update && sudo apt-get install -y docker.io curl jq ufw

# 2. Verify Docker installation & install gVisor (runsc) if in lab mode
sudo docker --version
```

### Step 2: Ingress HTTPS & Webhook Verification
```bash
# 1. Configure firewall rules
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8443/tcp
sudo ufw enable

# 2. Test HTTPS TLS endpoint accessibility
curl -Iv https://your-domain.com/api/v2/webhook/health

# 3. Simulate unauthorized webhook POST (expect 403)
curl -X POST https://your-domain.com/api/v2/webhook/bot_1 \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: INVALID_SECRET" \
  -d '{"update_id": 100}'
# Expected response: 403 Forbidden

# 4. Simulate authorized webhook POST (expect 200)
curl -X POST https://your-domain.com/api/v2/webhook/bot_1 \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: VALID_CONFIGURED_SECRET" \
  -d '{"update_id": 101, "message": {"chat": {"id": 123}, "text": "/start"}}'
# Expected response: 200 OK
```

### Step 3: Container Egress & Isolation Test (Lab Environment)
```bash
# Run test container to verify egress isolation
docker run --rm \
  --network bridge \
  --read-only \
  --user 10001:10001 \
  --cap-drop=ALL \
  --security-opt no-new-privileges:true \
  alpine ping -c 1 169.254.169.254 || echo "Metadata IP correctly blocked or unreachable"
```

### Step 4: Token Revocation & Log Audit
```bash
# Check system log output to confirm token is redacted:
grep -E "[0-9]{6,12}:[A-Za-z0-9_-]{30,}" /var/log/botmaker-v2/*.log || echo "PASS: No raw tokens found in logs"
```

---

## 9. Summary Matrix of Decisions & Recommendations

| Feature / Area | Recommendation / Decision | Justification |
| :--- | :--- | :--- |
| **Delivery Mechanism** | **Webhook** for Public SaaS; Sequential Long-Poll for private local dev. | Eliminates HTTP 409 Conflict errors, drastically reduces socket overhead, scales horizontally. |
| **Public SaaS Scope** | Strictly **Standard Templates** (Auto-reply, Support, E-commerce, Forms). | Eliminates RCE attack vectors from arbitrary untrusted file execution. |
| **Custom Code Execution** | **DEFERRED** or restricted to Dedicated Lab Infrastructure. | Custom zip execution requires hardware-isolated MicroVMs (Firecracker/gVisor) and network isolation. |
| **Storage Engine** | **SQLite (`better-sqlite3`)** with AES-256-GCM token encryption. | Replaces risky flat-file JSON storage with atomic transactions and encrypted secrets. |
| **Secret Masking** | Global log filter pipeline for Telegram token formats. | Prevents credential leaks in platform stdout/stderr and file logs. |
