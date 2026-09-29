'use strict';

const fs = require('fs');
const path = require('path');
const { STATIC_ANALYSIS_RULES } = require('./constants');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'venv',
  '.venv',
  'dist',
  'build',
  'coverage'
]);

const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py']);
const TEXT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.json', '.yaml', '.yml', '.env', '.txt', '.md', '.toml', '.ini']);

/**
 * Recursively list all files in directory skipping ignored directories
 * @param {string} dirPath
 * @param {string} baseDir
 * @returns {string[]} Absolute file paths
 */
function getAllSourceFiles(dirPath, baseDir) {
  let results = [];
  if (!fs.existsSync(dirPath)) return results;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        results = results.concat(getAllSourceFiles(fullPath, baseDir));
      }
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Run static analysis code checks on extracted source files (warnings only).
 *
 * @param {string} sourcePath Path to extracted source repository
 * @param {Object} options Configuration overrides
 * @returns {Object} Analysis findings result
 */
function runStaticAnalysis(sourcePath, options = {}) {
  const canonicalSourcePath = path.resolve(sourcePath);
  const warnings = [];

  if (!fs.existsSync(canonicalSourcePath)) {
    return {
      scannedFilesCount: 0,
      warnings: [{ file: sourcePath, line: 0, match: '', issue: 'Source directory does not exist for analysis.', severity: 'warning' }],
      hasWarnings: true
    };
  }

  const allFiles = getAllSourceFiles(canonicalSourcePath, canonicalSourcePath);
  let scannedFilesCount = 0;

  for (const filePath of allFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;

    scannedFilesCount++;
    const relativePath = path.relative(canonicalSourcePath, filePath);

    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      warnings.push({
        file: relativePath,
        line: 0,
        match: '',
        issue: `Unable to read file for static analysis: ${e.message}`,
        severity: 'warning'
      });
      continue;
    }

    const lines = content.split(/\r?\n/);

    // Apply rules line by line
    lines.forEach((lineText, lineIdx) => {
      const lineNum = lineIdx + 1;
      const trimmedLine = lineText.trim();
      if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('#')) return;

      // JS / TS Rules
      if (JS_EXTS.has(ext)) {
        for (const rule of STATIC_ANALYSIS_RULES.js) {
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(trimmedLine)) {
            warnings.push({
              file: relativePath,
              line: lineNum,
              match: trimmedLine.length > 80 ? trimmedLine.substring(0, 80) + '...' : trimmedLine,
              issue: rule.issue,
              severity: rule.severity || 'warning'
            });
          }
        }
      }

      // Python Rules
      if (PY_EXTS.has(ext)) {
        for (const rule of STATIC_ANALYSIS_RULES.py) {
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(trimmedLine)) {
            warnings.push({
              file: relativePath,
              line: lineNum,
              match: trimmedLine.length > 80 ? trimmedLine.substring(0, 80) + '...' : trimmedLine,
              issue: rule.issue,
              severity: rule.severity || 'warning'
            });
          }
        }
      }

      // Secrets Rules (All Text Files)
      for (const rule of STATIC_ANALYSIS_RULES.secrets) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(trimmedLine)) {
          warnings.push({
            file: relativePath,
            line: lineNum,
            match: '[REDACTED SECRET MATCH]',
            issue: rule.issue,
            severity: rule.severity || 'warning'
          });
        }
      }
    });
  }

  return {
    scannedFilesCount,
    warnings,
    hasWarnings: warnings.length > 0
  };
}

module.exports = {
  runStaticAnalysis
};
