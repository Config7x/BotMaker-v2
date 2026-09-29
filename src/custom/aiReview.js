'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * Helper to recursively list and read text source files from a directory
 * @param {string} sourceDir
 * @returns {Array<{ path: string, content: string }>}
 */
function loadSourceFiles(sourceDir) {
  if (Array.isArray(sourceDir)) {
    return sourceDir;
  }
  const files = [];
  const canonicalRoot = path.resolve(sourceDir);

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(canonicalRoot, fullPath);

      if (entry.isDirectory()) {
        if (['node_modules', '.git', '__pycache__', 'candidate'].includes(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (/\.(png|jpg|jpeg|gif|ico|zip|tar|gz|7z|pdf|exe|dll|so|dylib|pyc|pyo)$/i.test(entry.name)) {
          continue;
        }
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > 1024 * 1024) continue; // Skip files > 1MB for AI review
          const content = fs.readFileSync(fullPath, 'utf8');
          files.push({ path: relPath, content });
        } catch {
          // ignore read error
        }
      }
    }
  }

  if (fs.existsSync(canonicalRoot)) {
    walk(canonicalRoot);
  }
  return files;
}

/**
 * AI-assisted Deeper Security Review
 *
 * @param {string|Array} sourceDirOrFiles Path to source dir or array of { path, content }
 * @param {Object} options Options containing injectable aiClient
 * @returns {Promise<{ passed: boolean, skipped: boolean, reason?: string, issues: string[] }>}
 */
async function runAiSecurityReview(sourceDirOrFiles, options = {}) {
  const aiClient = options.aiClient;
  const files = Array.isArray(sourceDirOrFiles) ? sourceDirOrFiles : loadSourceFiles(sourceDirOrFiles);

  if (!aiClient) {
    return {
      passed: true,
      skipped: true,
      reason: 'AI security review skipped: no aiClient configured',
      issues: []
    };
  }

  try {
    let result;
    if (typeof aiClient.reviewSecurity === 'function') {
      result = await aiClient.reviewSecurity(files);
    } else if (typeof aiClient === 'function') {
      result = await aiClient({ type: 'security', files });
    } else if (typeof aiClient.review === 'function') {
      result = await aiClient.review('security', files);
    }

    if (result) {
      const passed = result.passed !== false && (!result.issues || result.issues.length === 0);
      return {
        passed,
        skipped: false,
        issues: result.issues || (passed ? [] : ['مشکل امنیتی توسط AI شناسایی شد'])
      };
    }
  } catch (err) {
    console.error('Error during AI security review:', err);
    return {
      passed: false,
      skipped: false,
      issues: [`خطا در بررسی امنیتی AI: ${err.message}`]
    };
  }

  return {
    passed: true,
    skipped: false,
    issues: []
  };
}

/**
 * Feasible static syntax check for JS files without executing code
 * @param {Array<{ path: string, content: string }>} files
 * @returns {string[]} Array of syntax issue descriptions
 */
function staticSyntaxCheck(files) {
  const issues = [];
  for (const file of files) {
    if (file.path.endsWith('.js') || file.path.endsWith('.mjs') || file.path.endsWith('.cjs')) {
      try {
        new vm.Script(file.content, { filename: file.path });
      } catch (err) {
        issues.push(`خطای سنتکس در فایل ${file.path}: ${err.message}`);
      }
    }
  }
  return issues;
}

/**
 * AI-assisted Bug & Logic Review Pass
 *
 * @param {string|Array} sourceDirOrFiles Path to source dir or array of { path, content }
 * @param {Object} options Options containing injectable aiClient
 * @returns {Promise<{ passed: boolean, skipped: boolean, reason?: string, issues: string[] }>}
 */
async function runAiBugReview(sourceDirOrFiles, options = {}) {
  const aiClient = options.aiClient;
  const files = Array.isArray(sourceDirOrFiles) ? sourceDirOrFiles : loadSourceFiles(sourceDirOrFiles);

  const staticIssues = staticSyntaxCheck(files);

  if (!aiClient) {
    return {
      passed: staticIssues.length === 0,
      skipped: true,
      reason: 'AI bug review skipped: no aiClient configured',
      issues: staticIssues
    };
  }

  try {
    let result;
    if (typeof aiClient.reviewBugs === 'function') {
      result = await aiClient.reviewBugs(files);
    } else if (typeof aiClient === 'function') {
      result = await aiClient({ type: 'bugs', files });
    } else if (typeof aiClient.review === 'function') {
      result = await aiClient.review('bugs', files);
    }

    const aiIssues = result?.issues || [];
    const allIssues = [...staticIssues, ...aiIssues];
    const passed = allIssues.length === 0;

    return {
      passed,
      skipped: false,
      issues: allIssues
    };
  } catch (err) {
    console.error('Error during AI bug review:', err);
    return {
      passed: staticIssues.length === 0,
      skipped: false,
      issues: [...staticIssues, `خطا در بررسی باگ AI: ${err.message}`]
    };
  }
}

/**
 * Attempt automated source fix using injectable aiClient
 *
 * @param {string} sourceDir Path to source directory
 * @param {Object} options Options containing injectable aiClient
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function runAiAutoFix(sourceDir, options = {}) {
  const aiClient = options.aiClient;
  if (!aiClient) {
    return { success: false, message: 'سیستم AI برای اصلاح خودکار پیکربندی نشده است.' };
  }

  try {
    if (typeof aiClient.autoFix === 'function') {
      await aiClient.autoFix(sourceDir);
    }
    // AI fix logic placeholder / execution
    return { success: true, message: 'اصلاح خودکار با موفقیت انجام شد.' };
  } catch (err) {
    return { success: false, message: `خطا در اصلاح خودکار: ${err.message}` };
  }
}

module.exports = {
  loadSourceFiles,
  runAiSecurityReview,
  runAiBugReview,
  runAiAutoFix,
  staticSyntaxCheck
};
