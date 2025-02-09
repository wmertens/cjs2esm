const path = require('path');
const fs = require('fs-extra');
const { findFileSync, getAbsPathInfoSync } = require('./utils');

/**
 * @typedef {import('jscodeshift').API}      API
 * @typedef {import('jscodeshift').FileInfo} FileInfo
 */

/**
 * Creates the replacement path for an import statement for a folder. It validates if the
 * folder has a `package.json`, to keep it as it is, and if it fails, it tries to find an
 * index files,
 * `.mjs` or `.js`.
 *
 * @param {string} absPath     The absolute path for the folder.
 * @param {string} importPath  The path as it is on the import statement.
 * @returns {?string} If there's no `package.json` and no `index` was found, the function
 *                    will return `null`.
 */
const createReplacementForFolder = (absPath, importPath) => {
  let result;
  const pkgPath = path.join(absPath, 'package.json');
  const pkgExists = fs.pathExistsSync(pkgPath);
  if (pkgExists) {
    result = importPath.replace(/\/$/, '');
  } else {
    const file = findFileSync(['index.mjs', 'index.js'], absPath);
    result = file ? path.join(importPath, path.basename(file)) : null;
  }

  return result;
};

const updatePath = (item, base) => {
  const importPath = item.value.source.value;
  // Resolve the absolute path for the import statement.
  const absPath = importPath.startsWith('.')
    ? path.join(base, importPath)
    : path.resolve('node_modules', importPath);
  const info = getAbsPathInfoSync(absPath);
  let replacement;
  if (info === null) {
    // No info was found, so "don't replace it".
    replacement = importPath;
  } else if (info.isFile) {
    // Join the import path directory with the real filename from the info.
    replacement = path.join(path.dirname(importPath), path.basename(info.path));
  } else {
    // If it's a directory, call the function that checks for a `package.json` or an `index`.
    const folderReplacement = createReplacementForFolder(absPath, importPath);
    replacement = folderReplacement || importPath;
  }

  /**
   * This is a hotfix; when you use `path.join()` with a path that starts with `./`, the
   * function removes it, but that's needed for import statements: if they path doesn't
   * starts with `.`, it assumes that it's on `node_modules`.
   */
  if (
    (importPath === '.' || importPath.startsWith('./')) &&
    !replacement.startsWith('./')
  ) {
    replacement = `./${replacement}`;
  }
  return replacement;
};

/**
 * This is the transformation for `jscodeshift` the tool uses to modify import statements,
 * add missing `.mjs` extensions and change paths if needed.
 *
 * @param {FileInfo}         file     The information of the file to transform.
 * @param {API}              api      The API that expose `jscodeshift`, with utilities
 *                                    for the transformation.
 * @param {TransformOptions} options  These options are sent by `jscodeshift`, but the
 *                                    tool injected its own options so the transformation
 *                                    can access to the settings related to the extension.
 * @returns {string}
 */
const transform = (file, api, options) => {
  const j = api.jscodeshift;
  // Extract the tool options.
  const { cjs2esm } = options;
  // Get the absolute path to the file directory, so it can be joined with the imports.
  const base = path.dirname(file.path);
  // Generate the AST.
  const root = j(file.source);
  // Generate the list of expressions to ignore import statements.
  const ignoreListForExt = cjs2esm.extension.ignore.map((ignore) => new RegExp(ignore));

  /**
   * Check if path must be changed.
   *
   * @param {object} item node
   * @returns {boolean}
   */
  const needsPathUpdate = (item) => {
    const exportPath = item.value.source && item.value.source.value;
    return (
      exportPath &&
      !ignoreListForExt.some((exp) => exportPath.match(exp)) &&
      (exportPath.startsWith('.') || exportPath.match(/^\w/))
    );
  };

  // =================================================
  // Parse the import statements to add missing extensions.
  // =================================================
  root
    .find(j.ImportDeclaration)
    // Filter out the ones that are on the ignore list.
    .filter(needsPathUpdate)
    .replaceWith((item) => {
      const replacement = updatePath(item, base);

      // Replace the node with a new one on the AST.
      // return j.importDeclaration.from({ ...item.value, source: j.literal(replacement) });
      return j.importDeclaration(item.value.specifiers, j.literal(replacement));
    });
  root
    .find(j.ExportNamedDeclaration)
    // Filter out the ones that are on the ignore list.
    .filter(needsPathUpdate)
    .replaceWith((item) => {
      const replacement = updatePath(item, base);

      // Replace the node with a new one on the AST.
      return j.exportNamedDeclaration.from({
        ...item.value,
        source: j.literal(replacement),
      });
      // (
      //   item.value.declaration,
      //   item.value.specifiers,
      //   j.literal(replacement),
      // );
    });
  root
    .find(j.ExportAllDeclaration)
    // Filter out the ones that are on the ignore list.
    .filter(needsPathUpdate)
    .replaceWith((item) => {
      const replacement = updatePath(item, base);

      // Replace the node with a new one on the AST.
      return j.exportAllDeclaration.from({
        ...item.value,
        source: j.literal(replacement),
      });
    });
  // =================================================
  // Parse the modules modifications.
  // =================================================
  if (cjs2esm.modules.length) {
    const modules = cjs2esm.modules.map((r) => ({
      ...r,
      regex: new RegExp(`^${r.name}(/|$)`),
    }));

    root
      .find(j.ImportDeclaration)
      // Filter out the import statments that don't need to be modified.
      .filter((item) => {
        const importPath = item.value.source.value;
        return modules.some((mod) => mod.regex.test(importPath));
      })
      // Apply the modifications.
      .replaceWith((item) => {
        const importPath = item.value.source.value;
        const info = modules.find((mod) => importPath.startsWith(mod.name));
        const find = info.find ? new RegExp(info.find) : new RegExp(`^${info.name}`);
        const replacement = importPath.replace(find, info.path);

        return j.importDeclaration(item.value.specifiers, j.literal(replacement));
      });
    // This fails weirdly
    // root
    //   .find(j.exportNamedDeclaration)
    //   // Filter out the export statments that don't need to be modified.
    //   .filter((item) => {
    //     const exportPath = item.value.source && item.value.source.value;
    //     return exportPath && modules.some((mod) => mod.regex.test(exportPath));
    //   })
    //   // Apply the modifications.
    //   .replaceWith((item) => {
    //     const exportPath = item.value.source.value;
    //     const info = cjs2esm.modules.find((mod) => exportPath.startsWith(mod.name));
    //     const find = info.find ? new RegExp(info.find) : new RegExp(`^${info.name}`);
    //     const replacement = exportPath.replace(find, info.path);

    //     return j.exportNamedDeclaration.from({
    //       ...item.value,
    //       source: j.literal(replacement),
    //     });
    //   });
  }

  // Regenerate the file code.
  return root.toSource({
    quote: 'single',
  });
};

module.exports = transform;
