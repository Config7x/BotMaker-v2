'use strict';

/**
 * Custom Source Upload, Validation, & Diagnostics Module
 * BotMaker v2 Private Testing Component
 *
 * @module botmaker-v2/src/custom
 */

const {
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
} = require('./diagnostics');

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
