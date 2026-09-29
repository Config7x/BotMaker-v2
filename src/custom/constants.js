'use strict';

/**
 * Custom Source Upload, Validation, & Diagnostics Constants
 */

const SOURCE_MENU_LABEL = '🧪 سورس اختصاصی';

const DEFAULT_CONFIG = {
  // Upload limits
  maxZipSizeBytes: 10 * 1024 * 1024, // 10 MB limit for compressed upload
  maxFileCount: 500, // Maximum total extracted files/directories
  maxTotalUncompressedBytes: 50 * 1024 * 1024, // 50 MB total uncompressed size limit
  maxSingleFileUncompressedBytes: 10 * 1024 * 1024, // 10 MB single file limit
  maxCompressionRatio: 100, // Maximum allowed compression ratio per entry/archive

  // Runtime support
  supportedRuntimes: {
    NODE_20: ['node20', 'node:20', 'node-20', 'node 20', '>=20', '20', 'node'],
    PYTHON_311: ['python3.11', 'python-3.11', 'python 3.11', '3.11', 'python3', 'python']
  },

  // Allowed start command binaries
  startCommandAllowlist: {
    node: ['node'],
    python: ['python', 'python3', 'python3.11']
  },

  // Hardened Container Execution Defaults
  containerDefaults: {
    timeoutMs: 15000,
    networkMode: 'none',
    readOnlyRoot: true,
    cpuLimit: '0.5',
    memoryLimit: '256m',
    memorySwap: '256m',
    pidsLimit: 64,
    capDrop: ['ALL'],
    securityOpts: ['no-new-privileges:true'],
    tmpfsMounts: ['/tmp:rw,noexec,nosuid', '/root:rw,noexec,nosuid'],
    user: '1000:1000',
    images: {
      node20: 'node:20-alpine',
      python311: 'python:3.11-alpine'
    }
  }
};

// Prohibited command characters and dangerous tokens for start commands
const PROHIBITED_COMMAND_PATTERNS = [
  /[\&\|\;\`\$\>\<\n\r]/, // Shell operators, chaining, redirection, substitution
  /\b(sudo|sh|bash|zsh|fish|powershell|cmd|curl|wget|nc|netcat|eval|exec|chown|chmod|rm|pkill|kill|nohup)\b/i
];

// Dangerous flags for Node and Python binaries in start commands
const DISALLOWED_START_FLAGS = {
  node: [/^-e$/, /^--eval$/, /^-p$/, /^--print$/, /^-i$/, /^--interactive$/, /^--inspect/],
  python: [/^-c$/, /^-i$/]
};

// Allowed flag patterns for start commands
const ALLOWED_START_FLAGS = {
  node: [/^--env-file=.+$/, /^--max-old-space-size=\d+$/, /^--experimental-[a-z0-9_-]+$/],
  python: [/^-u$/, /^-O$/, /^-OO$/, /^-B$/]
};

// Static Analysis Scanning Patterns
const STATIC_ANALYSIS_RULES = {
  js: [
    { pattern: /\beval\s*\(/g, issue: 'Use of eval() detected', severity: 'warning' },
    { pattern: /new\s+Function\s*\(/g, issue: 'Use of new Function() constructor detected', severity: 'warning' },
    { pattern: /require\s*\(\s*['"]child_process['"]\s*\)|import\s+.*from\s+['"]child_process['"]/g, issue: 'Import of child_process module detected', severity: 'warning' },
    { pattern: /\b(exec|execSync|spawn|spawnSync|fork)\s*\(/g, issue: 'Subprocess execution call (exec/spawn/fork) detected', severity: 'warning' },
    { pattern: /\bfs\.(unlink|rm|rmdir|unlinkSync|rmSync|rmdirSync)\b/g, issue: 'File deletion API call detected', severity: 'warning' },
    { pattern: /\bprocess\.(exit|kill)\b/g, issue: 'Process exit or kill signal call detected', severity: 'warning' },
    { pattern: /\b(net\.createServer|dgram\.createSocket)\b/g, issue: 'Raw network socket server creation detected', severity: 'warning' }
  ],
  py: [
    { pattern: /\beval\s*\(/g, issue: 'Use of eval() detected', severity: 'warning' },
    { pattern: /\bexec\s*\(/g, issue: 'Use of exec() detected', severity: 'warning' },
    { pattern: /\bos\.system\s*\(/g, issue: 'Use of os.system() detected', severity: 'warning' },
    { pattern: /\b(subprocess\.\w+|import\s+subprocess)\b/g, issue: 'Use of subprocess module detected', severity: 'warning' },
    { pattern: /\bimport\s+(socket|ctypes|pty)\b/g, issue: 'Import of low-level system module (socket/ctypes/pty) detected', severity: 'warning' },
    { pattern: /\b(os\.remove|os\.unlink|shutil\.rmtree)\b/g, issue: 'File deletion API call detected', severity: 'warning' }
  ],
  secrets: [
    {
      pattern: /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|bearer[_-]?token|password|private[_-]?key|bot[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-\.]{8,}["']/i,
      issue: 'Potential hardcoded secret or API token detected',
      severity: 'warning'
    }
  ]
};

// Official Security Limitations & Caveats Documented for Core
const SECURITY_CAVEATS = [
  'Docker container isolation provides OS-level resource limits and network isolation for private inspection and testing only.',
  'Docker containers share the host Linux kernel and cannot guarantee absolute tenant isolation for long-running multi-tenant public hosting of untrusted arbitrary code.',
  'Host npm / pip execution is strictly prohibited. Package installations and smoke tests must occur exclusively inside hardened disposable containers.',
  'Direct host fallback execution is blocked by design when Docker is unavailable or disabled.',
  'Private testing execution requires explicit administrative review and gate approval (allowPrivateTestExecution: true).'
];

module.exports = {
  SOURCE_MENU_LABEL,
  DEFAULT_CONFIG,
  PROHIBITED_COMMAND_PATTERNS,
  DISALLOWED_START_FLAGS,
  ALLOWED_START_FLAGS,
  STATIC_ANALYSIS_RULES,
  SECURITY_CAVEATS
};
