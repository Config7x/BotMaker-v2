'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yauzl = require('yauzl');
const { DEFAULT_CONFIG } = require('./constants');

/**
 * Cleanup temporary extracted directory safely
 * @param {string} extractPath
 */
function cleanupExtractedSource(extractPath) {
  if (!extractPath || typeof extractPath !== 'string') return;
  try {
    const resolvedPath = path.resolve(extractPath);
    // Safety check: ensure resolvedPath is not root or system directory
    const rootPath = path.resolve('/');
    const tmpDir = path.resolve(os.tmpdir());
    
    if (resolvedPath === rootPath || resolvedPath === tmpDir) {
      throw new Error(`Refusing to delete system root or temp root directory: ${resolvedPath}`);
    }
    
    if (fs.existsSync(resolvedPath)) {
      fs.rmSync(resolvedPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to cleanup extract path ${extractPath}:`, err.message);
  }
}

/**
 * Validate upload ZIP archive and extract safely to a target sandbox directory.
 * Returns validation outcome and extraction details.
 *
 * @param {Buffer|string} zipInput Buffer containing ZIP data or file path to ZIP file
 * @param {Object} options Configuration overrides
 * @returns {Promise<Object>} Validation and extraction result
 */
async function validateUploadArchive(zipInput, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const errors = [];
  const warnings = [];

  let zipBuffer = null;
  let zipFilePath = null;

  // 1. Input Size & Format Validation
  if (Buffer.isBuffer(zipInput)) {
    zipBuffer = zipInput;
    if (zipBuffer.length === 0) {
      return { valid: false, extractPath: null, fileCount: 0, totalUncompressedSize: 0, errors: ['ZIP payload is empty.'], warnings };
    }
    if (zipBuffer.length > config.maxZipSizeBytes) {
      return {
        valid: false,
        extractPath: null,
        fileCount: 0,
        totalUncompressedSize: 0,
        errors: [`ZIP file size (${zipBuffer.length} bytes) exceeds maximum limit of ${config.maxZipSizeBytes} bytes.`],
        warnings
      };
    }
  } else if (typeof zipInput === 'string') {
    zipFilePath = path.resolve(zipInput);
    if (!fs.existsSync(zipFilePath)) {
      return { valid: false, extractPath: null, fileCount: 0, totalUncompressedSize: 0, errors: [`ZIP file not found at path: ${zipInput}`], warnings };
    }
    const stat = fs.statSync(zipFilePath);
    if (stat.size > config.maxZipSizeBytes) {
      return {
        valid: false,
        extractPath: null,
        fileCount: 0,
        totalUncompressedSize: 0,
        errors: [`ZIP file size (${stat.size} bytes) exceeds maximum limit of ${config.maxZipSizeBytes} bytes.`],
        warnings
      };
    }
  } else {
    return { valid: false, extractPath: null, fileCount: 0, totalUncompressedSize: 0, errors: ['Invalid ZIP input. Expected Buffer or string file path.'], warnings };
  }

  // Prepare safe extraction directory
  const targetDir = config.targetDir
    ? path.resolve(config.targetDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'custom-src-'));

  fs.mkdirSync(targetDir, { recursive: true });

  // 2. Open ZIP File with yauzl
  let zipfile;
  try {
    zipfile = await new Promise((resolve, reject) => {
      const cb = (err, zf) => (err ? reject(err) : resolve(zf));
      if (zipBuffer) {
        yauzl.fromBuffer(zipBuffer, { lazyEntries: true, decodeStrings: true }, cb);
      } else {
        yauzl.open(zipFilePath, { lazyEntries: true, decodeStrings: true }, cb);
      }
    });
  } catch (err) {
    cleanupExtractedSource(targetDir);
    return { valid: false, extractPath: null, fileCount: 0, totalUncompressedSize: 0, errors: [`Failed to open ZIP archive: ${err.message}`], warnings };
  }

  let fileCount = 0;
  let totalUncompressedSize = 0;

  return new Promise((resolve) => {
    let aborted = false;

    const abortWithErrors = (errMsgs) => {
      if (aborted) return;
      aborted = true;
      try { zipfile.close(); } catch (_) {}
      cleanupExtractedSource(targetDir);
      resolve({
        valid: false,
        extractPath: null,
        fileCount,
        totalUncompressedSize,
        errors: Array.isArray(errMsgs) ? errMsgs : [errMsgs],
        warnings
      });
    };

    zipfile.on('error', (err) => {
      abortWithErrors(`ZIP parsing error: ${err.message}`);
    });

    zipfile.on('end', () => {
      if (aborted) return;
      resolve({
        valid: errors.length === 0,
        extractPath: targetDir,
        fileCount,
        totalUncompressedSize,
        errors,
        warnings
      });
    });

    zipfile.on('entry', (entry) => {
      if (aborted) return;

      fileCount++;

      // Check file count limit
      if (fileCount > config.maxFileCount) {
        return abortWithErrors(`Archive file count exceeds maximum limit of ${config.maxFileCount} files.`);
      }

      // Check entry file name validity & null bytes
      if (!entry.fileName || entry.fileName.includes('\0')) {
        return abortWithErrors('ZIP entry contains invalid or null bytes in filename.');
      }

      // Path Traversal Check
      const normalizedEntryName = path.normalize(entry.fileName).replace(/^(\.\.[\/\\])+/, '');
      const canonicalTargetDir = path.resolve(targetDir);
      const canonicalDestPath = path.resolve(canonicalTargetDir, entry.fileName);
      const relativePath = path.relative(canonicalTargetDir, canonicalDestPath);

      if (
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath) ||
        (!canonicalDestPath.startsWith(canonicalTargetDir + path.sep) && canonicalDestPath !== canonicalTargetDir)
      ) {
        return abortWithErrors(`Directory traversal attack detected in ZIP entry: "${entry.fileName}"`);
      }

      // Symlink & Special File Safeguards
      const mode = (entry.externalFileAttributes >> 16) & 0xffff;
      const fileType = mode & 0xf000;
      
      const S_IFLNK = 0xa000; // Symbolic link
      const S_IFBLK = 0x6000; // Block device
      const S_IFCHR = 0x2000; // Character device
      const S_IFIFO = 0x1000; // FIFO pipe
      const S_IFSOCK = 0xc000; // Socket

      if (fileType === S_IFLNK) {
        return abortWithErrors(`Symbolic link detected in ZIP entry: "${entry.fileName}". Symlinks are strictly prohibited.`);
      }
      if ([S_IFBLK, S_IFCHR, S_IFIFO, S_IFSOCK].includes(fileType)) {
        return abortWithErrors(`Special file device node detected in ZIP entry: "${entry.fileName}". Special files are strictly prohibited.`);
      }

      // ZIP Bomb Size & Compression Ratio Safeguards
      if (entry.uncompressedSize > config.maxSingleFileUncompressedBytes) {
        return abortWithErrors(`Single file uncompressed size (${entry.uncompressedSize} bytes) exceeds limit of ${config.maxSingleFileUncompressedBytes} bytes for entry: "${entry.fileName}"`);
      }

      totalUncompressedSize += entry.uncompressedSize;
      if (totalUncompressedSize > config.maxTotalUncompressedBytes) {
        return abortWithErrors(`Total archive uncompressed size (${totalUncompressedSize} bytes) exceeds limit of ${config.maxTotalUncompressedBytes} bytes.`);
      }

      if (entry.compressedSize > 0) {
        const ratio = entry.uncompressedSize / entry.compressedSize;
        if (ratio > config.maxCompressionRatio && entry.uncompressedSize > 1024 * 1024) {
          return abortWithErrors(`Potential ZIP bomb detected: compression ratio (${ratio.toFixed(1)}:1) exceeds limit of ${config.maxCompressionRatio}:1 for entry: "${entry.fileName}"`);
        }
      }

      // Directory creation
      if (entry.fileName.endsWith('/') || (mode & 0xf000) === 0x4000) {
        try {
          fs.mkdirSync(canonicalDestPath, { recursive: true });
          zipfile.readEntry();
        } catch (err) {
          abortWithErrors(`Failed to create directory "${canonicalDestPath}": ${err.message}`);
        }
        return;
      }

      // File extraction streaming with real-time size limit tracking
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err || aborted) {
          return abortWithErrors(`Failed to read ZIP stream for entry "${entry.fileName}": ${err ? err.message : 'aborted'}`);
        }

        // Ensure parent folder exists
        const parentDir = path.dirname(canonicalDestPath);
        try {
          fs.mkdirSync(parentDir, { recursive: true });
        } catch (mkdirErr) {
          return abortWithErrors(`Failed to create parent directory "${parentDir}": ${mkdirErr.message}`);
        }

        const writeStream = fs.createWriteStream(canonicalDestPath);
        let entryBytesRead = 0;

        readStream.on('data', (chunk) => {
          entryBytesRead += chunk.length;
          if (entryBytesRead > config.maxSingleFileUncompressedBytes) {
            readStream.destroy();
            writeStream.destroy();
            abortWithErrors(`Active extracted size for entry "${entry.fileName}" exceeded max single file limit.`);
          }
        });

        readStream.on('error', (streamErr) => {
          writeStream.destroy();
          abortWithErrors(`Error reading ZIP entry "${entry.fileName}": ${streamErr.message}`);
        });

        writeStream.on('error', (writeErr) => {
          readStream.destroy();
          abortWithErrors(`Error writing file "${canonicalDestPath}": ${writeErr.message}`);
        });

        writeStream.on('finish', () => {
          if (!aborted) {
            zipfile.readEntry();
          }
        });

        readStream.pipe(writeStream);
      });
    });

    zipfile.readEntry();
  });
}

module.exports = {
  validateUploadArchive,
  cleanupExtractedSource
};
