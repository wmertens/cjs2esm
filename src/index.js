const path = require('path');
const fs = require('fs-extra');
const Runner = require('jscodeshift/src/Runner');
const { repository } = require('../package.json');
const { log, findFile, getAbsPathInfo, requireModule } = require('./utils');
/**
 * This is called every time an unexpected error is thrown; it logs the error using the
 * `log`
 * function, with _nice_ colors, and adds a message to create an issue on the repository.
 *
 * @param {Error} error  The exception to _"handle"_.
 * @ignore
 */
const handleAnError = (error) => {
  const stack = error.stack.split('\n');
  const message = stack.shift();
  log('red', message);
  stack.forEach((line) => log('gray', line.trim()));
  const link = `https://github.com/${repository}/issues/new`;
  log('gray');
  log(
    'gray',
    `If the issue persist, create a ticket and I may be able to help you: ${link} :D`,
  );
};
/**
 * Adds an error handler to the process so if something fails, it will be logged with a
 * nice style and a custom emssage.
 *
 * @returns {Function} To remove the listeners.
 */
const addErrorHandler = () => {
  process.on('uncaughtException', handleAnError);
  process.on('unhandledRejection', handleAnError);
  return () => {
    process.removeListener('uncaughtException', handleAnError);
    process.removeListener('unhandledRejection', handleAnError);
  };
};
/**
 * Loads the configuration for the project.
 *
 * @returns {Promise<CJS2ESMOptions>}
 */
const getConfiguration = async () => {
  log('yellow', 'Loading configuration...');
  const cwd = process.cwd();
  const file = await findFile(['.cjs2esm', '.cjs2esm.json', '.cjs2esm.js'], cwd);

  let config = {};
  if (file === null) {
    const pkgJson = requireModule(path.join(cwd, 'package.json'));
    if (pkgJson.config && pkgJson.config.cjs2esm) {
      config = pkgJson.config.cjs2esm;
      log('green', 'Using configuration from the package.json');
    } else if (pkgJson.cjs2esm) {
      config = pkgJson.cjs2esm;
      log('green', 'Using configuration from the package.json');
    } else {
      log('gray', 'No configuration was found, using defaults...');
    }
  } else if (file.match(/\.js$/i)) {
    config = requireModule(file);
    log('green', `Configuration file found: \`${file}\``);
  } else {
    config = await fs.readJSON(file);
    log('green', `Configuration file found: \`${file}\``);
  }

  const result = {
    input: ['src'],
    output: 'esm',
    forceDirectory: null,
    modules: [],
    extension: {},
    addModuleEntry: false,
    addPackageJson: true,
    filesWithShebang: [],
    ...config,
  };

  result.extension = {
    use: 'js',
    ignore: [],
    ...result.extension,
  };

  result.input = result.input.map((item) => path.join(cwd, item));
  result.output = path.join(cwd, result.output);
  return result;
};
/**
 * Ensures the output directory exists and it's empty. If the directory exists, it removes
 * it and then creates it again.
 *
 * @param {string} output  The output directory the tool will use.
 * @returns {Promise}
 */
const ensureOutput = async (output) => {
  const exists = await fs.pathExists(output);
  if (exists) {
    await fs.remove(output);
  }

  await fs.mkdir(output);
  log('green', 'Output directory successfully cleaned');
};
/**
 * Finds all the JavaScript files on a given directory.
 *
 * @param {string} directory  The absolute path to the directory.
 * @returns {Promise<string[]>}
 * @ignore
 */
const findFiles = async (directory) => {
  let result = await fs.readdir(directory);
  result = result.filter(
    (item) => !(item === '.' || item === '..' || item === 'node_modules'),
  );
  result = await Promise.all(
    result.map(async (item) => {
      const itempath = path.join(directory, item);
      const stats = await fs.stat(itempath);
      let newItem;
      if (stats.isDirectory()) {
        newItem = await findFiles(itempath);
      } else if (item.match(/\.js$/i)) {
        newItem = itempath;
      } else {
        newItem = null;
      }

      return newItem;
    }),
  );

  result = result
    .filter((item) => item !== null)
    .reduce(
      (acc, item) => (Array.isArray(item) ? [...acc, ...item] : [...acc, item]),
      [],
    );

  return result;
};
/**
 * Copies all the files from a source directory to the output directory, changing the
 * extensions if required.
 *
 * @param {string}          directory              The source directory from where the
 *                                                 files will be copied.
 * @param {string}          output                 The output directory where the files
 *                                                 should be copied to.
 * @param {ModuleExtension} useExtension           The extension the modules should use.
 * @param {boolean}         [forceDirectory=true]  If `false`, the directory itself won't
 *                                                 be copied,
 *                                                 just its contents.
 * @returns {Promise<CJS2ESMCopiedFile[]>}
 * @ignore
 */
const copyDirectory = async (directory, output, useExtension, forceDirectory = true) => {
  const cwd = process.cwd();
  const extension = `.${useExtension}`;
  let contents = await findFiles(directory);
  contents = await Promise.all(
    contents.map(async (item) => {
      let cleanPath = item.substr(cwd.length + 1);
      if (!forceDirectory) {
        cleanPath = cleanPath.split(path.sep);
        cleanPath.shift();
        cleanPath = cleanPath.join(path.sep);
      }

      let newPath = path.join(output, cleanPath);
      const { ext } = path.parse(newPath);
      if (ext !== extension) {
        newPath = newPath.replace(new RegExp(`\\${ext}$`), extension);
      }

      await fs.ensureDir(path.dirname(newPath));
      await fs.copyFile(item, newPath);
      return {
        from: item,
        to: newPath,
      };
    }),
  );

  return contents;
};
/**
 * Copies all the files the tool will transpile.
 *
 * @param {string[]}        input           The list of source paths where the files are
 *                                          located.
 * @param {string}          output          The output path where all the files will be
 *                                          transpiled to.
 * @param {ModuleExtension} useExtension    The extension the modules should use.
 * @param {?boolean}        forceDirectory  By default, if `input` has only one directory,
 *                                          the only thing copied will be its contents,
 *                                          instead of the directory itself; this
 *                                          parameter can be used to force it and always
 *                                          copy the directory.
 * @returns {Promise<CJS2ESMCopiedFile[]>}
 */
const copyFiles = async (input, output, useExtension, forceDirectory) => {
  let result;
  if (input.length === 1) {
    const [firstInput] = input;
    result = await copyDirectory(
      firstInput,
      output,
      useExtension,
      forceDirectory === true,
    );
  } else {
    result = await Promise.all(
      input.map((item) => copyDirectory(item, output, useExtension)),
    );

    result = result.reduce((acc, item) => [...acc, ...item], []);
  }

  return result;
};
/**
 * Takes a list of copied files, opens them, find if they have a shebang and removes it,
 * saves the files and returns a dictionary with the filepath and the shebang that was
 * removed.
 * This is necessary because the jscodeshift parser can't handle shebangs, and the whole
 * process explodes when a file has one.
 *
 * @param {CJS2ESMCopiedFile[]} files  The list of copied files with shebangs.
 * @returns {Object.<string, string>} The keys are the path to the copied files and the
 *                                    values the shebangs they had.
 * @ignore
 */
const removeShebangs = async (files) => {
  const result = await Promise.all(
    files.map(async (file) => {
      let contents = await fs.readFile(file.to, 'utf-8');
      let item;
      const match = /^#!.*?$/m.exec(contents);
      if (match) {
        const [shebang] = match;
        item = {
          shebang,
          file,
        };
        contents = contents.replace(shebang, '').trimLeft();
        await fs.writeFile(file.to, contents);
      } else {
        item = null;
      }

      return item;
    }),
  );

  return result
    .filter((item) => item)
    .reduce((acc, item) => ({ ...acc, [item.file.to]: item.shebang }), {});
};
/**
 * This is a complementary function for `removeShebangs`: it's used to restore the removed
 * shebangs once the transformation process its finished.
 * The function basically opens the files, adds the shebangs and saves them.
 *
 * @param {Object.<string, string>} shebangs  The keys are the path to the copied files
 *                                            and the values the shebangs they had.
 * @returns {Promise}
 * @ignore
 */
const restoreShebangs = (shebangs) =>
  Promise.all(
    Object.keys(shebangs).map(async (filepath) => {
      const shebang = shebangs[filepath];
      let contents = await fs.readFile(filepath, 'utf-8');
      contents = `${shebang}\n\n${contents}`;
      await fs.writeFile(filepath, contents);
    }),
  );
/**
 * Transforms all files from the output directory into ES Modules.
 *
 * @param {CJS2ESMCopiedFile[]} files    The list of files that were copied to the output
 *                                       directory.
 * @param {CJS2ESMOptions}      options  The options of the tool, so they can be sent to
 *                                       the transformers.
 * @returns {Promise}
 * @throws {Error} If there's a problem while transforming a file.
 */
const transformOutput = async (files, options) => {
  const transformOptions = {
    verbose: 0,
    dry: false,
    print: false,
    babel: true,
    extension: files[0].to.match(/\.mjs$/i) ? 'mjs' : 'js',
    ignorePattern: [],
    ignoreConfig: [],
    runInBand: false,
    silent: true,
    parser: 'babel',
    cjs2esm: options,
  };

  const shebangExpressions = options.filesWithShebang.map(
    (expression) => new RegExp(expression),
  );
  const filesWithShebang = files.filter(({ from }) =>
    shebangExpressions.some((expression) => from.match(expression)),
  );

  let shebangs;
  if (filesWithShebang.length) {
    shebangs = await removeShebangs(filesWithShebang);
  }

  const fiveToSixCodeModPath = path.dirname(
    require.resolve('5to6-codemod/transforms/cjs.js'),
  );
  const transformations = [
    path.join(fiveToSixCodeModPath, 'cjs.js'),
    path.join(fiveToSixCodeModPath, 'exports.js'),
    path.join(fiveToSixCodeModPath, 'named-export-generation.js'),
    path.join(__dirname, 'transformer.js'),
  ];

  log('yellow', `Transforming ${files.length} files...`);

  const results = await transformations.reduce(
    (acc, transformation) =>
      acc.then((prevStats) =>
        Runner.run(transformation, [options.output], transformOptions).then((stats) => [
          ...prevStats,
          stats,
        ]),
      ),
    Promise.resolve([null]),
  );

  if (shebangs) {
    await restoreShebangs(shebangs);
  }

  results.shift();
  const errorIndex = results.findIndex(
    (stats) => stats.ok + stats.nochange !== files.length,
  );
  if (errorIndex > -1) {
    let transformationError = transformations[errorIndex];
    transformationError = path.parse(transformationError).name;
    throw new Error(
      `At least one file couldn't be transformed with \`${transformationError}\``,
    );
  }

  const cwd = process.cwd();
  files.forEach((file) => log('gray', `> ${file.to.substr(cwd.length + 1)}`));
  let totalTime = results.reduce(
    (acc, { timeElapsed }) => acc + parseFloat(timeElapsed),
    0.0,
  );
  const decimals = 2;
  totalTime = totalTime.toFixed(decimals);

  log('green', `All files were successfully transformed (${totalTime}s)!`);
};
/**
 * Given an absolute path for a folder, the function will try to find its "entry file": it
 * will check for `index.mjs` and `index.js`.
 *
 * @param {string} absPath  The absolute path to the folder.
 * @returns {?string} If there's no `index`, the function will return `null`.
 * @ignore
 */
const findFolderEntryPath = async (absPath) => {
  const file = await findFile(['index.mjs', 'index.js'], absPath);
  return file ? path.join(absPath, path.basename(file)) : null;
};
/**
 * Updates the project `package.json` by adding a `module` property that points to the
 * transformed version of the current `main` property.
 *
 * @param {CJS2ESMCopiedFile[]} files  The list of files that were copied, so the function
 *                                     can find the transformed path for the `main` file.
 * @returns {Promise}
 * @throws {Error} If the function can't find the transformed version of the `main`
 *                 file.
 */
const updatePackageJSON = async (files) => {
  const cwd = process.cwd();
  const pkgJsonPath = path.join(cwd, 'package.json');
  const pkgJson = requireModule(pkgJsonPath);
  let result;
  if (pkgJson.main) {
    let mainPath = path.join(cwd, pkgJson.main);
    const info = await getAbsPathInfo(mainPath);
    if (info.isFile) {
      mainPath = info.path;
    } else {
      mainPath = await findFolderEntryPath(info.path);
      if (!mainPath) {
        throw new Error(`The entry file can't be found: \`${info.path}\``);
      }
    }
    const file = files.find((item) => item.from === mainPath);
    if (file) {
      result = path.relative(cwd, file.to).replace(/^(\w)/, './$1');
      pkgJson.module = result;
      await fs.writeJSON(pkgJsonPath, pkgJson, { spaces: 2 });
      log('green', 'The module property was successfully added to the package.json!');
    } else {
      log(
        'yellow',
        'It doesnt seem like the main file was transformed, package.json update aborted',
      );
      result = null;
    }
  } else {
    log('yellow', "There's no main property, package.json update aborted");
    result = null;
  }

  return result;
};
/**
 * Adds a `package.json` with `type` set to `module` on the output directory. This is so
 * Node can properly resolve the ESM files.
 *
 * @param {string} output  The output directory the tool will use.
 * @returns {Promise}
 */
const addPackageJSON = async (output) => {
  await fs.writeJSON(
    path.join(output, 'package.json'),
    { type: 'module' },
    { spaces: 2 },
  );
  log('green', 'The packages.json for the ESM version was successfully added!');
};

module.exports.addErrorHandler = addErrorHandler;
module.exports.getConfiguration = getConfiguration;
module.exports.ensureOutput = ensureOutput;
module.exports.copyFiles = copyFiles;
module.exports.transformOutput = transformOutput;
module.exports.updatePackageJSON = updatePackageJSON;
module.exports.addPackageJSON = addPackageJSON;
