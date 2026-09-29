'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Configuration & Hardened Limits
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_FILE_COUNT = 20;
const MAX_SINGLE_FILE_SIZE = 100 * 1024; // 100 KB
const MAX_TOTAL_SIZE = 500 * 1024; // 500 KB

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'venv',
  '.venv',
  'dist',
  'build',
  'coverage',
  '.idea',
  '.vscode'
]);

const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.env', '.txt', '.md', '.rst',
  '.sh', '.bash', '.zsh',
  '.html', '.css', '.xml', '.sql',
  '.dockerfile', '.gitignore', '.dockerignore'
]);

const ALLOWED_EXACT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'requirements.txt',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.env',
  '.gitignore',
  'readme.md',
  'readme'
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.pyc', '.pyo', '.pyd', '.class', '.o', '.obj',
  '.db', '.sqlite', '.sqlite3', '.wasm'
]);

/**
 * Validate and normalize target runtime.
 * Supported targets: 'node20' or 'python3.11'
 * @param {string} target
 * @returns {string} Normalized target string ('node20' or 'python3.11')
 */
function validateTargetRuntime(target) {
  if (!target || typeof target !== 'string') {
    throw new Error('Explicit target runtime ("node20" or "python3.11") is required.');
  }

  const normalized = target.trim().toLowerCase();

  const nodeVariants = new Set(['node20', 'node:20', 'node-20', 'node 20', 'node_20', 'node', '20']);
  const pythonVariants = new Set(['python3.11', 'python:3.11', 'python-3.11', 'python 3.11', 'python_3.11', 'python311', 'python3', 'python', '3.11']);

  if (nodeVariants.has(normalized)) {
    return 'node20';
  }
  if (pythonVariants.has(normalized)) {
    return 'python3.11';
  }

  throw new Error(`Unsupported target runtime: "${target}". Target must be explicitly "node20" or "python3.11".`);
}

/**
 * Validate HTTPS AI endpoint against allowlist.
 * @param {string} [endpointUrl]
 * @returns {string} Validated HTTPS URL string
 */
function validateEndpointUrl(endpointUrl) {
  const urlString = endpointUrl || process.env.AI_ENDPOINT || DEFAULT_ENDPOINT;
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (err) {
    throw new Error(`Invalid AI endpoint URL: "${urlString}"`);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`AI endpoint must use HTTPS protocol. Received: "${parsedUrl.protocol}"`);
  }

  // Allowlist check: Default endpoint + env endpoint (if set and https)
  const allowlist = new Set([DEFAULT_ENDPOINT]);
  if (process.env.AI_ENDPOINT) {
    try {
      const envUrl = new URL(process.env.AI_ENDPOINT);
      if (envUrl.protocol === 'https:') {
        allowlist.add(process.env.AI_ENDPOINT);
      }
    } catch (_) {
      // Ignore invalid env URL here
    }
  }

  if (!allowlist.has(urlString)) {
    throw new Error(`AI endpoint "${urlString}" is not in the allowlist.`);
  }

  return urlString;
}

/**
 * Scrub secrets, Telegram bot tokens, and keys from source content or path.
 * @param {string} content
 * @returns {string} Scrubbed string
 */
function scrubSecrets(content) {
  if (typeof content !== 'string') {
    return content;
  }

  let scrubbed = content;

  // Telegram bot token pattern: e.g. 123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345
  scrubbed = scrubbed.replace(/\b(\d{8,12}:[A-Za-z0-9_-]{20,50})\b/g, '[REDACTED_TELEGRAM_TOKEN]');

  // OpenAI / API Key patterns: e.g. sk-proj-...
  scrubbed = scrubbed.replace(/\b(sk-[A-Za-z0-9_-]{15,})\b/g, '[REDACTED_API_KEY]');

  // Code assignments matching secret/token/key keywords
  scrubbed = scrubbed.replace(/(bot_?token\s*[:=]\s*["'])[A-Za-z0-9_:-]+(["'])/gi, '$1[REDACTED_TELEGRAM_TOKEN]$2');
  scrubbed = scrubbed.replace(/(api_?key\s*[:=]\s*["'])[A-Za-z0-9_-]+(["'])/gi, '$1[REDACTED_API_KEY]$2');
  scrubbed = scrubbed.replace(/(secret_?key\s*[:=]\s*["'])[A-Za-z0-9_-]+(["'])/gi, '$1[REDACTED_SECRET]$2');
  scrubbed = scrubbed.replace(/(password\s*[:=]\s*["'])[A-Za-z0-9_-]+(["'])/gi, '$1[REDACTED_PASSWORD]$2');
  scrubbed = scrubbed.replace(/(authorization\s*:\s*bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED_BEARER_TOKEN]');

  return scrubbed;
}

/**
 * Check if a file is a valid text file based on path extension and content.
 * @param {string} filePath
 * @param {Buffer|string} [bufferOrString]
 * @returns {boolean}
 */
function isTextFile(filePath, bufferOrString) {
  if (!filePath || typeof filePath !== 'string') return false;

  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  if (BINARY_EXTENSIONS.has(ext)) {
    return false;
  }

  const isKnownExtension = ALLOWED_TEXT_EXTENSIONS.has(ext);
  const isKnownFilename = ALLOWED_EXACT_FILENAMES.has(basename);

  if (!isKnownExtension && !isKnownFilename && ext !== '') {
    return false;
  }

  if (bufferOrString) {
    const buf = Buffer.isBuffer(bufferOrString)
      ? bufferOrString
      : Buffer.from(String(bufferOrString), 'utf8');

    for (let i = 0; i < Math.min(buf.length, 8192); i++) {
      if (buf[i] === 0) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Sanitize and validate relative file path to prevent path traversal.
 * @param {string} filePath
 * @returns {string} Sanitized relative path
 */
function sanitizeRelativePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path: path must be a non-empty string.');
  }

  if (filePath.includes('\0')) {
    throw new Error('Path traversal detected: path contains null byte.');
  }

  if (path.isAbsolute(filePath)) {
    throw new Error(`Path traversal detected: absolute paths are prohibited (${filePath}).`);
  }

  const normalized = path.normalize(filePath).replace(/\\/g, '/');

  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error(`Path traversal detected: path "${filePath}" attempts directory traversal.`);
  }

  return normalized;
}

/**
 * Recursively gather files from directory with strict count/size/text checks.
 * @param {string} dirPath
 * @param {string} [baseDir]
 * @returns {Array<{path: string, content: string, size: number}>}
 */
function collectSourceFilesFromDir(dirPath, baseDir = dirPath) {
  let files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files = files.concat(collectSourceFilesFromDir(fullPath, baseDir));
      }
    } else if (entry.isFile()) {
      const sanitizedRel = sanitizeRelativePath(relPath);
      const stats = fs.statSync(fullPath);

      if (stats.size > MAX_SINGLE_FILE_SIZE) {
        throw new Error(`File "${sanitizedRel}" exceeds maximum allowed file size of ${MAX_SINGLE_FILE_SIZE} bytes.`);
      }

      const contentBuf = fs.readFileSync(fullPath);
      if (!isTextFile(sanitizedRel, contentBuf)) {
        throw new Error(`File "${sanitizedRel}" is binary or non-text. Only text files are permitted.`);
      }

      files.push({
        path: sanitizedRel,
        content: contentBuf.toString('utf8'),
        size: stats.size
      });
    }
  }

  return files;
}

/**
 * Main AI Rewrite function.
 * Generates an explicit AI rewrite candidate of unsupported source code.
 *
 * @param {string|Array|Object} sourceInput Directory path, array of file objects, or path-content map
 * @param {Object} options Configuration options
 * @returns {Promise<Object>} Candidate result object
 */
async function generateAiRewriteCandidate(sourceInput, options = {}) {
  // 1. Opt-in & Consent check
  const optIn = Boolean(options.optIn || options.userOptIn || options.explicitRequest);
  const consent = Boolean(options.consent || options.consentToExternalProvider || options.shareSourceConsent);

  if (!optIn || !consent) {
    throw new Error('AI rewrite requires explicit opt-in including consent to share source code with an external provider.');
  }

  // 2. Target runtime check
  const targetRuntime = validateTargetRuntime(options.targetRuntime || options.target);

  // 3. API key check (env, not chat)
  const apiKey = process.env.AI_API_KEY || options.apiKey;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Missing required AI_API_KEY environment variable for AI rewrite service.');
  }

  // 4. Endpoint check
  const endpoint = validateEndpointUrl(options.endpoint || process.env.AI_ENDPOINT);

  // 5. Gather & Validate Source Files
  let files = [];

  if (typeof sourceInput === 'string') {
    const resolvedPath = path.resolve(sourceInput);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Source path does not exist: "${sourceInput}"`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Source path must be a directory: "${sourceInput}"`);
    }
    files = collectSourceFilesFromDir(resolvedPath);
  } else if (Array.isArray(sourceInput)) {
    for (const item of sourceInput) {
      if (!item || !item.path || typeof item.content !== 'string') {
        throw new Error('Invalid file item in sourceInput array. Must contain "path" and string "content".');
      }
      const sanitizedRel = sanitizeRelativePath(item.path);
      const contentStr = item.content;
      const size = Buffer.byteLength(contentStr, 'utf8');

      if (size > MAX_SINGLE_FILE_SIZE) {
        throw new Error(`File "${sanitizedRel}" exceeds maximum allowed file size of ${MAX_SINGLE_FILE_SIZE} bytes.`);
      }

      if (!isTextFile(sanitizedRel, contentStr)) {
        throw new Error(`File "${sanitizedRel}" is binary or non-text. Only text files are permitted.`);
      }

      files.push({ path: sanitizedRel, content: contentStr, size });
    }
  } else if (sourceInput && typeof sourceInput === 'object') {
    for (const [filePath, fileContent] of Object.entries(sourceInput)) {
      if (typeof fileContent !== 'string') {
        throw new Error(`Invalid file content for path "${filePath}". Must be a string.`);
      }
      const sanitizedRel = sanitizeRelativePath(filePath);
      const size = Buffer.byteLength(fileContent, 'utf8');

      if (size > MAX_SINGLE_FILE_SIZE) {
        throw new Error(`File "${sanitizedRel}" exceeds maximum allowed file size of ${MAX_SINGLE_FILE_SIZE} bytes.`);
      }

      if (!isTextFile(sanitizedRel, fileContent)) {
        throw new Error(`File "${sanitizedRel}" is binary or non-text. Only text files are permitted.`);
      }

      files.push({ path: sanitizedRel, content: fileContent, size });
    }
  } else {
    throw new Error('Invalid source input provided. Expected directory path, array of file objects, or path-content map.');
  }

  // Validate strict count & total size limits
  if (files.length === 0) {
    throw new Error('No valid source text files found for AI rewrite.');
  }

  if (files.length > MAX_FILE_COUNT) {
    throw new Error(`File count exceeds maximum limit of ${MAX_FILE_COUNT} files (found ${files.length}).`);
  }

  const totalSize = files.reduce((acc, f) => acc + (f.size || Buffer.byteLength(f.content, 'utf8')), 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    throw new Error(`Total source size exceeds maximum limit of ${MAX_TOTAL_SIZE} bytes (found ${totalSize} bytes).`);
  }

  // 6. Scrub Secrets & Tokens from Files
  const scrubbedFiles = files.map(f => ({
    path: scrubSecrets(f.path),
    content: scrubSecrets(f.content)
  }));

  // 7. OpenAI-Compatible Request Payload
  const promptPayload = {
    model: options.model || 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are an expert bot migration agent. Rewrite the provided unsupported source code into a fully functional candidate implementation targeting runtime "${targetRuntime}".
Your response MUST be a single, valid JSON object strictly matching this schema:
{
  "summary": "High-level summary of the rewrite approach and structure",
  "files": [
    {
      "path": "relative/file/path",
      "content": "Full content of the file"
    }
  ]
}
Do NOT wrap the JSON in markdown formatting or code blocks. Output ONLY raw JSON.`
      },
      {
        role: 'user',
        content: `Target Runtime: ${targetRuntime}\n\nScrubbed Source Files:\n` + JSON.stringify(scrubbedFiles, null, 2)
      }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  };

  // 8. Execute HTTPS POST via fetch
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(promptPayload)
    });
  } catch (err) {
    throw new Error(`AI API request failed: ${err.message}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`AI API request returned HTTP status ${response.status}: ${errText.slice(0, 200)}`);
  }

  const responseData = await response.json();

  if (!responseData || !responseData.choices || !responseData.choices[0] || !responseData.choices[0].message) {
    throw new Error('Invalid or malformed response format received from AI API.');
  }

  const contentRaw = responseData.choices[0].message.content;
  let parsedContent;

  try {
    const cleanedRaw = typeof contentRaw === 'string'
      ? contentRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      : contentRaw;
    parsedContent = typeof cleanedRaw === 'string' ? JSON.parse(cleanedRaw) : cleanedRaw;
  } catch (err) {
    throw new Error(`Failed to parse structured JSON from AI candidate response: ${err.message}`);
  }

  if (!parsedContent || typeof parsedContent !== 'object') {
    throw new Error('AI response did not contain a valid JSON object candidate.');
  }

  const candidateFileList = parsedContent.files || parsedContent.candidateFiles;
  if (!Array.isArray(candidateFileList)) {
    throw new Error('AI response candidate missing required "files" array.');
  }

  // 9. Sanitize & Validate Candidate Files (Path Traversal Protection)
  const candidateFiles = [];
  for (const candFile of candidateFileList) {
    if (!candFile || typeof candFile.path !== 'string' || typeof candFile.content !== 'string') {
      continue;
    }

    try {
      const sanitizedPath = sanitizeRelativePath(candFile.path);
      candidateFiles.push({
        path: sanitizedPath,
        content: candFile.content
      });
    } catch (_) {
      // Unsafe candidate file path rejected due to path traversal attempt
    }
  }

  // 10. Return Structured Result (No Auto-Deploy, No Claim of Correctness)
  return {
    success: true,
    targetRuntime,
    summary: parsedContent.summary || `AI rewrite candidate generated for ${targetRuntime}`,
    candidateFiles,
    deployed: false,
    correctnessGuaranteed: false,
    disclaimer: 'This candidate rewrite was generated by AI and has NOT been automatically deployed or verified for correctness. Manual review and validation is required prior to deployment.'
  };
}

module.exports = {
  generateAiRewriteCandidate,
  validateTargetRuntime,
  validateEndpointUrl,
  scrubSecrets,
  isTextFile,
  sanitizeRelativePath,
  DEFAULT_ENDPOINT,
  MAX_FILE_COUNT,
  MAX_SINGLE_FILE_SIZE,
  MAX_TOTAL_SIZE
};
