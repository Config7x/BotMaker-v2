'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CONFIG,
  PROHIBITED_COMMAND_PATTERNS,
  DISALLOWED_START_FLAGS,
  ALLOWED_START_FLAGS
} = require('./constants');

/**
 * Split command string into binary and arguments without using shell execution
 * @param {string} cmdStr
 * @returns {string[]}
 */
function parseCommandTokens(cmdStr) {
  if (!cmdStr || typeof cmdStr !== 'string') return [];
  const trimmed = cmdStr.trim();
  // Simple tokenization handling space and quoted strings
  const tokens = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if ((char === '"' || char === "'")) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += char;
      }
    } else if (/\s/.test(char) && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Validate declared runtime string
 * @param {string} rawRuntime
 * @returns {{ valid: boolean, normalizedRuntime: string|null, error: string|null }}
 */
function validateRuntime(rawRuntime) {
  if (!rawRuntime || typeof rawRuntime !== 'string') {
    return { valid: false, normalizedRuntime: null, error: 'Runtime specification is missing or empty.' };
  }

  const str = rawRuntime.trim().toLowerCase();
  const nodeMatches = DEFAULT_CONFIG.supportedRuntimes.NODE_20;
  const pythonMatches = DEFAULT_CONFIG.supportedRuntimes.PYTHON_311;

  if (nodeMatches.some((m) => str === m || str.includes('node') || str.includes('20'))) {
    // Ensure it's Node 20
    if (str.includes('14') || str.includes('16') || str.includes('18') || str.includes('12')) {
      return { valid: false, normalizedRuntime: null, error: `Unsupported Node version declared: "${rawRuntime}". Only Node 20 is supported.` };
    }
    return { valid: true, normalizedRuntime: 'node20', error: null };
  }

  if (pythonMatches.some((m) => str === m || str.includes('python') || str.includes('3.11'))) {
    if (str.includes('2.7') || str.includes('3.8') || str.includes('3.9') || str.includes('3.10') || str.includes('python2')) {
      return { valid: false, normalizedRuntime: null, error: `Unsupported Python version declared: "${rawRuntime}". Only Python 3.11 is supported.` };
    }
    return { valid: true, normalizedRuntime: 'python311', error: null };
  }

  return {
    valid: false,
    normalizedRuntime: null,
    error: `Unsupported runtime: "${rawRuntime}". Only Node 20 and Python 3.11 are supported runtimes.`
  };
}

/**
 * Validate start command string against strict allowlist and forbidden tokens
 * @param {string} startCmd
 * @param {string} runtime 'node20' | 'python311'
 * @param {string} sourcePath
 * @returns {{ valid: boolean, error: string|null, warnings: string[] }}
 */
function validateStartCommand(startCmd, runtime, sourcePath) {
  const warnings = [];

  if (!startCmd || typeof startCmd !== 'string' || startCmd.trim() === '') {
    return { valid: false, error: 'Start command is missing or empty.', warnings };
  }

  const trimmed = startCmd.trim();

  // 1. Prohibited Character / Operator / Command Injection Check
  for (const pattern of PROHIBITED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error: `Start command contains prohibited shell operator or forbidden binary in: "${trimmed}"`,
        warnings
      };
    }
  }

  // 2. Tokenize command
  const tokens = parseCommandTokens(trimmed);
  if (tokens.length === 0) {
    return { valid: false, error: 'Failed to parse start command tokens.', warnings };
  }

  const binary = tokens[0];
  const args = tokens.slice(1);

  // 3. Strict Binary Allowlist Check
  if (runtime === 'node20') {
    if (!DEFAULT_CONFIG.startCommandAllowlist.node.includes(binary)) {
      return {
        valid: false,
        error: `Invalid binary "${binary}" for Node 20 runtime. Start command binary must be "node".`,
        warnings
      };
    }

    let scriptPathFound = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Check disallowed Node flags (-e, --eval, -p, etc.)
      if (DISALLOWED_START_FLAGS.node.some((rgx) => rgx.test(arg))) {
        return {
          valid: false,
          error: `Disallowed Node flag "${arg}" in start command. Inline evaluation (-e/--eval/--print) is prohibited.`,
          warnings
        };
      }

      // Check allowed option flags
      if (arg.startsWith('-')) {
        const isAllowedFlag = ALLOWED_START_FLAGS.node.some((rgx) => rgx.test(arg));
        if (!isAllowedFlag) {
          return {
            valid: false,
            error: `Unrecognized or prohibited option flag "${arg}" in Node start command.`,
            warnings
          };
        }
      } else {
        // First non-flag argument is the script file path
        if (!scriptPathFound) {
          scriptPathFound = true;
          const targetScriptPath = path.resolve(sourcePath, arg);
          const canonicalSource = path.resolve(sourcePath);

          if (!targetScriptPath.startsWith(canonicalSource + path.sep) && targetScriptPath !== canonicalSource) {
            return {
              valid: false,
              error: `Start command script path "${arg}" escapes repository boundary.`,
              warnings
            };
          }

          if (!fs.existsSync(targetScriptPath)) {
            warnings.push(`Start command script file "${arg}" was not found inside the extracted repository.`);
          }
        }
      }
    }

    if (!scriptPathFound) {
      return { valid: false, error: 'Start command for Node must specify an entry script file (e.g., "node index.js").', warnings };
    }

  } else if (runtime === 'python311') {
    if (!DEFAULT_CONFIG.startCommandAllowlist.python.includes(binary)) {
      return {
        valid: false,
        error: `Invalid binary "${binary}" for Python 3.11 runtime. Binary must be "python", "python3", or "python3.11".`,
        warnings
      };
    }

    let targetFound = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Check disallowed Python flags (-c, -i)
      if (DISALLOWED_START_FLAGS.python.some((rgx) => rgx.test(arg))) {
        return {
          valid: false,
          error: `Disallowed Python flag "${arg}" in start command. Inline code evaluation (-c) is prohibited.`,
          warnings
        };
      }

      if (arg === '-m') {
        targetFound = true;
        const moduleName = args[i + 1];
        if (!moduleName) {
          return { valid: false, error: 'Missing module name after "-m" flag in Python start command.', warnings };
        }
        // Block dangerous modules
        const blockedModules = ['http.server', 'subprocess', 'os', 'pip', 'unittest', 'site', 'idlelib'];
        if (blockedModules.includes(moduleName)) {
          return { valid: false, error: `Prohibited Python module "${moduleName}" in "-m" start command.`, warnings };
        }
        i++; // Skip module name argument
      } else if (arg.startsWith('-')) {
        const isAllowedFlag = ALLOWED_START_FLAGS.python.some((rgx) => rgx.test(arg));
        if (!isAllowedFlag) {
          return {
            valid: false,
            error: `Unrecognized or prohibited option flag "${arg}" in Python start command.`,
            warnings
          };
        }
      } else {
        if (!targetFound) {
          targetFound = true;
          const targetScriptPath = path.resolve(sourcePath, arg);
          const canonicalSource = path.resolve(sourcePath);

          if (!targetScriptPath.startsWith(canonicalSource + path.sep) && targetScriptPath !== canonicalSource) {
            return {
              valid: false,
              error: `Start command script path "${arg}" escapes repository boundary.`,
              warnings
            };
          }

          if (!fs.existsSync(targetScriptPath)) {
            warnings.push(`Start command script file "${arg}" was not found inside the extracted repository.`);
          }
        }
      }
    }

    if (!targetFound) {
      return { valid: false, error: 'Start command for Python must specify a script file or module (e.g., "python main.py").', warnings };
    }
  }

  return { valid: true, error: null, warnings };
}

/**
 * Validate source directory manifest and declared start command
 * @param {string} sourcePath Path to extracted source directory
 * @param {Object} options Options override
 * @returns {Object} Manifest validation result
 */
function validateManifestAndStartCommand(sourcePath, options = {}) {
  const errors = [];
  const warnings = [];

  const canonicalPath = path.resolve(sourcePath);
  if (!fs.existsSync(canonicalPath)) {
    return {
      valid: false,
      runtime: null,
      startCommand: null,
      manifestFile: null,
      errors: [`Source directory does not exist: ${sourcePath}`],
      warnings
    };
  }

  let manifestFile = null;
  let rawRuntime = null;
  let rawStartCommand = null;

  // Check manifest files in priority order
  const manifestJsonPath = path.join(canonicalPath, 'manifest.json');
  const botmakerJsonPath = path.join(canonicalPath, 'botmaker.json');
  const packageJsonPath = path.join(canonicalPath, 'package.json');
  const pyprojectPath = path.join(canonicalPath, 'pyproject.toml');
  const reqTxtPath = path.join(canonicalPath, 'requirements.txt');

  if (fs.existsSync(manifestJsonPath)) {
    manifestFile = 'manifest.json';
    try {
      const content = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
      rawRuntime = content.runtime || content.node || content.python;
      rawStartCommand = content.start || content.start_command;
    } catch (e) {
      errors.push(`Failed to parse manifest.json: ${e.message}`);
    }
  } else if (fs.existsSync(botmakerJsonPath)) {
    manifestFile = 'botmaker.json';
    try {
      const content = JSON.parse(fs.readFileSync(botmakerJsonPath, 'utf8'));
      rawRuntime = content.runtime || content.node || content.python;
      rawStartCommand = content.start || content.start_command;
    } catch (e) {
      errors.push(`Failed to parse botmaker.json: ${e.message}`);
    }
  } else if (fs.existsSync(packageJsonPath)) {
    manifestFile = 'package.json';
    try {
      const content = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const nodeEngine = content.engines && content.engines.node;
      rawRuntime = nodeEngine ? `node ${nodeEngine}` : 'node20';
      rawStartCommand = content.scripts && content.scripts.start;
    } catch (e) {
      errors.push(`Failed to parse package.json: ${e.message}`);
    }
  } else if (fs.existsSync(pyprojectPath) || fs.existsSync(reqTxtPath)) {
    manifestFile = fs.existsSync(pyprojectPath) ? 'pyproject.toml' : 'requirements.txt';
    rawRuntime = 'python3.11';
    // For Python repos without manifest.json, search for main.py, app.py, bot.py
    if (fs.existsSync(path.join(canonicalPath, 'main.py'))) {
      rawStartCommand = 'python main.py';
    } else if (fs.existsSync(path.join(canonicalPath, 'bot.py'))) {
      rawStartCommand = 'python bot.py';
    } else if (fs.existsSync(path.join(canonicalPath, 'app.py'))) {
      rawStartCommand = 'python app.py';
    }
  }

  if (!manifestFile) {
    errors.push('No supported manifest found (expected manifest.json, botmaker.json, package.json, or pyproject.toml/requirements.txt).');
    return { valid: false, runtime: null, startCommand: null, manifestFile: null, errors, warnings };
  }

  if (errors.length > 0) {
    return { valid: false, runtime: null, startCommand: null, manifestFile, errors, warnings };
  }

  // 1. Validate Runtime
  const runtimeRes = validateRuntime(rawRuntime);
  if (!runtimeRes.valid) {
    errors.push(runtimeRes.error);
    return { valid: false, runtime: null, startCommand: rawStartCommand, manifestFile, errors, warnings };
  }

  // 2. Validate Start Command
  const startRes = validateStartCommand(rawStartCommand, runtimeRes.normalizedRuntime, canonicalPath);
  if (!startRes.valid) {
    errors.push(startRes.error);
  }
  if (startRes.warnings && startRes.warnings.length > 0) {
    warnings.push(...startRes.warnings);
  }

  return {
    valid: errors.length === 0,
    runtime: runtimeRes.normalizedRuntime,
    startCommand: rawStartCommand,
    manifestFile,
    errors,
    warnings
  };
}

module.exports = {
  validateManifestAndStartCommand,
  validateRuntime,
  validateStartCommand,
  parseCommandTokens
};
