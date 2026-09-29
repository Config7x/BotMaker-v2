'use strict';

const { validateUploadArchive, cleanupExtractedSource } = require('./validator');
const { validateManifestAndStartCommand } = require('./manifest');
const { runStaticAnalysis } = require('./analyzer');
const { runContainerDiagnostics, checkDockerAvailable, buildContainerArgs } = require('./container');
const { DEFAULT_CONFIG, SECURITY_CAVEATS } = require('./constants');

/**
 * Master inspection pipeline for custom source uploads.
 *
 * Runs full validation sequence:
 * 1. Upload ZIP extraction & safeguards check (size, bomb, traversal, symlinks)
 * 2. Manifest and start command allowlist check (Node 20, Python 3.11)
 * 3. Static code analysis check (warnings only)
 * 4. Hardened disposable container diagnostics (if Docker available & review gate open)
 *
 * @param {Buffer|string} zipInput
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function inspectCustomSource(zipInput, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const autoCleanup = options.keepExtracted ? false : true;

  // 1. Archive Validation & Extraction
  const archiveResult = await validateUploadArchive(zipInput, config);

  if (!archiveResult.valid) {
    return {
      valid: false,
      summary: {
        passed: false,
        errors: archiveResult.errors,
        warnings: archiveResult.warnings
      },
      archiveValidation: archiveResult,
      manifestValidation: null,
      staticAnalysis: null,
      containerDiagnostics: null,
      securityCaveats: SECURITY_CAVEATS
    };
  }

  const extractPath = archiveResult.extractPath;

  try {
    // 2. Manifest & Start Command Validation
    const manifestResult = validateManifestAndStartCommand(extractPath, config);

    // 3. Static Code Analysis Checks (Warnings only)
    const staticResult = runStaticAnalysis(extractPath, config);

    // 4. Hardened Container Diagnostics
    const containerResult = await runContainerDiagnostics(extractPath, manifestResult, config);

    // Collect all errors & warnings
    const allErrors = [
      ...(archiveResult.errors || []),
      ...(manifestResult.errors || [])
    ];

    const staticWarningStrings = (staticResult.warnings || []).map(
      (w) => `${w.file}:${w.line} - [${w.severity.toUpperCase()}] ${w.issue}${w.match ? ` (${w.match})` : ''}`
    );

    const allWarnings = [
      ...(archiveResult.warnings || []),
      ...(manifestResult.warnings || []),
      ...staticWarningStrings
    ];

    const isValid = archiveResult.valid && manifestResult.valid;

    const report = {
      valid: isValid,
      summary: {
        passed: isValid,
        errors: allErrors,
        warnings: allWarnings
      },
      archiveValidation: archiveResult,
      manifestValidation: manifestResult,
      staticAnalysis: staticResult,
      containerDiagnostics: containerResult,
      securityCaveats: SECURITY_CAVEATS
    };

    return report;
  } finally {
    if (autoCleanup && extractPath) {
      cleanupExtractedSource(extractPath);
    }
  }
}

module.exports = {
  inspectCustomSource,
  validateUploadArchive,
  validateManifestAndStartCommand,
  runStaticAnalysis,
  runContainerDiagnostics,
  cleanupExtractedSource,
  checkDockerAvailable,
  buildContainerArgs,
  DEFAULT_CONFIG,
  SECURITY_CAVEATS
};
