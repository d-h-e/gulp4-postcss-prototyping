#!/usr/bin/env node

/* eslint-disable max-len, flowtype/require-valid-file-annotation, flowtype/require-return-type */
/* global packageInformationStores, null, $$SETUP_STATIC_TABLES */

// Used for the resolveUnqualified part of the resolution (ie resolving folder/index.js & file extensions)
// Deconstructed so that they aren't affected by any fs monkeypatching occuring later during the execution
const {statSync, lstatSync, readlinkSync, readFileSync, existsSync, realpathSync} = require('fs');

const Module = require('module');
const path = require('path');
const StringDecoder = require('string_decoder');

const ignorePattern = null ? new RegExp(null) : null;

const pnpFile = path.resolve(__dirname, __filename);
const builtinModules = new Set(Module.builtinModules || Object.keys(process.binding('natives')));

const topLevelLocator = {name: null, reference: null};
const blacklistedLocator = {name: NaN, reference: NaN};

// Used for compatibility purposes - cf setupCompatibilityLayer
const patchedModules = [];
const fallbackLocators = [topLevelLocator];

// Matches backslashes of Windows paths
const backwardSlashRegExp = /\\/g;

// Matches if the path must point to a directory (ie ends with /)
const isDirRegExp = /\/$/;

// Matches if the path starts with a valid path qualifier (./, ../, /)
// eslint-disable-next-line no-unused-vars
const isStrictRegExp = /^\.{0,2}\//;

// Splits a require request into its components, or return null if the request is a file path
const pathRegExp = /^(?![a-zA-Z]:[\\\/]|\\\\|\.{0,2}(?:\/|$))((?:@[^\/]+\/)?[^\/]+)\/?(.*|)$/;

// Keep a reference around ("module" is a common name in this context, so better rename it to something more significant)
const pnpModule = module;

/**
 * Used to disable the resolution hooks (for when we want to fallback to the previous resolution - we then need
 * a way to "reset" the environment temporarily)
 */

let enableNativeHooks = true;

/**
 * Simple helper function that assign an error code to an error, so that it can more easily be caught and used
 * by third-parties.
 */

function makeError(code, message, data = {}) {
  const error = new Error(message);
  return Object.assign(error, {code, data});
}

/**
 * Ensures that the returned locator isn't a blacklisted one.
 *
 * Blacklisted packages are packages that cannot be used because their dependencies cannot be deduced. This only
 * happens with peer dependencies, which effectively have different sets of dependencies depending on their parents.
 *
 * In order to deambiguate those different sets of dependencies, the Yarn implementation of PnP will generate a
 * symlink for each combination of <package name>/<package version>/<dependent package> it will find, and will
 * blacklist the target of those symlinks. By doing this, we ensure that files loaded through a specific path
 * will always have the same set of dependencies, provided the symlinks are correctly preserved.
 *
 * Unfortunately, some tools do not preserve them, and when it happens PnP isn't able anymore to deduce the set of
 * dependencies based on the path of the file that makes the require calls. But since we've blacklisted those paths,
 * we're able to print a more helpful error message that points out that a third-party package is doing something
 * incompatible!
 */

// eslint-disable-next-line no-unused-vars
function blacklistCheck(locator) {
  if (locator === blacklistedLocator) {
    throw makeError(
      `BLACKLISTED`,
      [
        `A package has been resolved through a blacklisted path - this is usually caused by one of your tools calling`,
        `"realpath" on the return value of "require.resolve". Since the returned values use symlinks to disambiguate`,
        `peer dependencies, they must be passed untransformed to "require".`,
      ].join(` `),
    );
  }

  return locator;
}

let packageInformationStores = new Map([
  ["autoprefixer", new Map([
    ["9.4.10", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-autoprefixer-9.4.10-e1be61fc728bacac8f4252ed242711ec0dcc6a7b/node_modules/autoprefixer/"),
      packageDependencies: new Map([
        ["browserslist", "4.4.2"],
        ["caniuse-lite", "1.0.30000945"],
        ["normalize-range", "0.1.2"],
        ["num2fraction", "1.2.2"],
        ["postcss", "7.0.14"],
        ["postcss-value-parser", "3.3.1"],
        ["autoprefixer", "9.4.10"],
      ]),
    }],
  ])],
  ["browserslist", new Map([
    ["4.4.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-browserslist-4.4.2-6ea8a74d6464bb0bd549105f659b41197d8f0ba2/node_modules/browserslist/"),
      packageDependencies: new Map([
        ["caniuse-lite", "1.0.30000945"],
        ["electron-to-chromium", "1.3.115"],
        ["node-releases", "1.1.10"],
        ["browserslist", "4.4.2"],
      ]),
    }],
  ])],
  ["caniuse-lite", new Map([
    ["1.0.30000945", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-caniuse-lite-1.0.30000945-d51e3750416dd05126d5ac94a9c57d1c26c6fd21/node_modules/caniuse-lite/"),
      packageDependencies: new Map([
        ["caniuse-lite", "1.0.30000945"],
      ]),
    }],
  ])],
  ["electron-to-chromium", new Map([
    ["1.3.115", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-electron-to-chromium-1.3.115-fdaa56c19b9f7386dbf29abc1cc632ff5468ff3b/node_modules/electron-to-chromium/"),
      packageDependencies: new Map([
        ["electron-to-chromium", "1.3.115"],
      ]),
    }],
  ])],
  ["node-releases", new Map([
    ["1.1.10", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-node-releases-1.1.10-5dbeb6bc7f4e9c85b899e2e7adcc0635c9b2adf7/node_modules/node-releases/"),
      packageDependencies: new Map([
        ["semver", "5.6.0"],
        ["node-releases", "1.1.10"],
      ]),
    }],
  ])],
  ["semver", new Map([
    ["5.6.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-semver-5.6.0-7e74256fbaa49c75aa7c7a205cc22799cac80004/node_modules/semver/"),
      packageDependencies: new Map([
        ["semver", "5.6.0"],
      ]),
    }],
    ["5.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-semver-5.3.0-9b2ce5d3de02d17c6012ad326aa6b4d0cf54f94f/node_modules/semver/"),
      packageDependencies: new Map([
        ["semver", "5.3.0"],
      ]),
    }],
  ])],
  ["normalize-range", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-normalize-range-0.1.2-2d10c06bdfd312ea9777695a4d28439456b75942/node_modules/normalize-range/"),
      packageDependencies: new Map([
        ["normalize-range", "0.1.2"],
      ]),
    }],
  ])],
  ["num2fraction", new Map([
    ["1.2.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-num2fraction-1.2.2-6f682b6a027a4e9ddfa4564cd2589d1d4e669ede/node_modules/num2fraction/"),
      packageDependencies: new Map([
        ["num2fraction", "1.2.2"],
      ]),
    }],
  ])],
  ["postcss", new Map([
    ["7.0.14", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-postcss-7.0.14-4527ed6b1ca0d82c53ce5ec1a2041c2346bbd6e5/node_modules/postcss/"),
      packageDependencies: new Map([
        ["chalk", "2.4.2"],
        ["source-map", "0.6.1"],
        ["supports-color", "6.1.0"],
        ["postcss", "7.0.14"],
      ]),
    }],
  ])],
  ["chalk", new Map([
    ["2.4.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-chalk-2.4.2-cd42541677a54333cf541a49108c1432b44c9424/node_modules/chalk/"),
      packageDependencies: new Map([
        ["ansi-styles", "3.2.1"],
        ["escape-string-regexp", "1.0.5"],
        ["supports-color", "5.5.0"],
        ["chalk", "2.4.2"],
      ]),
    }],
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-chalk-1.1.3-a8115c55e4a702fe4d150abd3872822a7e09fc98/node_modules/chalk/"),
      packageDependencies: new Map([
        ["ansi-styles", "2.2.1"],
        ["escape-string-regexp", "1.0.5"],
        ["has-ansi", "2.0.0"],
        ["strip-ansi", "3.0.1"],
        ["supports-color", "2.0.0"],
        ["chalk", "1.1.3"],
      ]),
    }],
  ])],
  ["ansi-styles", new Map([
    ["3.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-styles-3.2.1-41fbb20243e50b12be0f04b8dedbf07520ce841d/node_modules/ansi-styles/"),
      packageDependencies: new Map([
        ["color-convert", "1.9.3"],
        ["ansi-styles", "3.2.1"],
      ]),
    }],
    ["2.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-styles-2.2.1-b432dd3358b634cf75e1e4664368240533c1ddbe/node_modules/ansi-styles/"),
      packageDependencies: new Map([
        ["ansi-styles", "2.2.1"],
      ]),
    }],
  ])],
  ["color-convert", new Map([
    ["1.9.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-color-convert-1.9.3-bb71850690e1f136567de629d2d5471deda4c1e8/node_modules/color-convert/"),
      packageDependencies: new Map([
        ["color-name", "1.1.3"],
        ["color-convert", "1.9.3"],
      ]),
    }],
  ])],
  ["color-name", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-color-name-1.1.3-a7d0558bd89c42f795dd42328f740831ca53bc25/node_modules/color-name/"),
      packageDependencies: new Map([
        ["color-name", "1.1.3"],
      ]),
    }],
  ])],
  ["escape-string-regexp", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-escape-string-regexp-1.0.5-1b61c0562190a8dff6ae3bb2cf0200ca130b86d4/node_modules/escape-string-regexp/"),
      packageDependencies: new Map([
        ["escape-string-regexp", "1.0.5"],
      ]),
    }],
  ])],
  ["supports-color", new Map([
    ["5.5.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-supports-color-5.5.0-e2e69a44ac8772f78a1ec0b35b689df6530efc8f/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
        ["supports-color", "5.5.0"],
      ]),
    }],
    ["6.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-supports-color-6.1.0-0764abc69c63d5ac842dd4867e8d025e880df8f3/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
        ["supports-color", "6.1.0"],
      ]),
    }],
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-supports-color-2.0.0-535d045ce6b6363fa40117084629995e9df324c7/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["supports-color", "2.0.0"],
      ]),
    }],
  ])],
  ["has-flag", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-flag-3.0.0-b5d454dc2199ae225699f3467e5a07f3b955bafd/node_modules/has-flag/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
      ]),
    }],
  ])],
  ["source-map", new Map([
    ["0.6.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-source-map-0.6.1-74722af32e9614e9c287a8d0bbde48b5e2f1a263/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.6.1"],
      ]),
    }],
    ["0.5.7", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-source-map-0.5.7-8a039d2d1021d22d1ea14c80d8ea468ba2ef3fcc/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.5.7"],
      ]),
    }],
    ["0.4.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-source-map-0.4.4-eba4f5da9c0dc999de68032d8b4f76173652036b/node_modules/source-map/"),
      packageDependencies: new Map([
        ["amdefine", "1.0.1"],
        ["source-map", "0.4.4"],
      ]),
    }],
  ])],
  ["postcss-value-parser", new Map([
    ["3.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-postcss-value-parser-3.3.1-9ff822547e2893213cf1c30efa51ac5fd1ba8281/node_modules/postcss-value-parser/"),
      packageDependencies: new Map([
        ["postcss-value-parser", "3.3.1"],
      ]),
    }],
  ])],
  ["browser-sync", new Map([
    ["2.26.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-browser-sync-2.26.3-1b59bd5935938a5b0fa73b3d78ef1050bd2bf912/node_modules/browser-sync/"),
      packageDependencies: new Map([
        ["browser-sync-client", "2.26.2"],
        ["browser-sync-ui", "2.26.2"],
        ["bs-recipes", "1.3.4"],
        ["bs-snippet-injector", "2.0.1"],
        ["chokidar", "2.1.2"],
        ["connect", "3.6.6"],
        ["connect-history-api-fallback", "1.6.0"],
        ["dev-ip", "1.0.1"],
        ["easy-extender", "2.3.4"],
        ["eazy-logger", "3.0.2"],
        ["etag", "1.8.1"],
        ["fresh", "0.5.2"],
        ["fs-extra", "3.0.1"],
        ["http-proxy", "1.15.2"],
        ["immutable", "3.8.2"],
        ["localtunnel", "1.9.1"],
        ["micromatch", "2.3.11"],
        ["opn", "5.3.0"],
        ["portscanner", "2.1.1"],
        ["qs", "6.2.3"],
        ["raw-body", "2.3.3"],
        ["resp-modifier", "6.0.2"],
        ["rx", "4.1.0"],
        ["send", "0.16.2"],
        ["serve-index", "1.9.1"],
        ["serve-static", "1.13.2"],
        ["server-destroy", "1.0.1"],
        ["socket.io", "2.1.1"],
        ["ua-parser-js", "0.7.17"],
        ["yargs", "6.4.0"],
        ["browser-sync", "2.26.3"],
      ]),
    }],
  ])],
  ["browser-sync-client", new Map([
    ["2.26.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-browser-sync-client-2.26.2-dd0070c80bdc6d9021e89f7837ee70ed0a8acf91/node_modules/browser-sync-client/"),
      packageDependencies: new Map([
        ["etag", "1.8.1"],
        ["fresh", "0.5.2"],
        ["mitt", "1.1.3"],
        ["rxjs", "5.5.12"],
        ["browser-sync-client", "2.26.2"],
      ]),
    }],
  ])],
  ["etag", new Map([
    ["1.8.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-etag-1.8.1-41ae2eeb65efa62268aebfea83ac7d79299b0887/node_modules/etag/"),
      packageDependencies: new Map([
        ["etag", "1.8.1"],
      ]),
    }],
  ])],
  ["fresh", new Map([
    ["0.5.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fresh-0.5.2-3d8cadd90d976569fa835ab1f8e4b23a105605a7/node_modules/fresh/"),
      packageDependencies: new Map([
        ["fresh", "0.5.2"],
      ]),
    }],
  ])],
  ["mitt", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mitt-1.1.3-528c506238a05dce11cd914a741ea2cc332da9b8/node_modules/mitt/"),
      packageDependencies: new Map([
        ["mitt", "1.1.3"],
      ]),
    }],
  ])],
  ["rxjs", new Map([
    ["5.5.12", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-rxjs-5.5.12-6fa61b8a77c3d793dbaf270bee2f43f652d741cc/node_modules/rxjs/"),
      packageDependencies: new Map([
        ["symbol-observable", "1.0.1"],
        ["rxjs", "5.5.12"],
      ]),
    }],
  ])],
  ["symbol-observable", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-symbol-observable-1.0.1-8340fc4702c3122df5d22288f88283f513d3fdd4/node_modules/symbol-observable/"),
      packageDependencies: new Map([
        ["symbol-observable", "1.0.1"],
      ]),
    }],
  ])],
  ["browser-sync-ui", new Map([
    ["2.26.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-browser-sync-ui-2.26.2-a1d8e107cfed5849d77e3bbd84ae5d566beb4ea0/node_modules/browser-sync-ui/"),
      packageDependencies: new Map([
        ["async-each-series", "0.1.1"],
        ["connect-history-api-fallback", "1.6.0"],
        ["immutable", "3.8.2"],
        ["server-destroy", "1.0.1"],
        ["socket.io-client", "2.2.0"],
        ["stream-throttle", "0.1.3"],
        ["browser-sync-ui", "2.26.2"],
      ]),
    }],
  ])],
  ["async-each-series", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-each-series-0.1.1-7617c1917401fd8ca4a28aadce3dbae98afeb432/node_modules/async-each-series/"),
      packageDependencies: new Map([
        ["async-each-series", "0.1.1"],
      ]),
    }],
  ])],
  ["connect-history-api-fallback", new Map([
    ["1.6.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-connect-history-api-fallback-1.6.0-8b32089359308d111115d81cad3fceab888f97bc/node_modules/connect-history-api-fallback/"),
      packageDependencies: new Map([
        ["connect-history-api-fallback", "1.6.0"],
      ]),
    }],
  ])],
  ["immutable", new Map([
    ["3.8.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-immutable-3.8.2-c2439951455bb39913daf281376f1530e104adf3/node_modules/immutable/"),
      packageDependencies: new Map([
        ["immutable", "3.8.2"],
      ]),
    }],
  ])],
  ["server-destroy", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-server-destroy-1.0.1-f13bf928e42b9c3e79383e61cc3998b5d14e6cdd/node_modules/server-destroy/"),
      packageDependencies: new Map([
        ["server-destroy", "1.0.1"],
      ]),
    }],
  ])],
  ["socket.io-client", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-socket-io-client-2.2.0-84e73ee3c43d5020ccc1a258faeeb9aec2723af7/node_modules/socket.io-client/"),
      packageDependencies: new Map([
        ["backo2", "1.0.2"],
        ["base64-arraybuffer", "0.1.5"],
        ["component-bind", "1.0.0"],
        ["component-emitter", "1.2.1"],
        ["debug", "3.1.0"],
        ["engine.io-client", "3.3.2"],
        ["has-binary2", "1.0.3"],
        ["has-cors", "1.1.0"],
        ["indexof", "0.0.1"],
        ["object-component", "0.0.3"],
        ["parseqs", "0.0.5"],
        ["parseuri", "0.0.5"],
        ["socket.io-parser", "3.3.0"],
        ["to-array", "0.1.4"],
        ["socket.io-client", "2.2.0"],
      ]),
    }],
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-socket-io-client-2.1.1-dcb38103436ab4578ddb026638ae2f21b623671f/node_modules/socket.io-client/"),
      packageDependencies: new Map([
        ["backo2", "1.0.2"],
        ["base64-arraybuffer", "0.1.5"],
        ["component-bind", "1.0.0"],
        ["component-emitter", "1.2.1"],
        ["debug", "3.1.0"],
        ["engine.io-client", "3.2.1"],
        ["has-binary2", "1.0.3"],
        ["has-cors", "1.1.0"],
        ["indexof", "0.0.1"],
        ["object-component", "0.0.3"],
        ["parseqs", "0.0.5"],
        ["parseuri", "0.0.5"],
        ["socket.io-parser", "3.2.0"],
        ["to-array", "0.1.4"],
        ["socket.io-client", "2.1.1"],
      ]),
    }],
  ])],
  ["backo2", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-backo2-1.0.2-31ab1ac8b129363463e35b3ebb69f4dfcfba7947/node_modules/backo2/"),
      packageDependencies: new Map([
        ["backo2", "1.0.2"],
      ]),
    }],
  ])],
  ["base64-arraybuffer", new Map([
    ["0.1.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-base64-arraybuffer-0.1.5-73926771923b5a19747ad666aa5cd4bf9c6e9ce8/node_modules/base64-arraybuffer/"),
      packageDependencies: new Map([
        ["base64-arraybuffer", "0.1.5"],
      ]),
    }],
  ])],
  ["component-bind", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-component-bind-1.0.0-00c608ab7dcd93897c0009651b1d3a8e1e73bbd1/node_modules/component-bind/"),
      packageDependencies: new Map([
        ["component-bind", "1.0.0"],
      ]),
    }],
  ])],
  ["component-emitter", new Map([
    ["1.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-component-emitter-1.2.1-137918d6d78283f7df7a6b7c5a63e140e69425e6/node_modules/component-emitter/"),
      packageDependencies: new Map([
        ["component-emitter", "1.2.1"],
      ]),
    }],
  ])],
  ["debug", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-debug-3.1.0-5bb5a0672628b64149566ba16819e61518c67261/node_modules/debug/"),
      packageDependencies: new Map([
        ["ms", "2.0.0"],
        ["debug", "3.1.0"],
      ]),
    }],
    ["2.6.9", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-debug-2.6.9-5d128515df134ff327e90a4c93f4e077a536341f/node_modules/debug/"),
      packageDependencies: new Map([
        ["ms", "2.0.0"],
        ["debug", "2.6.9"],
      ]),
    }],
    ["3.2.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-debug-3.2.6-e83d17de16d8a7efb7717edbe5fb10135eee629b/node_modules/debug/"),
      packageDependencies: new Map([
        ["ms", "2.1.1"],
        ["debug", "3.2.6"],
      ]),
    }],
  ])],
  ["ms", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ms-2.0.0-5608aeadfc00be6c2901df5f9861788de0d597c8/node_modules/ms/"),
      packageDependencies: new Map([
        ["ms", "2.0.0"],
      ]),
    }],
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ms-2.1.1-30a5864eb3ebb0a66f2ebe6d727af06a09d86e0a/node_modules/ms/"),
      packageDependencies: new Map([
        ["ms", "2.1.1"],
      ]),
    }],
  ])],
  ["engine.io-client", new Map([
    ["3.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-engine-io-client-3.3.2-04e068798d75beda14375a264bb3d742d7bc33aa/node_modules/engine.io-client/"),
      packageDependencies: new Map([
        ["component-emitter", "1.2.1"],
        ["component-inherit", "0.0.3"],
        ["debug", "3.1.0"],
        ["engine.io-parser", "2.1.3"],
        ["has-cors", "1.1.0"],
        ["indexof", "0.0.1"],
        ["parseqs", "0.0.5"],
        ["parseuri", "0.0.5"],
        ["ws", "6.1.4"],
        ["xmlhttprequest-ssl", "1.5.5"],
        ["yeast", "0.1.2"],
        ["engine.io-client", "3.3.2"],
      ]),
    }],
    ["3.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-engine-io-client-3.2.1-6f54c0475de487158a1a7c77d10178708b6add36/node_modules/engine.io-client/"),
      packageDependencies: new Map([
        ["component-emitter", "1.2.1"],
        ["component-inherit", "0.0.3"],
        ["debug", "3.1.0"],
        ["engine.io-parser", "2.1.3"],
        ["has-cors", "1.1.0"],
        ["indexof", "0.0.1"],
        ["parseqs", "0.0.5"],
        ["parseuri", "0.0.5"],
        ["ws", "3.3.3"],
        ["xmlhttprequest-ssl", "1.5.5"],
        ["yeast", "0.1.2"],
        ["engine.io-client", "3.2.1"],
      ]),
    }],
  ])],
  ["component-inherit", new Map([
    ["0.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-component-inherit-0.0.3-645fc4adf58b72b649d5cae65135619db26ff143/node_modules/component-inherit/"),
      packageDependencies: new Map([
        ["component-inherit", "0.0.3"],
      ]),
    }],
  ])],
  ["engine.io-parser", new Map([
    ["2.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-engine-io-parser-2.1.3-757ab970fbf2dfb32c7b74b033216d5739ef79a6/node_modules/engine.io-parser/"),
      packageDependencies: new Map([
        ["after", "0.8.2"],
        ["arraybuffer.slice", "0.0.7"],
        ["base64-arraybuffer", "0.1.5"],
        ["blob", "0.0.5"],
        ["has-binary2", "1.0.3"],
        ["engine.io-parser", "2.1.3"],
      ]),
    }],
  ])],
  ["after", new Map([
    ["0.8.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-after-0.8.2-fedb394f9f0e02aa9768e702bda23b505fae7e1f/node_modules/after/"),
      packageDependencies: new Map([
        ["after", "0.8.2"],
      ]),
    }],
  ])],
  ["arraybuffer.slice", new Map([
    ["0.0.7", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arraybuffer-slice-0.0.7-3bbc4275dd584cc1b10809b89d4e8b63a69e7675/node_modules/arraybuffer.slice/"),
      packageDependencies: new Map([
        ["arraybuffer.slice", "0.0.7"],
      ]),
    }],
  ])],
  ["blob", new Map([
    ["0.0.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-blob-0.0.5-d680eeef25f8cd91ad533f5b01eed48e64caf683/node_modules/blob/"),
      packageDependencies: new Map([
        ["blob", "0.0.5"],
      ]),
    }],
  ])],
  ["has-binary2", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-binary2-1.0.3-7776ac627f3ea77250cfc332dab7ddf5e4f5d11d/node_modules/has-binary2/"),
      packageDependencies: new Map([
        ["isarray", "2.0.1"],
        ["has-binary2", "1.0.3"],
      ]),
    }],
  ])],
  ["isarray", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-isarray-2.0.1-a37d94ed9cda2d59865c9f76fe596ee1f338741e/node_modules/isarray/"),
      packageDependencies: new Map([
        ["isarray", "2.0.1"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-isarray-1.0.0-bb935d48582cba168c06834957a54a3e07124f11/node_modules/isarray/"),
      packageDependencies: new Map([
        ["isarray", "1.0.0"],
      ]),
    }],
  ])],
  ["has-cors", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-cors-1.1.0-5e474793f7ea9843d1bb99c23eef49ff126fff39/node_modules/has-cors/"),
      packageDependencies: new Map([
        ["has-cors", "1.1.0"],
      ]),
    }],
  ])],
  ["indexof", new Map([
    ["0.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-indexof-0.0.1-82dc336d232b9062179d05ab3293a66059fd435d/node_modules/indexof/"),
      packageDependencies: new Map([
        ["indexof", "0.0.1"],
      ]),
    }],
  ])],
  ["parseqs", new Map([
    ["0.0.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parseqs-0.0.5-d5208a3738e46766e291ba2ea173684921a8b89d/node_modules/parseqs/"),
      packageDependencies: new Map([
        ["better-assert", "1.0.2"],
        ["parseqs", "0.0.5"],
      ]),
    }],
  ])],
  ["better-assert", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-better-assert-1.0.2-40866b9e1b9e0b55b481894311e68faffaebc522/node_modules/better-assert/"),
      packageDependencies: new Map([
        ["callsite", "1.0.0"],
        ["better-assert", "1.0.2"],
      ]),
    }],
  ])],
  ["callsite", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-callsite-1.0.0-280398e5d664bd74038b6f0905153e6e8af1bc20/node_modules/callsite/"),
      packageDependencies: new Map([
        ["callsite", "1.0.0"],
      ]),
    }],
  ])],
  ["parseuri", new Map([
    ["0.0.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parseuri-0.0.5-80204a50d4dbb779bfdc6ebe2778d90e4bce320a/node_modules/parseuri/"),
      packageDependencies: new Map([
        ["better-assert", "1.0.2"],
        ["parseuri", "0.0.5"],
      ]),
    }],
  ])],
  ["ws", new Map([
    ["6.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ws-6.1.4-5b5c8800afab925e94ccb29d153c8d02c1776ef9/node_modules/ws/"),
      packageDependencies: new Map([
        ["async-limiter", "1.0.0"],
        ["ws", "6.1.4"],
      ]),
    }],
    ["3.3.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ws-3.3.3-f1cf84fe2d5e901ebce94efaece785f187a228f2/node_modules/ws/"),
      packageDependencies: new Map([
        ["async-limiter", "1.0.0"],
        ["safe-buffer", "5.1.2"],
        ["ultron", "1.1.1"],
        ["ws", "3.3.3"],
      ]),
    }],
  ])],
  ["async-limiter", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-limiter-1.0.0-78faed8c3d074ab81f22b4e985d79e8738f720f8/node_modules/async-limiter/"),
      packageDependencies: new Map([
        ["async-limiter", "1.0.0"],
      ]),
    }],
  ])],
  ["xmlhttprequest-ssl", new Map([
    ["1.5.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-xmlhttprequest-ssl-1.5.5-c2876b06168aadc40e57d97e81191ac8f4398b3e/node_modules/xmlhttprequest-ssl/"),
      packageDependencies: new Map([
        ["xmlhttprequest-ssl", "1.5.5"],
      ]),
    }],
  ])],
  ["yeast", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yeast-0.1.2-008e06d8094320c372dbc2f8ed76a0ca6c8ac419/node_modules/yeast/"),
      packageDependencies: new Map([
        ["yeast", "0.1.2"],
      ]),
    }],
  ])],
  ["object-component", new Map([
    ["0.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-component-0.0.3-f0c69aa50efc95b866c186f400a33769cb2f1291/node_modules/object-component/"),
      packageDependencies: new Map([
        ["object-component", "0.0.3"],
      ]),
    }],
  ])],
  ["socket.io-parser", new Map([
    ["3.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-socket-io-parser-3.3.0-2b52a96a509fdf31440ba40fed6094c7d4f1262f/node_modules/socket.io-parser/"),
      packageDependencies: new Map([
        ["component-emitter", "1.2.1"],
        ["debug", "3.1.0"],
        ["isarray", "2.0.1"],
        ["socket.io-parser", "3.3.0"],
      ]),
    }],
    ["3.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-socket-io-parser-3.2.0-e7c6228b6aa1f814e6148aea325b51aa9499e077/node_modules/socket.io-parser/"),
      packageDependencies: new Map([
        ["component-emitter", "1.2.1"],
        ["debug", "3.1.0"],
        ["isarray", "2.0.1"],
        ["socket.io-parser", "3.2.0"],
      ]),
    }],
  ])],
  ["to-array", new Map([
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-to-array-0.1.4-17e6c11f73dd4f3d74cda7a4ff3238e9ad9bf890/node_modules/to-array/"),
      packageDependencies: new Map([
        ["to-array", "0.1.4"],
      ]),
    }],
  ])],
  ["stream-throttle", new Map([
    ["0.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-stream-throttle-0.1.3-add57c8d7cc73a81630d31cd55d3961cfafba9c3/node_modules/stream-throttle/"),
      packageDependencies: new Map([
        ["commander", "2.19.0"],
        ["limiter", "1.1.4"],
        ["stream-throttle", "0.1.3"],
      ]),
    }],
  ])],
  ["commander", new Map([
    ["2.19.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-commander-2.19.0-f6198aa84e5b83c46054b94ddedbfed5ee9ff12a/node_modules/commander/"),
      packageDependencies: new Map([
        ["commander", "2.19.0"],
      ]),
    }],
  ])],
  ["limiter", new Map([
    ["1.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-limiter-1.1.4-87c9c3972d389fdb0ba67a45aadbc5d2f8413bc1/node_modules/limiter/"),
      packageDependencies: new Map([
        ["limiter", "1.1.4"],
      ]),
    }],
  ])],
  ["bs-recipes", new Map([
    ["1.3.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-bs-recipes-1.3.4-0d2d4d48a718c8c044769fdc4f89592dc8b69585/node_modules/bs-recipes/"),
      packageDependencies: new Map([
        ["bs-recipes", "1.3.4"],
      ]),
    }],
  ])],
  ["bs-snippet-injector", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-bs-snippet-injector-2.0.1-61b5393f11f52559ed120693100343b6edb04dd5/node_modules/bs-snippet-injector/"),
      packageDependencies: new Map([
        ["bs-snippet-injector", "2.0.1"],
      ]),
    }],
  ])],
  ["chokidar", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-chokidar-2.1.2-9c23ea40b01638439e0513864d362aeacc5ad058/node_modules/chokidar/"),
      packageDependencies: new Map([
        ["anymatch", "2.0.0"],
        ["async-each", "1.0.1"],
        ["braces", "2.3.2"],
        ["glob-parent", "3.1.0"],
        ["inherits", "2.0.3"],
        ["is-binary-path", "1.0.1"],
        ["is-glob", "4.0.0"],
        ["normalize-path", "3.0.0"],
        ["path-is-absolute", "1.0.1"],
        ["readdirp", "2.2.1"],
        ["upath", "1.1.2"],
        ["chokidar", "2.1.2"],
      ]),
    }],
  ])],
  ["anymatch", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-anymatch-2.0.0-bcb24b4f37934d9aa7ac17b4adaf89e7c76ef2eb/node_modules/anymatch/"),
      packageDependencies: new Map([
        ["micromatch", "3.1.10"],
        ["normalize-path", "2.1.1"],
        ["anymatch", "2.0.0"],
      ]),
    }],
  ])],
  ["micromatch", new Map([
    ["3.1.10", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-micromatch-3.1.10-70859bc95c9840952f359a068a3fc49f9ecfac23/node_modules/micromatch/"),
      packageDependencies: new Map([
        ["arr-diff", "4.0.0"],
        ["array-unique", "0.3.2"],
        ["braces", "2.3.2"],
        ["define-property", "2.0.2"],
        ["extend-shallow", "3.0.2"],
        ["extglob", "2.0.4"],
        ["fragment-cache", "0.2.1"],
        ["kind-of", "6.0.2"],
        ["nanomatch", "1.2.13"],
        ["object.pick", "1.3.0"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["micromatch", "3.1.10"],
      ]),
    }],
    ["2.3.11", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-micromatch-2.3.11-86677c97d1720b363431d04d0d15293bd38c1565/node_modules/micromatch/"),
      packageDependencies: new Map([
        ["arr-diff", "2.0.0"],
        ["array-unique", "0.2.1"],
        ["braces", "1.8.5"],
        ["expand-brackets", "0.1.5"],
        ["extglob", "0.3.2"],
        ["filename-regex", "2.0.1"],
        ["is-extglob", "1.0.0"],
        ["is-glob", "2.0.1"],
        ["kind-of", "3.2.2"],
        ["normalize-path", "2.1.1"],
        ["object.omit", "2.0.1"],
        ["parse-glob", "3.0.4"],
        ["regex-cache", "0.4.4"],
        ["micromatch", "2.3.11"],
      ]),
    }],
  ])],
  ["arr-diff", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-diff-4.0.0-d6461074febfec71e7e15235761a329a5dc7c520/node_modules/arr-diff/"),
      packageDependencies: new Map([
        ["arr-diff", "4.0.0"],
      ]),
    }],
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-diff-2.0.0-8f3b827f955a8bd669697e4a4256ac3ceae356cf/node_modules/arr-diff/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
        ["arr-diff", "2.0.0"],
      ]),
    }],
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-diff-1.1.0-687c32758163588fef7de7b36fabe495eb1a399a/node_modules/arr-diff/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
        ["array-slice", "0.2.3"],
        ["arr-diff", "1.1.0"],
      ]),
    }],
  ])],
  ["array-unique", new Map([
    ["0.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-unique-0.3.2-a894b75d4bc4f6cd679ef3244a9fd8f46ae2d428/node_modules/array-unique/"),
      packageDependencies: new Map([
        ["array-unique", "0.3.2"],
      ]),
    }],
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-unique-0.2.1-a1d97ccafcbc2625cc70fadceb36a50c58b01a53/node_modules/array-unique/"),
      packageDependencies: new Map([
        ["array-unique", "0.2.1"],
      ]),
    }],
  ])],
  ["braces", new Map([
    ["2.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-braces-2.3.2-5979fd3f14cd531565e5fa2df1abfff1dfaee729/node_modules/braces/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
        ["array-unique", "0.3.2"],
        ["extend-shallow", "2.0.1"],
        ["fill-range", "4.0.0"],
        ["isobject", "3.0.1"],
        ["repeat-element", "1.1.3"],
        ["snapdragon", "0.8.2"],
        ["snapdragon-node", "2.1.1"],
        ["split-string", "3.1.0"],
        ["to-regex", "3.0.2"],
        ["braces", "2.3.2"],
      ]),
    }],
    ["1.8.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-braces-1.8.5-ba77962e12dff969d6b76711e914b737857bf6a7/node_modules/braces/"),
      packageDependencies: new Map([
        ["expand-range", "1.8.2"],
        ["preserve", "0.2.0"],
        ["repeat-element", "1.1.3"],
        ["braces", "1.8.5"],
      ]),
    }],
  ])],
  ["arr-flatten", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-flatten-1.1.0-36048bbff4e7b47e136644316c99669ea5ae91f1/node_modules/arr-flatten/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
      ]),
    }],
  ])],
  ["extend-shallow", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extend-shallow-2.0.1-51af7d614ad9a9f610ea1bafbb989d6b1c56890f/node_modules/extend-shallow/"),
      packageDependencies: new Map([
        ["is-extendable", "0.1.1"],
        ["extend-shallow", "2.0.1"],
      ]),
    }],
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extend-shallow-3.0.2-26a71aaf073b39fb2127172746131c2704028db8/node_modules/extend-shallow/"),
      packageDependencies: new Map([
        ["assign-symbols", "1.0.0"],
        ["is-extendable", "1.0.1"],
        ["extend-shallow", "3.0.2"],
      ]),
    }],
    ["1.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extend-shallow-1.1.4-19d6bf94dfc09d76ba711f39b872d21ff4dd9071/node_modules/extend-shallow/"),
      packageDependencies: new Map([
        ["kind-of", "1.1.0"],
        ["extend-shallow", "1.1.4"],
      ]),
    }],
  ])],
  ["is-extendable", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-extendable-0.1.1-62b110e289a471418e3ec36a617d472e301dfc89/node_modules/is-extendable/"),
      packageDependencies: new Map([
        ["is-extendable", "0.1.1"],
      ]),
    }],
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-extendable-1.0.1-a7470f9e426733d81bd81e1155264e3a3507cab4/node_modules/is-extendable/"),
      packageDependencies: new Map([
        ["is-plain-object", "2.0.4"],
        ["is-extendable", "1.0.1"],
      ]),
    }],
  ])],
  ["fill-range", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fill-range-4.0.0-d544811d428f98eb06a63dc402d2403c328c38f7/node_modules/fill-range/"),
      packageDependencies: new Map([
        ["extend-shallow", "2.0.1"],
        ["is-number", "3.0.0"],
        ["repeat-string", "1.6.1"],
        ["to-regex-range", "2.1.1"],
        ["fill-range", "4.0.0"],
      ]),
    }],
    ["2.2.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fill-range-2.2.4-eb1e773abb056dcd8df2bfdf6af59b8b3a936565/node_modules/fill-range/"),
      packageDependencies: new Map([
        ["is-number", "2.1.0"],
        ["isobject", "2.1.0"],
        ["randomatic", "3.1.1"],
        ["repeat-element", "1.1.3"],
        ["repeat-string", "1.6.1"],
        ["fill-range", "2.2.4"],
      ]),
    }],
  ])],
  ["is-number", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-number-3.0.0-24fd6201a4782cf50561c810276afc7d12d71195/node_modules/is-number/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-number", "3.0.0"],
      ]),
    }],
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-number-2.1.0-01fcbbb393463a548f2f466cce16dece49db908f/node_modules/is-number/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-number", "2.1.0"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-number-4.0.0-0026e37f5454d73e356dfe6564699867c6a7f0ff/node_modules/is-number/"),
      packageDependencies: new Map([
        ["is-number", "4.0.0"],
      ]),
    }],
  ])],
  ["kind-of", new Map([
    ["3.2.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-kind-of-3.2.2-31ea21a734bab9bbb0f32466d893aea51e4a3c64/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
        ["kind-of", "3.2.2"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-kind-of-4.0.0-20813df3d712928b207378691a45066fae72dd57/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
        ["kind-of", "4.0.0"],
      ]),
    }],
    ["5.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-kind-of-5.1.0-729c91e2d857b7a419a1f9aa65685c4c33f5845d/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["kind-of", "5.1.0"],
      ]),
    }],
    ["6.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-kind-of-6.0.2-01146b36a6218e64e58f3a8d66de5d7fc6f6d051/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
      ]),
    }],
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-kind-of-1.1.0-140a3d2d41a36d2efcfa9377b62c24f8495a5c44/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["kind-of", "1.1.0"],
      ]),
    }],
  ])],
  ["is-buffer", new Map([
    ["1.1.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-buffer-1.1.6-efaa2ea9daa0d7ab2ea13a97b2b8ad51fefbe8be/node_modules/is-buffer/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
      ]),
    }],
  ])],
  ["repeat-string", new Map([
    ["1.6.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-repeat-string-1.6.1-8dcae470e1c88abc2d600fff4a776286da75e637/node_modules/repeat-string/"),
      packageDependencies: new Map([
        ["repeat-string", "1.6.1"],
      ]),
    }],
  ])],
  ["to-regex-range", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-to-regex-range-2.1.1-7c80c17b9dfebe599e27367e0d4dd5590141db38/node_modules/to-regex-range/"),
      packageDependencies: new Map([
        ["is-number", "3.0.0"],
        ["repeat-string", "1.6.1"],
        ["to-regex-range", "2.1.1"],
      ]),
    }],
  ])],
  ["isobject", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-isobject-3.0.1-4e431e92b11a9731636aa1f9c8d1ccbcfdab78df/node_modules/isobject/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
      ]),
    }],
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-isobject-2.1.0-f065561096a3f1da2ef46272f815c840d87e0c89/node_modules/isobject/"),
      packageDependencies: new Map([
        ["isarray", "1.0.0"],
        ["isobject", "2.1.0"],
      ]),
    }],
  ])],
  ["repeat-element", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-repeat-element-1.1.3-782e0d825c0c5a3bb39731f84efee6b742e6b1ce/node_modules/repeat-element/"),
      packageDependencies: new Map([
        ["repeat-element", "1.1.3"],
      ]),
    }],
  ])],
  ["snapdragon", new Map([
    ["0.8.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-snapdragon-0.8.2-64922e7c565b0e14204ba1aa7d6964278d25182d/node_modules/snapdragon/"),
      packageDependencies: new Map([
        ["base", "0.11.2"],
        ["debug", "2.6.9"],
        ["define-property", "0.2.5"],
        ["extend-shallow", "2.0.1"],
        ["map-cache", "0.2.2"],
        ["source-map", "0.5.7"],
        ["source-map-resolve", "0.5.2"],
        ["use", "3.1.1"],
        ["snapdragon", "0.8.2"],
      ]),
    }],
  ])],
  ["base", new Map([
    ["0.11.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-base-0.11.2-7bde5ced145b6d551a90db87f83c558b4eb48a8f/node_modules/base/"),
      packageDependencies: new Map([
        ["cache-base", "1.0.1"],
        ["class-utils", "0.3.6"],
        ["component-emitter", "1.2.1"],
        ["define-property", "1.0.0"],
        ["isobject", "3.0.1"],
        ["mixin-deep", "1.3.1"],
        ["pascalcase", "0.1.1"],
        ["base", "0.11.2"],
      ]),
    }],
  ])],
  ["cache-base", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-cache-base-1.0.1-0a7f46416831c8b662ee36fe4e7c59d76f666ab2/node_modules/cache-base/"),
      packageDependencies: new Map([
        ["collection-visit", "1.0.0"],
        ["component-emitter", "1.2.1"],
        ["get-value", "2.0.6"],
        ["has-value", "1.0.0"],
        ["isobject", "3.0.1"],
        ["set-value", "2.0.0"],
        ["to-object-path", "0.3.0"],
        ["union-value", "1.0.0"],
        ["unset-value", "1.0.0"],
        ["cache-base", "1.0.1"],
      ]),
    }],
  ])],
  ["collection-visit", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-collection-visit-1.0.0-4bc0373c164bc3291b4d368c829cf1a80a59dca0/node_modules/collection-visit/"),
      packageDependencies: new Map([
        ["map-visit", "1.0.0"],
        ["object-visit", "1.0.1"],
        ["collection-visit", "1.0.0"],
      ]),
    }],
  ])],
  ["map-visit", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-map-visit-1.0.0-ecdca8f13144e660f1b5bd41f12f3479d98dfb8f/node_modules/map-visit/"),
      packageDependencies: new Map([
        ["object-visit", "1.0.1"],
        ["map-visit", "1.0.0"],
      ]),
    }],
  ])],
  ["object-visit", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-visit-1.0.1-f79c4493af0c5377b59fe39d395e41042dd045bb/node_modules/object-visit/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
        ["object-visit", "1.0.1"],
      ]),
    }],
  ])],
  ["get-value", new Map([
    ["2.0.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-get-value-2.0.6-dc15ca1c672387ca76bd37ac0a395ba2042a2c28/node_modules/get-value/"),
      packageDependencies: new Map([
        ["get-value", "2.0.6"],
      ]),
    }],
  ])],
  ["has-value", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-value-1.0.0-18b281da585b1c5c51def24c930ed29a0be6b177/node_modules/has-value/"),
      packageDependencies: new Map([
        ["get-value", "2.0.6"],
        ["has-values", "1.0.0"],
        ["isobject", "3.0.1"],
        ["has-value", "1.0.0"],
      ]),
    }],
    ["0.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-value-0.3.1-7b1f58bada62ca827ec0a2078025654845995e1f/node_modules/has-value/"),
      packageDependencies: new Map([
        ["get-value", "2.0.6"],
        ["has-values", "0.1.4"],
        ["isobject", "2.1.0"],
        ["has-value", "0.3.1"],
      ]),
    }],
  ])],
  ["has-values", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-values-1.0.0-95b0b63fec2146619a6fe57fe75628d5a39efe4f/node_modules/has-values/"),
      packageDependencies: new Map([
        ["is-number", "3.0.0"],
        ["kind-of", "4.0.0"],
        ["has-values", "1.0.0"],
      ]),
    }],
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-values-0.1.4-6d61de95d91dfca9b9a02089ad384bff8f62b771/node_modules/has-values/"),
      packageDependencies: new Map([
        ["has-values", "0.1.4"],
      ]),
    }],
  ])],
  ["set-value", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-set-value-2.0.0-71ae4a88f0feefbbf52d1ea604f3fb315ebb6274/node_modules/set-value/"),
      packageDependencies: new Map([
        ["extend-shallow", "2.0.1"],
        ["is-extendable", "0.1.1"],
        ["is-plain-object", "2.0.4"],
        ["split-string", "3.1.0"],
        ["set-value", "2.0.0"],
      ]),
    }],
    ["0.4.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-set-value-0.4.3-7db08f9d3d22dc7f78e53af3c3bf4666ecdfccf1/node_modules/set-value/"),
      packageDependencies: new Map([
        ["extend-shallow", "2.0.1"],
        ["is-extendable", "0.1.1"],
        ["is-plain-object", "2.0.4"],
        ["to-object-path", "0.3.0"],
        ["set-value", "0.4.3"],
      ]),
    }],
  ])],
  ["is-plain-object", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-plain-object-2.0.4-2c163b3fafb1b606d9d17928f05c2a1c38e07677/node_modules/is-plain-object/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
        ["is-plain-object", "2.0.4"],
      ]),
    }],
  ])],
  ["split-string", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-split-string-3.1.0-7cb09dda3a86585705c64b39a6466038682e8fe2/node_modules/split-string/"),
      packageDependencies: new Map([
        ["extend-shallow", "3.0.2"],
        ["split-string", "3.1.0"],
      ]),
    }],
  ])],
  ["assign-symbols", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-assign-symbols-1.0.0-59667f41fadd4f20ccbc2bb96b8d4f7f78ec0367/node_modules/assign-symbols/"),
      packageDependencies: new Map([
        ["assign-symbols", "1.0.0"],
      ]),
    }],
  ])],
  ["to-object-path", new Map([
    ["0.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-to-object-path-0.3.0-297588b7b0e7e0ac08e04e672f85c1f4999e17af/node_modules/to-object-path/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["to-object-path", "0.3.0"],
      ]),
    }],
  ])],
  ["union-value", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-union-value-1.0.0-5c71c34cb5bad5dcebe3ea0cd08207ba5aa1aea4/node_modules/union-value/"),
      packageDependencies: new Map([
        ["arr-union", "3.1.0"],
        ["get-value", "2.0.6"],
        ["is-extendable", "0.1.1"],
        ["set-value", "0.4.3"],
        ["union-value", "1.0.0"],
      ]),
    }],
  ])],
  ["arr-union", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-union-3.1.0-e39b09aea9def866a8f206e288af63919bae39c4/node_modules/arr-union/"),
      packageDependencies: new Map([
        ["arr-union", "3.1.0"],
      ]),
    }],
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-union-2.1.0-20f9eab5ec70f5c7d215b1077b1c39161d292c7d/node_modules/arr-union/"),
      packageDependencies: new Map([
        ["arr-union", "2.1.0"],
      ]),
    }],
  ])],
  ["unset-value", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-unset-value-1.0.0-8376873f7d2335179ffb1e6fc3a8ed0dfc8ab559/node_modules/unset-value/"),
      packageDependencies: new Map([
        ["has-value", "0.3.1"],
        ["isobject", "3.0.1"],
        ["unset-value", "1.0.0"],
      ]),
    }],
  ])],
  ["class-utils", new Map([
    ["0.3.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-class-utils-0.3.6-f93369ae8b9a7ce02fd41faad0ca83033190c463/node_modules/class-utils/"),
      packageDependencies: new Map([
        ["arr-union", "3.1.0"],
        ["define-property", "0.2.5"],
        ["isobject", "3.0.1"],
        ["static-extend", "0.1.2"],
        ["class-utils", "0.3.6"],
      ]),
    }],
  ])],
  ["define-property", new Map([
    ["0.2.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-define-property-0.2.5-c35b1ef918ec3c990f9a5bc57be04aacec5c8116/node_modules/define-property/"),
      packageDependencies: new Map([
        ["is-descriptor", "0.1.6"],
        ["define-property", "0.2.5"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-define-property-1.0.0-769ebaaf3f4a63aad3af9e8d304c9bbe79bfb0e6/node_modules/define-property/"),
      packageDependencies: new Map([
        ["is-descriptor", "1.0.2"],
        ["define-property", "1.0.0"],
      ]),
    }],
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-define-property-2.0.2-d459689e8d654ba77e02a817f8710d702cb16e9d/node_modules/define-property/"),
      packageDependencies: new Map([
        ["is-descriptor", "1.0.2"],
        ["isobject", "3.0.1"],
        ["define-property", "2.0.2"],
      ]),
    }],
  ])],
  ["is-descriptor", new Map([
    ["0.1.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-descriptor-0.1.6-366d8240dde487ca51823b1ab9f07a10a78251ca/node_modules/is-descriptor/"),
      packageDependencies: new Map([
        ["is-accessor-descriptor", "0.1.6"],
        ["is-data-descriptor", "0.1.4"],
        ["kind-of", "5.1.0"],
        ["is-descriptor", "0.1.6"],
      ]),
    }],
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-descriptor-1.0.2-3b159746a66604b04f8c81524ba365c5f14d86ec/node_modules/is-descriptor/"),
      packageDependencies: new Map([
        ["is-accessor-descriptor", "1.0.0"],
        ["is-data-descriptor", "1.0.0"],
        ["kind-of", "6.0.2"],
        ["is-descriptor", "1.0.2"],
      ]),
    }],
  ])],
  ["is-accessor-descriptor", new Map([
    ["0.1.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-accessor-descriptor-0.1.6-a9e12cb3ae8d876727eeef3843f8a0897b5c98d6/node_modules/is-accessor-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-accessor-descriptor", "0.1.6"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-accessor-descriptor-1.0.0-169c2f6d3df1f992618072365c9b0ea1f6878656/node_modules/is-accessor-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
        ["is-accessor-descriptor", "1.0.0"],
      ]),
    }],
  ])],
  ["is-data-descriptor", new Map([
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-data-descriptor-0.1.4-0b5ee648388e2c860282e793f1856fec3f301b56/node_modules/is-data-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-data-descriptor", "0.1.4"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-data-descriptor-1.0.0-d84876321d0e7add03990406abbbbd36ba9268c7/node_modules/is-data-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
        ["is-data-descriptor", "1.0.0"],
      ]),
    }],
  ])],
  ["static-extend", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-static-extend-0.1.2-60809c39cbff55337226fd5e0b520f341f1fb5c6/node_modules/static-extend/"),
      packageDependencies: new Map([
        ["define-property", "0.2.5"],
        ["object-copy", "0.1.0"],
        ["static-extend", "0.1.2"],
      ]),
    }],
  ])],
  ["object-copy", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-copy-0.1.0-7e7d858b781bd7c991a41ba975ed3812754e998c/node_modules/object-copy/"),
      packageDependencies: new Map([
        ["copy-descriptor", "0.1.1"],
        ["define-property", "0.2.5"],
        ["kind-of", "3.2.2"],
        ["object-copy", "0.1.0"],
      ]),
    }],
  ])],
  ["copy-descriptor", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-copy-descriptor-0.1.1-676f6eb3c39997c2ee1ac3a924fd6124748f578d/node_modules/copy-descriptor/"),
      packageDependencies: new Map([
        ["copy-descriptor", "0.1.1"],
      ]),
    }],
  ])],
  ["mixin-deep", new Map([
    ["1.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mixin-deep-1.3.1-a49e7268dce1a0d9698e45326c5626df3543d0fe/node_modules/mixin-deep/"),
      packageDependencies: new Map([
        ["for-in", "1.0.2"],
        ["is-extendable", "1.0.1"],
        ["mixin-deep", "1.3.1"],
      ]),
    }],
  ])],
  ["for-in", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-for-in-1.0.2-81068d295a8142ec0ac726c6e2200c30fb6d5e80/node_modules/for-in/"),
      packageDependencies: new Map([
        ["for-in", "1.0.2"],
      ]),
    }],
  ])],
  ["pascalcase", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pascalcase-0.1.1-b363e55e8006ca6fe21784d2db22bd15d7917f14/node_modules/pascalcase/"),
      packageDependencies: new Map([
        ["pascalcase", "0.1.1"],
      ]),
    }],
  ])],
  ["map-cache", new Map([
    ["0.2.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-map-cache-0.2.2-c32abd0bd6525d9b051645bb4f26ac5dc98a0dbf/node_modules/map-cache/"),
      packageDependencies: new Map([
        ["map-cache", "0.2.2"],
      ]),
    }],
  ])],
  ["source-map-resolve", new Map([
    ["0.5.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-source-map-resolve-0.5.2-72e2cc34095543e43b2c62b2c4c10d4a9054f259/node_modules/source-map-resolve/"),
      packageDependencies: new Map([
        ["atob", "2.1.2"],
        ["decode-uri-component", "0.2.0"],
        ["resolve-url", "0.2.1"],
        ["source-map-url", "0.4.0"],
        ["urix", "0.1.0"],
        ["source-map-resolve", "0.5.2"],
      ]),
    }],
  ])],
  ["atob", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-atob-2.1.2-6d9517eb9e030d2436666651e86bd9f6f13533c9/node_modules/atob/"),
      packageDependencies: new Map([
        ["atob", "2.1.2"],
      ]),
    }],
  ])],
  ["decode-uri-component", new Map([
    ["0.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-decode-uri-component-0.2.0-eb3913333458775cb84cd1a1fae062106bb87545/node_modules/decode-uri-component/"),
      packageDependencies: new Map([
        ["decode-uri-component", "0.2.0"],
      ]),
    }],
  ])],
  ["resolve-url", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-resolve-url-0.2.1-2c637fe77c893afd2a663fe21aa9080068e2052a/node_modules/resolve-url/"),
      packageDependencies: new Map([
        ["resolve-url", "0.2.1"],
      ]),
    }],
  ])],
  ["source-map-url", new Map([
    ["0.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-source-map-url-0.4.0-3e935d7ddd73631b97659956d55128e87b5084a3/node_modules/source-map-url/"),
      packageDependencies: new Map([
        ["source-map-url", "0.4.0"],
      ]),
    }],
  ])],
  ["urix", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-urix-0.1.0-da937f7a62e21fec1fd18d49b35c2935067a6c72/node_modules/urix/"),
      packageDependencies: new Map([
        ["urix", "0.1.0"],
      ]),
    }],
  ])],
  ["use", new Map([
    ["3.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-use-3.1.1-d50c8cac79a19fbc20f2911f56eb973f4e10070f/node_modules/use/"),
      packageDependencies: new Map([
        ["use", "3.1.1"],
      ]),
    }],
  ])],
  ["snapdragon-node", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-snapdragon-node-2.1.1-6c175f86ff14bdb0724563e8f3c1b021a286853b/node_modules/snapdragon-node/"),
      packageDependencies: new Map([
        ["define-property", "1.0.0"],
        ["isobject", "3.0.1"],
        ["snapdragon-util", "3.0.1"],
        ["snapdragon-node", "2.1.1"],
      ]),
    }],
  ])],
  ["snapdragon-util", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-snapdragon-util-3.0.1-f956479486f2acd79700693f6f7b805e45ab56e2/node_modules/snapdragon-util/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["snapdragon-util", "3.0.1"],
      ]),
    }],
  ])],
  ["to-regex", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-to-regex-3.0.2-13cfdd9b336552f30b51f33a8ae1b42a7a7599ce/node_modules/to-regex/"),
      packageDependencies: new Map([
        ["define-property", "2.0.2"],
        ["extend-shallow", "3.0.2"],
        ["regex-not", "1.0.2"],
        ["safe-regex", "1.1.0"],
        ["to-regex", "3.0.2"],
      ]),
    }],
  ])],
  ["regex-not", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-regex-not-1.0.2-1f4ece27e00b0b65e0247a6810e6a85d83a5752c/node_modules/regex-not/"),
      packageDependencies: new Map([
        ["extend-shallow", "3.0.2"],
        ["safe-regex", "1.1.0"],
        ["regex-not", "1.0.2"],
      ]),
    }],
  ])],
  ["safe-regex", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-safe-regex-1.1.0-40a3669f3b077d1e943d44629e157dd48023bf2e/node_modules/safe-regex/"),
      packageDependencies: new Map([
        ["ret", "0.1.15"],
        ["safe-regex", "1.1.0"],
      ]),
    }],
  ])],
  ["ret", new Map([
    ["0.1.15", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ret-0.1.15-b8a4825d5bdb1fc3f6f53c2bc33f81388681c7bc/node_modules/ret/"),
      packageDependencies: new Map([
        ["ret", "0.1.15"],
      ]),
    }],
  ])],
  ["extglob", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extglob-2.0.4-ad00fe4dc612a9232e8718711dc5cb5ab0285543/node_modules/extglob/"),
      packageDependencies: new Map([
        ["array-unique", "0.3.2"],
        ["define-property", "1.0.0"],
        ["expand-brackets", "2.1.4"],
        ["extend-shallow", "2.0.1"],
        ["fragment-cache", "0.2.1"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["extglob", "2.0.4"],
      ]),
    }],
    ["0.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extglob-0.3.2-2e18ff3d2f49ab2765cec9023f011daa8d8349a1/node_modules/extglob/"),
      packageDependencies: new Map([
        ["is-extglob", "1.0.0"],
        ["extglob", "0.3.2"],
      ]),
    }],
  ])],
  ["expand-brackets", new Map([
    ["2.1.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-expand-brackets-2.1.4-b77735e315ce30f6b6eff0f83b04151a22449622/node_modules/expand-brackets/"),
      packageDependencies: new Map([
        ["debug", "2.6.9"],
        ["define-property", "0.2.5"],
        ["extend-shallow", "2.0.1"],
        ["posix-character-classes", "0.1.1"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["expand-brackets", "2.1.4"],
      ]),
    }],
    ["0.1.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-expand-brackets-0.1.5-df07284e342a807cd733ac5af72411e581d1177b/node_modules/expand-brackets/"),
      packageDependencies: new Map([
        ["is-posix-bracket", "0.1.1"],
        ["expand-brackets", "0.1.5"],
      ]),
    }],
  ])],
  ["posix-character-classes", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-posix-character-classes-0.1.1-01eac0fe3b5af71a2a6c02feabb8c1fef7e00eab/node_modules/posix-character-classes/"),
      packageDependencies: new Map([
        ["posix-character-classes", "0.1.1"],
      ]),
    }],
  ])],
  ["fragment-cache", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fragment-cache-0.2.1-4290fad27f13e89be7f33799c6bc5a0abfff0d19/node_modules/fragment-cache/"),
      packageDependencies: new Map([
        ["map-cache", "0.2.2"],
        ["fragment-cache", "0.2.1"],
      ]),
    }],
  ])],
  ["nanomatch", new Map([
    ["1.2.13", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-nanomatch-1.2.13-b87a8aa4fc0de8fe6be88895b38983ff265bd119/node_modules/nanomatch/"),
      packageDependencies: new Map([
        ["arr-diff", "4.0.0"],
        ["array-unique", "0.3.2"],
        ["define-property", "2.0.2"],
        ["extend-shallow", "3.0.2"],
        ["fragment-cache", "0.2.1"],
        ["is-windows", "1.0.2"],
        ["kind-of", "6.0.2"],
        ["object.pick", "1.3.0"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["nanomatch", "1.2.13"],
      ]),
    }],
  ])],
  ["is-windows", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-windows-1.0.2-d1850eb9791ecd18e6182ce12a30f396634bb19d/node_modules/is-windows/"),
      packageDependencies: new Map([
        ["is-windows", "1.0.2"],
      ]),
    }],
  ])],
  ["object.pick", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-pick-1.3.0-87a10ac4c1694bd2e1cbf53591a66141fb5dd747/node_modules/object.pick/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
        ["object.pick", "1.3.0"],
      ]),
    }],
  ])],
  ["normalize-path", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-normalize-path-2.1.1-1ab28b556e198363a8c1a6f7e6fa20137fe6aed9/node_modules/normalize-path/"),
      packageDependencies: new Map([
        ["remove-trailing-separator", "1.1.0"],
        ["normalize-path", "2.1.1"],
      ]),
    }],
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-normalize-path-3.0.0-0dcd69ff23a1c9b11fd0978316644a0388216a65/node_modules/normalize-path/"),
      packageDependencies: new Map([
        ["normalize-path", "3.0.0"],
      ]),
    }],
  ])],
  ["remove-trailing-separator", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-remove-trailing-separator-1.1.0-c24bce2a283adad5bc3f58e0d48249b92379d8ef/node_modules/remove-trailing-separator/"),
      packageDependencies: new Map([
        ["remove-trailing-separator", "1.1.0"],
      ]),
    }],
  ])],
  ["async-each", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-each-1.0.1-19d386a1d9edc6e7c1c85d388aedbcc56d33602d/node_modules/async-each/"),
      packageDependencies: new Map([
        ["async-each", "1.0.1"],
      ]),
    }],
  ])],
  ["glob-parent", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glob-parent-3.1.0-9e6af6299d8d3bd2bd40430832bd113df906c5ae/node_modules/glob-parent/"),
      packageDependencies: new Map([
        ["is-glob", "3.1.0"],
        ["path-dirname", "1.0.2"],
        ["glob-parent", "3.1.0"],
      ]),
    }],
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glob-parent-2.0.0-81383d72db054fcccf5336daa902f182f6edbb28/node_modules/glob-parent/"),
      packageDependencies: new Map([
        ["is-glob", "2.0.1"],
        ["glob-parent", "2.0.0"],
      ]),
    }],
  ])],
  ["is-glob", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-glob-3.1.0-7ba5ae24217804ac70707b96922567486cc3e84a/node_modules/is-glob/"),
      packageDependencies: new Map([
        ["is-extglob", "2.1.1"],
        ["is-glob", "3.1.0"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-glob-4.0.0-9521c76845cc2610a85203ddf080a958c2ffabc0/node_modules/is-glob/"),
      packageDependencies: new Map([
        ["is-extglob", "2.1.1"],
        ["is-glob", "4.0.0"],
      ]),
    }],
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-glob-2.0.1-d096f926a3ded5600f3fdfd91198cb0888c2d863/node_modules/is-glob/"),
      packageDependencies: new Map([
        ["is-extglob", "1.0.0"],
        ["is-glob", "2.0.1"],
      ]),
    }],
  ])],
  ["is-extglob", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-extglob-2.1.1-a88c02535791f02ed37c76a1b9ea9773c833f8c2/node_modules/is-extglob/"),
      packageDependencies: new Map([
        ["is-extglob", "2.1.1"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-extglob-1.0.0-ac468177c4943405a092fc8f29760c6ffc6206c0/node_modules/is-extglob/"),
      packageDependencies: new Map([
        ["is-extglob", "1.0.0"],
      ]),
    }],
  ])],
  ["path-dirname", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-dirname-1.0.2-cc33d24d525e099a5388c0336c6e32b9160609e0/node_modules/path-dirname/"),
      packageDependencies: new Map([
        ["path-dirname", "1.0.2"],
      ]),
    }],
  ])],
  ["inherits", new Map([
    ["2.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-inherits-2.0.3-633c2c83e3da42a502f52466022480f4208261de/node_modules/inherits/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
      ]),
    }],
  ])],
  ["is-binary-path", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-binary-path-1.0.1-75f16642b480f187a711c814161fd3a4a7655898/node_modules/is-binary-path/"),
      packageDependencies: new Map([
        ["binary-extensions", "1.13.0"],
        ["is-binary-path", "1.0.1"],
      ]),
    }],
  ])],
  ["binary-extensions", new Map([
    ["1.13.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-binary-extensions-1.13.0-9523e001306a32444b907423f1de2164222f6ab1/node_modules/binary-extensions/"),
      packageDependencies: new Map([
        ["binary-extensions", "1.13.0"],
      ]),
    }],
  ])],
  ["path-is-absolute", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-is-absolute-1.0.1-174b9268735534ffbc7ace6bf53a5a9e1b5c5f5f/node_modules/path-is-absolute/"),
      packageDependencies: new Map([
        ["path-is-absolute", "1.0.1"],
      ]),
    }],
  ])],
  ["readdirp", new Map([
    ["2.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-readdirp-2.2.1-0e87622a3325aa33e892285caf8b4e846529a525/node_modules/readdirp/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["micromatch", "3.1.10"],
        ["readable-stream", "2.3.6"],
        ["readdirp", "2.2.1"],
      ]),
    }],
  ])],
  ["graceful-fs", new Map([
    ["4.1.15", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-graceful-fs-4.1.15-ffb703e1066e8a0eeaa4c8b80ba9253eeefbfb00/node_modules/graceful-fs/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
      ]),
    }],
  ])],
  ["readable-stream", new Map([
    ["2.3.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-readable-stream-2.3.6-b11c27d88b8ff1fbe070643cf94b0c79ae1b0aaf/node_modules/readable-stream/"),
      packageDependencies: new Map([
        ["core-util-is", "1.0.2"],
        ["inherits", "2.0.3"],
        ["isarray", "1.0.0"],
        ["process-nextick-args", "2.0.0"],
        ["safe-buffer", "5.1.2"],
        ["string_decoder", "1.1.1"],
        ["util-deprecate", "1.0.2"],
        ["readable-stream", "2.3.6"],
      ]),
    }],
  ])],
  ["core-util-is", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-core-util-is-1.0.2-b5fd54220aa2bc5ab57aab7140c940754503c1a7/node_modules/core-util-is/"),
      packageDependencies: new Map([
        ["core-util-is", "1.0.2"],
      ]),
    }],
  ])],
  ["process-nextick-args", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-process-nextick-args-2.0.0-a37d732f4271b4ab1ad070d35508e8290788ffaa/node_modules/process-nextick-args/"),
      packageDependencies: new Map([
        ["process-nextick-args", "2.0.0"],
      ]),
    }],
    ["1.0.7", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-process-nextick-args-1.0.7-150e20b756590ad3f91093f25a4f2ad8bff30ba3/node_modules/process-nextick-args/"),
      packageDependencies: new Map([
        ["process-nextick-args", "1.0.7"],
      ]),
    }],
  ])],
  ["safe-buffer", new Map([
    ["5.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-safe-buffer-5.1.2-991ec69d296e0313747d59bdfd2b745c35f8828d/node_modules/safe-buffer/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
      ]),
    }],
  ])],
  ["string_decoder", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-string-decoder-1.1.1-9cf1611ba62685d7030ae9e4ba34149c3af03fc8/node_modules/string_decoder/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["string_decoder", "1.1.1"],
      ]),
    }],
  ])],
  ["util-deprecate", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-util-deprecate-1.0.2-450d4dc9fa70de732762fbd2d4a28981419a0ccf/node_modules/util-deprecate/"),
      packageDependencies: new Map([
        ["util-deprecate", "1.0.2"],
      ]),
    }],
  ])],
  ["upath", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-upath-1.1.2-3db658600edaeeccbe6db5e684d67ee8c2acd068/node_modules/upath/"),
      packageDependencies: new Map([
        ["upath", "1.1.2"],
      ]),
    }],
  ])],
  ["connect", new Map([
    ["3.6.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-connect-3.6.6-09eff6c55af7236e137135a72574858b6786f524/node_modules/connect/"),
      packageDependencies: new Map([
        ["debug", "2.6.9"],
        ["finalhandler", "1.1.0"],
        ["parseurl", "1.3.2"],
        ["utils-merge", "1.0.1"],
        ["connect", "3.6.6"],
      ]),
    }],
  ])],
  ["finalhandler", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-finalhandler-1.1.0-ce0b6855b45853e791b2fcc680046d88253dd7f5/node_modules/finalhandler/"),
      packageDependencies: new Map([
        ["debug", "2.6.9"],
        ["encodeurl", "1.0.2"],
        ["escape-html", "1.0.3"],
        ["on-finished", "2.3.0"],
        ["parseurl", "1.3.2"],
        ["statuses", "1.3.1"],
        ["unpipe", "1.0.0"],
        ["finalhandler", "1.1.0"],
      ]),
    }],
  ])],
  ["encodeurl", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-encodeurl-1.0.2-ad3ff4c86ec2d029322f5a02c3a9a606c95b3f59/node_modules/encodeurl/"),
      packageDependencies: new Map([
        ["encodeurl", "1.0.2"],
      ]),
    }],
  ])],
  ["escape-html", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-escape-html-1.0.3-0258eae4d3d0c0974de1c169188ef0051d1d1988/node_modules/escape-html/"),
      packageDependencies: new Map([
        ["escape-html", "1.0.3"],
      ]),
    }],
  ])],
  ["on-finished", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-on-finished-2.3.0-20f1336481b083cd75337992a16971aa2d906947/node_modules/on-finished/"),
      packageDependencies: new Map([
        ["ee-first", "1.1.1"],
        ["on-finished", "2.3.0"],
      ]),
    }],
  ])],
  ["ee-first", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ee-first-1.1.1-590c61156b0ae2f4f0255732a158b266bc56b21d/node_modules/ee-first/"),
      packageDependencies: new Map([
        ["ee-first", "1.1.1"],
      ]),
    }],
  ])],
  ["parseurl", new Map([
    ["1.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parseurl-1.3.2-fc289d4ed8993119460c156253262cdc8de65bf3/node_modules/parseurl/"),
      packageDependencies: new Map([
        ["parseurl", "1.3.2"],
      ]),
    }],
  ])],
  ["statuses", new Map([
    ["1.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-statuses-1.3.1-faf51b9eb74aaef3b3acf4ad5f61abf24cb7b93e/node_modules/statuses/"),
      packageDependencies: new Map([
        ["statuses", "1.3.1"],
      ]),
    }],
    ["1.5.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-statuses-1.5.0-161c7dac177659fd9811f43771fa99381478628c/node_modules/statuses/"),
      packageDependencies: new Map([
        ["statuses", "1.5.0"],
      ]),
    }],
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-statuses-1.4.0-bb73d446da2796106efcc1b601a253d6c46bd087/node_modules/statuses/"),
      packageDependencies: new Map([
        ["statuses", "1.4.0"],
      ]),
    }],
  ])],
  ["unpipe", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-unpipe-1.0.0-b2bf4ee8514aae6165b4817829d21b2ef49904ec/node_modules/unpipe/"),
      packageDependencies: new Map([
        ["unpipe", "1.0.0"],
      ]),
    }],
  ])],
  ["utils-merge", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-utils-merge-1.0.1-9f95710f50a267947b2ccc124741c1028427e713/node_modules/utils-merge/"),
      packageDependencies: new Map([
        ["utils-merge", "1.0.1"],
      ]),
    }],
  ])],
  ["dev-ip", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-dev-ip-1.0.1-a76a3ed1855be7a012bb8ac16cb80f3c00dc28f0/node_modules/dev-ip/"),
      packageDependencies: new Map([
        ["dev-ip", "1.0.1"],
      ]),
    }],
  ])],
  ["easy-extender", new Map([
    ["2.3.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-easy-extender-2.3.4-298789b64f9aaba62169c77a2b3b64b4c9589b8f/node_modules/easy-extender/"),
      packageDependencies: new Map([
        ["lodash", "4.17.11"],
        ["easy-extender", "2.3.4"],
      ]),
    }],
  ])],
  ["lodash", new Map([
    ["4.17.11", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lodash-4.17.11-b39ea6229ef607ecd89e2c8df12536891cac9b8d/node_modules/lodash/"),
      packageDependencies: new Map([
        ["lodash", "4.17.11"],
      ]),
    }],
  ])],
  ["eazy-logger", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-eazy-logger-3.0.2-a325aa5e53d13a2225889b2ac4113b2b9636f4fc/node_modules/eazy-logger/"),
      packageDependencies: new Map([
        ["tfunk", "3.1.0"],
        ["eazy-logger", "3.0.2"],
      ]),
    }],
  ])],
  ["tfunk", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-tfunk-3.1.0-38e4414fc64977d87afdaa72facb6d29f82f7b5b/node_modules/tfunk/"),
      packageDependencies: new Map([
        ["chalk", "1.1.3"],
        ["object-path", "0.9.2"],
        ["tfunk", "3.1.0"],
      ]),
    }],
  ])],
  ["has-ansi", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-ansi-2.0.0-34f5049ce1ecdf2b0649af3ef24e45ed35416d91/node_modules/has-ansi/"),
      packageDependencies: new Map([
        ["ansi-regex", "2.1.1"],
        ["has-ansi", "2.0.0"],
      ]),
    }],
  ])],
  ["ansi-regex", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-regex-2.1.1-c3b33ab5ee360d86e0e628f0468ae7ef27d654df/node_modules/ansi-regex/"),
      packageDependencies: new Map([
        ["ansi-regex", "2.1.1"],
      ]),
    }],
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-regex-3.0.0-ed0317c322064f79466c02966bddb605ab37d998/node_modules/ansi-regex/"),
      packageDependencies: new Map([
        ["ansi-regex", "3.0.0"],
      ]),
    }],
  ])],
  ["strip-ansi", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-strip-ansi-3.0.1-6a385fb8853d952d5ff05d0e8aaf94278dc63dcf/node_modules/strip-ansi/"),
      packageDependencies: new Map([
        ["ansi-regex", "2.1.1"],
        ["strip-ansi", "3.0.1"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-strip-ansi-4.0.0-a8479022eb1ac368a871389b635262c505ee368f/node_modules/strip-ansi/"),
      packageDependencies: new Map([
        ["ansi-regex", "3.0.0"],
        ["strip-ansi", "4.0.0"],
      ]),
    }],
  ])],
  ["object-path", new Map([
    ["0.9.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-path-0.9.2-0fd9a74fc5fad1ae3968b586bda5c632bd6c05a5/node_modules/object-path/"),
      packageDependencies: new Map([
        ["object-path", "0.9.2"],
      ]),
    }],
  ])],
  ["fs-extra", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fs-extra-3.0.1-3794f378c58b342ea7dbbb23095109c4b3b62291/node_modules/fs-extra/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["jsonfile", "3.0.1"],
        ["universalify", "0.1.2"],
        ["fs-extra", "3.0.1"],
      ]),
    }],
  ])],
  ["jsonfile", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-jsonfile-3.0.1-a5ecc6f65f53f662c4415c7675a0331d0992ec66/node_modules/jsonfile/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["jsonfile", "3.0.1"],
      ]),
    }],
  ])],
  ["universalify", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-universalify-0.1.2-b646f69be3942dabcecc9d6639c80dc105efaa66/node_modules/universalify/"),
      packageDependencies: new Map([
        ["universalify", "0.1.2"],
      ]),
    }],
  ])],
  ["http-proxy", new Map([
    ["1.15.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-http-proxy-1.15.2-642fdcaffe52d3448d2bda3b0079e9409064da31/node_modules/http-proxy/"),
      packageDependencies: new Map([
        ["eventemitter3", "1.2.0"],
        ["requires-port", "1.0.0"],
        ["http-proxy", "1.15.2"],
      ]),
    }],
  ])],
  ["eventemitter3", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-eventemitter3-1.2.0-1c86991d816ad1e504750e73874224ecf3bec508/node_modules/eventemitter3/"),
      packageDependencies: new Map([
        ["eventemitter3", "1.2.0"],
      ]),
    }],
  ])],
  ["requires-port", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-requires-port-1.0.0-925d2601d39ac485e091cf0da5c6e694dc3dcaff/node_modules/requires-port/"),
      packageDependencies: new Map([
        ["requires-port", "1.0.0"],
      ]),
    }],
  ])],
  ["localtunnel", new Map([
    ["1.9.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-localtunnel-1.9.1-1d1737eab658add5a40266d8e43f389b646ee3b1/node_modules/localtunnel/"),
      packageDependencies: new Map([
        ["axios", "0.17.1"],
        ["debug", "2.6.9"],
        ["openurl", "1.1.1"],
        ["yargs", "6.6.0"],
        ["localtunnel", "1.9.1"],
      ]),
    }],
  ])],
  ["axios", new Map([
    ["0.17.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-axios-0.17.1-2d8e3e5d0bdbd7327f91bc814f5c57660f81824d/node_modules/axios/"),
      packageDependencies: new Map([
        ["follow-redirects", "1.7.0"],
        ["is-buffer", "1.1.6"],
        ["axios", "0.17.1"],
      ]),
    }],
  ])],
  ["follow-redirects", new Map([
    ["1.7.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-follow-redirects-1.7.0-489ebc198dc0e7f64167bd23b03c4c19b5784c76/node_modules/follow-redirects/"),
      packageDependencies: new Map([
        ["debug", "3.2.6"],
        ["follow-redirects", "1.7.0"],
      ]),
    }],
  ])],
  ["openurl", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-openurl-1.1.1-3875b4b0ef7a52c156f0db41d4609dbb0f94b387/node_modules/openurl/"),
      packageDependencies: new Map([
        ["openurl", "1.1.1"],
      ]),
    }],
  ])],
  ["yargs", new Map([
    ["6.6.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yargs-6.6.0-782ec21ef403345f830a808ca3d513af56065208/node_modules/yargs/"),
      packageDependencies: new Map([
        ["camelcase", "3.0.0"],
        ["cliui", "3.2.0"],
        ["decamelize", "1.2.0"],
        ["get-caller-file", "1.0.3"],
        ["os-locale", "1.4.0"],
        ["read-pkg-up", "1.0.1"],
        ["require-directory", "2.1.1"],
        ["require-main-filename", "1.0.1"],
        ["set-blocking", "2.0.0"],
        ["string-width", "1.0.2"],
        ["which-module", "1.0.0"],
        ["y18n", "3.2.1"],
        ["yargs-parser", "4.2.1"],
        ["yargs", "6.6.0"],
      ]),
    }],
    ["6.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yargs-6.4.0-816e1a866d5598ccf34e5596ddce22d92da490d4/node_modules/yargs/"),
      packageDependencies: new Map([
        ["camelcase", "3.0.0"],
        ["cliui", "3.2.0"],
        ["decamelize", "1.2.0"],
        ["get-caller-file", "1.0.3"],
        ["os-locale", "1.4.0"],
        ["read-pkg-up", "1.0.1"],
        ["require-directory", "2.1.1"],
        ["require-main-filename", "1.0.1"],
        ["set-blocking", "2.0.0"],
        ["string-width", "1.0.2"],
        ["which-module", "1.0.0"],
        ["window-size", "0.2.0"],
        ["y18n", "3.2.1"],
        ["yargs-parser", "4.2.1"],
        ["yargs", "6.4.0"],
      ]),
    }],
    ["7.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yargs-7.1.0-6ba318eb16961727f5d284f8ea003e8d6154d0c8/node_modules/yargs/"),
      packageDependencies: new Map([
        ["camelcase", "3.0.0"],
        ["cliui", "3.2.0"],
        ["decamelize", "1.2.0"],
        ["get-caller-file", "1.0.3"],
        ["os-locale", "1.4.0"],
        ["read-pkg-up", "1.0.1"],
        ["require-directory", "2.1.1"],
        ["require-main-filename", "1.0.1"],
        ["set-blocking", "2.0.0"],
        ["string-width", "1.0.2"],
        ["which-module", "1.0.0"],
        ["y18n", "3.2.1"],
        ["yargs-parser", "5.0.0"],
        ["yargs", "7.1.0"],
      ]),
    }],
  ])],
  ["camelcase", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-camelcase-3.0.0-32fc4b9fcdaf845fcdf7e73bb97cac2261f0ab0a/node_modules/camelcase/"),
      packageDependencies: new Map([
        ["camelcase", "3.0.0"],
      ]),
    }],
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-camelcase-2.1.1-7c1d16d679a1bbe59ca02cacecfb011e201f5a1f/node_modules/camelcase/"),
      packageDependencies: new Map([
        ["camelcase", "2.1.1"],
      ]),
    }],
  ])],
  ["cliui", new Map([
    ["3.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-cliui-3.2.0-120601537a916d29940f934da3b48d585a39213d/node_modules/cliui/"),
      packageDependencies: new Map([
        ["string-width", "1.0.2"],
        ["strip-ansi", "3.0.1"],
        ["wrap-ansi", "2.1.0"],
        ["cliui", "3.2.0"],
      ]),
    }],
  ])],
  ["string-width", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-string-width-1.0.2-118bdf5b8cdc51a2a7e70d211e07e2b0b9b107d3/node_modules/string-width/"),
      packageDependencies: new Map([
        ["code-point-at", "1.1.0"],
        ["is-fullwidth-code-point", "1.0.0"],
        ["strip-ansi", "3.0.1"],
        ["string-width", "1.0.2"],
      ]),
    }],
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-string-width-2.1.1-ab93f27a8dc13d28cac815c462143a6d9012ae9e/node_modules/string-width/"),
      packageDependencies: new Map([
        ["is-fullwidth-code-point", "2.0.0"],
        ["strip-ansi", "4.0.0"],
        ["string-width", "2.1.1"],
      ]),
    }],
  ])],
  ["code-point-at", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-code-point-at-1.1.0-0d070b4d043a5bea33a2f1a40e2edb3d9a4ccf77/node_modules/code-point-at/"),
      packageDependencies: new Map([
        ["code-point-at", "1.1.0"],
      ]),
    }],
  ])],
  ["is-fullwidth-code-point", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-fullwidth-code-point-1.0.0-ef9e31386f031a7f0d643af82fde50c457ef00cb/node_modules/is-fullwidth-code-point/"),
      packageDependencies: new Map([
        ["number-is-nan", "1.0.1"],
        ["is-fullwidth-code-point", "1.0.0"],
      ]),
    }],
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-fullwidth-code-point-2.0.0-a3b30a5c4f199183167aaab93beefae3ddfb654f/node_modules/is-fullwidth-code-point/"),
      packageDependencies: new Map([
        ["is-fullwidth-code-point", "2.0.0"],
      ]),
    }],
  ])],
  ["number-is-nan", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-number-is-nan-1.0.1-097b602b53422a522c1afb8790318336941a011d/node_modules/number-is-nan/"),
      packageDependencies: new Map([
        ["number-is-nan", "1.0.1"],
      ]),
    }],
  ])],
  ["wrap-ansi", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-wrap-ansi-2.1.0-d8fc3d284dd05794fe84973caecdd1cf824fdd85/node_modules/wrap-ansi/"),
      packageDependencies: new Map([
        ["string-width", "1.0.2"],
        ["strip-ansi", "3.0.1"],
        ["wrap-ansi", "2.1.0"],
      ]),
    }],
  ])],
  ["decamelize", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-decamelize-1.2.0-f6534d15148269b20352e7bee26f501f9a191290/node_modules/decamelize/"),
      packageDependencies: new Map([
        ["decamelize", "1.2.0"],
      ]),
    }],
  ])],
  ["get-caller-file", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-get-caller-file-1.0.3-f978fa4c90d1dfe7ff2d6beda2a515e713bdcf4a/node_modules/get-caller-file/"),
      packageDependencies: new Map([
        ["get-caller-file", "1.0.3"],
      ]),
    }],
  ])],
  ["os-locale", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-os-locale-1.4.0-20f9f17ae29ed345e8bde583b13d2009803c14d9/node_modules/os-locale/"),
      packageDependencies: new Map([
        ["lcid", "1.0.0"],
        ["os-locale", "1.4.0"],
      ]),
    }],
  ])],
  ["lcid", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lcid-1.0.0-308accafa0bc483a3867b4b6f2b9506251d1b835/node_modules/lcid/"),
      packageDependencies: new Map([
        ["invert-kv", "1.0.0"],
        ["lcid", "1.0.0"],
      ]),
    }],
  ])],
  ["invert-kv", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-invert-kv-1.0.0-104a8e4aaca6d3d8cd157a8ef8bfab2d7a3ffdb6/node_modules/invert-kv/"),
      packageDependencies: new Map([
        ["invert-kv", "1.0.0"],
      ]),
    }],
  ])],
  ["read-pkg-up", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-read-pkg-up-1.0.1-9d63c13276c065918d57f002a57f40a1b643fb02/node_modules/read-pkg-up/"),
      packageDependencies: new Map([
        ["find-up", "1.1.2"],
        ["read-pkg", "1.1.0"],
        ["read-pkg-up", "1.0.1"],
      ]),
    }],
  ])],
  ["find-up", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-find-up-1.1.2-6b2e9822b1a2ce0a60ab64d610eccad53cb24d0f/node_modules/find-up/"),
      packageDependencies: new Map([
        ["path-exists", "2.1.0"],
        ["pinkie-promise", "2.0.1"],
        ["find-up", "1.1.2"],
      ]),
    }],
  ])],
  ["path-exists", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-exists-2.1.0-0feb6c64f0fc518d9a754dd5efb62c7022761f4b/node_modules/path-exists/"),
      packageDependencies: new Map([
        ["pinkie-promise", "2.0.1"],
        ["path-exists", "2.1.0"],
      ]),
    }],
  ])],
  ["pinkie-promise", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pinkie-promise-2.0.1-2135d6dfa7a358c069ac9b178776288228450ffa/node_modules/pinkie-promise/"),
      packageDependencies: new Map([
        ["pinkie", "2.0.4"],
        ["pinkie-promise", "2.0.1"],
      ]),
    }],
  ])],
  ["pinkie", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pinkie-2.0.4-72556b80cfa0d48a974e80e77248e80ed4f7f870/node_modules/pinkie/"),
      packageDependencies: new Map([
        ["pinkie", "2.0.4"],
      ]),
    }],
  ])],
  ["read-pkg", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-read-pkg-1.1.0-f5ffaa5ecd29cb31c0474bca7d756b6bb29e3f28/node_modules/read-pkg/"),
      packageDependencies: new Map([
        ["load-json-file", "1.1.0"],
        ["normalize-package-data", "2.5.0"],
        ["path-type", "1.1.0"],
        ["read-pkg", "1.1.0"],
      ]),
    }],
  ])],
  ["load-json-file", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-load-json-file-1.1.0-956905708d58b4bab4c2261b04f59f31c99374c0/node_modules/load-json-file/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["parse-json", "2.2.0"],
        ["pify", "2.3.0"],
        ["pinkie-promise", "2.0.1"],
        ["strip-bom", "2.0.0"],
        ["load-json-file", "1.1.0"],
      ]),
    }],
  ])],
  ["parse-json", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parse-json-2.2.0-f480f40434ef80741f8469099f8dea18f55a4dc9/node_modules/parse-json/"),
      packageDependencies: new Map([
        ["error-ex", "1.3.2"],
        ["parse-json", "2.2.0"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parse-json-4.0.0-be35f5425be1f7f6c747184f98a788cb99477ee0/node_modules/parse-json/"),
      packageDependencies: new Map([
        ["error-ex", "1.3.2"],
        ["json-parse-better-errors", "1.0.2"],
        ["parse-json", "4.0.0"],
      ]),
    }],
  ])],
  ["error-ex", new Map([
    ["1.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-error-ex-1.3.2-b4ac40648107fdcdcfae242f428bea8a14d4f1bf/node_modules/error-ex/"),
      packageDependencies: new Map([
        ["is-arrayish", "0.2.1"],
        ["error-ex", "1.3.2"],
      ]),
    }],
  ])],
  ["is-arrayish", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-arrayish-0.2.1-77c99840527aa8ecb1a8ba697b80645a7a926a9d/node_modules/is-arrayish/"),
      packageDependencies: new Map([
        ["is-arrayish", "0.2.1"],
      ]),
    }],
  ])],
  ["pify", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pify-2.3.0-ed141a6ac043a849ea588498e7dca8b15330e90c/node_modules/pify/"),
      packageDependencies: new Map([
        ["pify", "2.3.0"],
      ]),
    }],
  ])],
  ["strip-bom", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-strip-bom-2.0.0-6219a85616520491f35788bdbf1447a99c7e6b0e/node_modules/strip-bom/"),
      packageDependencies: new Map([
        ["is-utf8", "0.2.1"],
        ["strip-bom", "2.0.0"],
      ]),
    }],
  ])],
  ["is-utf8", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-utf8-0.2.1-4b0da1442104d1b336340e80797e865cf39f7d72/node_modules/is-utf8/"),
      packageDependencies: new Map([
        ["is-utf8", "0.2.1"],
      ]),
    }],
  ])],
  ["normalize-package-data", new Map([
    ["2.5.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-normalize-package-data-2.5.0-e66db1838b200c1dfc233225d12cb36520e234a8/node_modules/normalize-package-data/"),
      packageDependencies: new Map([
        ["hosted-git-info", "2.7.1"],
        ["resolve", "1.10.0"],
        ["semver", "5.6.0"],
        ["validate-npm-package-license", "3.0.4"],
        ["normalize-package-data", "2.5.0"],
      ]),
    }],
  ])],
  ["hosted-git-info", new Map([
    ["2.7.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-hosted-git-info-2.7.1-97f236977bd6e125408930ff6de3eec6281ec047/node_modules/hosted-git-info/"),
      packageDependencies: new Map([
        ["hosted-git-info", "2.7.1"],
      ]),
    }],
  ])],
  ["resolve", new Map([
    ["1.10.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-resolve-1.10.0-3bdaaeaf45cc07f375656dfd2e54ed0810b101ba/node_modules/resolve/"),
      packageDependencies: new Map([
        ["path-parse", "1.0.6"],
        ["resolve", "1.10.0"],
      ]),
    }],
  ])],
  ["path-parse", new Map([
    ["1.0.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-parse-1.0.6-d62dbb5679405d72c4737ec58600e9ddcf06d24c/node_modules/path-parse/"),
      packageDependencies: new Map([
        ["path-parse", "1.0.6"],
      ]),
    }],
  ])],
  ["validate-npm-package-license", new Map([
    ["3.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-validate-npm-package-license-3.0.4-fc91f6b9c7ba15c857f4cb2c5defeec39d4f410a/node_modules/validate-npm-package-license/"),
      packageDependencies: new Map([
        ["spdx-correct", "3.1.0"],
        ["spdx-expression-parse", "3.0.0"],
        ["validate-npm-package-license", "3.0.4"],
      ]),
    }],
  ])],
  ["spdx-correct", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-spdx-correct-3.1.0-fb83e504445268f154b074e218c87c003cd31df4/node_modules/spdx-correct/"),
      packageDependencies: new Map([
        ["spdx-expression-parse", "3.0.0"],
        ["spdx-license-ids", "3.0.3"],
        ["spdx-correct", "3.1.0"],
      ]),
    }],
  ])],
  ["spdx-expression-parse", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-spdx-expression-parse-3.0.0-99e119b7a5da00e05491c9fa338b7904823b41d0/node_modules/spdx-expression-parse/"),
      packageDependencies: new Map([
        ["spdx-exceptions", "2.2.0"],
        ["spdx-license-ids", "3.0.3"],
        ["spdx-expression-parse", "3.0.0"],
      ]),
    }],
  ])],
  ["spdx-exceptions", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-spdx-exceptions-2.2.0-2ea450aee74f2a89bfb94519c07fcd6f41322977/node_modules/spdx-exceptions/"),
      packageDependencies: new Map([
        ["spdx-exceptions", "2.2.0"],
      ]),
    }],
  ])],
  ["spdx-license-ids", new Map([
    ["3.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-spdx-license-ids-3.0.3-81c0ce8f21474756148bbb5f3bfc0f36bf15d76e/node_modules/spdx-license-ids/"),
      packageDependencies: new Map([
        ["spdx-license-ids", "3.0.3"],
      ]),
    }],
  ])],
  ["path-type", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-type-1.1.0-59c44f7ee491da704da415da5a4070ba4f8fe441/node_modules/path-type/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["pify", "2.3.0"],
        ["pinkie-promise", "2.0.1"],
        ["path-type", "1.1.0"],
      ]),
    }],
  ])],
  ["require-directory", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-require-directory-2.1.1-8c64ad5fd30dab1c976e2344ffe7f792a6a6df42/node_modules/require-directory/"),
      packageDependencies: new Map([
        ["require-directory", "2.1.1"],
      ]),
    }],
  ])],
  ["require-main-filename", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-require-main-filename-1.0.1-97f717b69d48784f5f526a6c5aa8ffdda055a4d1/node_modules/require-main-filename/"),
      packageDependencies: new Map([
        ["require-main-filename", "1.0.1"],
      ]),
    }],
  ])],
  ["set-blocking", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-set-blocking-2.0.0-045f9782d011ae9a6803ddd382b24392b3d890f7/node_modules/set-blocking/"),
      packageDependencies: new Map([
        ["set-blocking", "2.0.0"],
      ]),
    }],
  ])],
  ["which-module", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-which-module-1.0.0-bba63ca861948994ff307736089e3b96026c2a4f/node_modules/which-module/"),
      packageDependencies: new Map([
        ["which-module", "1.0.0"],
      ]),
    }],
  ])],
  ["y18n", new Map([
    ["3.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-y18n-3.2.1-6d15fba884c08679c0d77e88e7759e811e07fa41/node_modules/y18n/"),
      packageDependencies: new Map([
        ["y18n", "3.2.1"],
      ]),
    }],
  ])],
  ["yargs-parser", new Map([
    ["4.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yargs-parser-4.2.1-29cceac0dc4f03c6c87b4a9f217dd18c9f74871c/node_modules/yargs-parser/"),
      packageDependencies: new Map([
        ["camelcase", "3.0.0"],
        ["yargs-parser", "4.2.1"],
      ]),
    }],
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yargs-parser-5.0.0-275ecf0d7ffe05c77e64e7c86e4cd94bf0e1228a/node_modules/yargs-parser/"),
      packageDependencies: new Map([
        ["camelcase", "3.0.0"],
        ["yargs-parser", "5.0.0"],
      ]),
    }],
  ])],
  ["expand-range", new Map([
    ["1.8.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-expand-range-1.8.2-a299effd335fe2721ebae8e257ec79644fc85337/node_modules/expand-range/"),
      packageDependencies: new Map([
        ["fill-range", "2.2.4"],
        ["expand-range", "1.8.2"],
      ]),
    }],
  ])],
  ["randomatic", new Map([
    ["3.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-randomatic-3.1.1-b776efc59375984e36c537b2f51a1f0aff0da1ed/node_modules/randomatic/"),
      packageDependencies: new Map([
        ["is-number", "4.0.0"],
        ["kind-of", "6.0.2"],
        ["math-random", "1.0.4"],
        ["randomatic", "3.1.1"],
      ]),
    }],
  ])],
  ["math-random", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-math-random-1.0.4-5dd6943c938548267016d4e34f057583080c514c/node_modules/math-random/"),
      packageDependencies: new Map([
        ["math-random", "1.0.4"],
      ]),
    }],
  ])],
  ["preserve", new Map([
    ["0.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-preserve-0.2.0-815ed1f6ebc65926f865b310c0713bcb3315ce4b/node_modules/preserve/"),
      packageDependencies: new Map([
        ["preserve", "0.2.0"],
      ]),
    }],
  ])],
  ["is-posix-bracket", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-posix-bracket-0.1.1-3334dc79774368e92f016e6fbc0a88f5cd6e6bc4/node_modules/is-posix-bracket/"),
      packageDependencies: new Map([
        ["is-posix-bracket", "0.1.1"],
      ]),
    }],
  ])],
  ["filename-regex", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-filename-regex-2.0.1-c1c4b9bee3e09725ddb106b75c1e301fe2f18b26/node_modules/filename-regex/"),
      packageDependencies: new Map([
        ["filename-regex", "2.0.1"],
      ]),
    }],
  ])],
  ["object.omit", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-omit-2.0.1-1a9c744829f39dbb858c76ca3579ae2a54ebd1fa/node_modules/object.omit/"),
      packageDependencies: new Map([
        ["for-own", "0.1.5"],
        ["is-extendable", "0.1.1"],
        ["object.omit", "2.0.1"],
      ]),
    }],
  ])],
  ["for-own", new Map([
    ["0.1.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-for-own-0.1.5-5265c681a4f294dabbf17c9509b6763aa84510ce/node_modules/for-own/"),
      packageDependencies: new Map([
        ["for-in", "1.0.2"],
        ["for-own", "0.1.5"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-for-own-1.0.0-c63332f415cedc4b04dbfe70cf836494c53cb44b/node_modules/for-own/"),
      packageDependencies: new Map([
        ["for-in", "1.0.2"],
        ["for-own", "1.0.0"],
      ]),
    }],
  ])],
  ["parse-glob", new Map([
    ["3.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parse-glob-3.0.4-b2c376cfb11f35513badd173ef0bb6e3a388391c/node_modules/parse-glob/"),
      packageDependencies: new Map([
        ["glob-base", "0.3.0"],
        ["is-dotfile", "1.0.3"],
        ["is-extglob", "1.0.0"],
        ["is-glob", "2.0.1"],
        ["parse-glob", "3.0.4"],
      ]),
    }],
  ])],
  ["glob-base", new Map([
    ["0.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glob-base-0.3.0-dbb164f6221b1c0b1ccf82aea328b497df0ea3c4/node_modules/glob-base/"),
      packageDependencies: new Map([
        ["glob-parent", "2.0.0"],
        ["is-glob", "2.0.1"],
        ["glob-base", "0.3.0"],
      ]),
    }],
  ])],
  ["is-dotfile", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-dotfile-1.0.3-a6a2f32ffd2dfb04f5ca25ecd0f6b83cf798a1e1/node_modules/is-dotfile/"),
      packageDependencies: new Map([
        ["is-dotfile", "1.0.3"],
      ]),
    }],
  ])],
  ["regex-cache", new Map([
    ["0.4.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-regex-cache-0.4.4-75bdc58a2a1496cec48a12835bc54c8d562336dd/node_modules/regex-cache/"),
      packageDependencies: new Map([
        ["is-equal-shallow", "0.1.3"],
        ["regex-cache", "0.4.4"],
      ]),
    }],
  ])],
  ["is-equal-shallow", new Map([
    ["0.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-equal-shallow-0.1.3-2238098fc221de0bcfa5d9eac4c45d638aa1c534/node_modules/is-equal-shallow/"),
      packageDependencies: new Map([
        ["is-primitive", "2.0.0"],
        ["is-equal-shallow", "0.1.3"],
      ]),
    }],
  ])],
  ["is-primitive", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-primitive-2.0.0-207bab91638499c07b2adf240a41a87210034575/node_modules/is-primitive/"),
      packageDependencies: new Map([
        ["is-primitive", "2.0.0"],
      ]),
    }],
  ])],
  ["opn", new Map([
    ["5.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-opn-5.3.0-64871565c863875f052cfdf53d3e3cb5adb53b1c/node_modules/opn/"),
      packageDependencies: new Map([
        ["is-wsl", "1.1.0"],
        ["opn", "5.3.0"],
      ]),
    }],
  ])],
  ["is-wsl", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-wsl-1.1.0-1f16e4aa22b04d1336b66188a66af3c600c3a66d/node_modules/is-wsl/"),
      packageDependencies: new Map([
        ["is-wsl", "1.1.0"],
      ]),
    }],
  ])],
  ["portscanner", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-portscanner-2.1.1-eabb409e4de24950f5a2a516d35ae769343fbb96/node_modules/portscanner/"),
      packageDependencies: new Map([
        ["async", "1.5.2"],
        ["is-number-like", "1.0.8"],
        ["portscanner", "2.1.1"],
      ]),
    }],
  ])],
  ["async", new Map([
    ["1.5.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-1.5.2-ec6a61ae56480c0c3cb241c95618e20892f9672a/node_modules/async/"),
      packageDependencies: new Map([
        ["async", "1.5.2"],
      ]),
    }],
  ])],
  ["is-number-like", new Map([
    ["1.0.8", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-number-like-1.0.8-2e129620b50891042e44e9bbbb30593e75cfbbe3/node_modules/is-number-like/"),
      packageDependencies: new Map([
        ["lodash.isfinite", "3.3.2"],
        ["is-number-like", "1.0.8"],
      ]),
    }],
  ])],
  ["lodash.isfinite", new Map([
    ["3.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lodash-isfinite-3.3.2-fb89b65a9a80281833f0b7478b3a5104f898ebb3/node_modules/lodash.isfinite/"),
      packageDependencies: new Map([
        ["lodash.isfinite", "3.3.2"],
      ]),
    }],
  ])],
  ["qs", new Map([
    ["6.2.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-qs-6.2.3-1cfcb25c10a9b2b483053ff39f5dfc9233908cfe/node_modules/qs/"),
      packageDependencies: new Map([
        ["qs", "6.2.3"],
      ]),
    }],
    ["6.5.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-qs-6.5.2-cb3ae806e8740444584ef154ce8ee98d403f3e36/node_modules/qs/"),
      packageDependencies: new Map([
        ["qs", "6.5.2"],
      ]),
    }],
  ])],
  ["raw-body", new Map([
    ["2.3.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-raw-body-2.3.3-1b324ece6b5706e153855bc1148c65bb7f6ea0c3/node_modules/raw-body/"),
      packageDependencies: new Map([
        ["bytes", "3.0.0"],
        ["http-errors", "1.6.3"],
        ["iconv-lite", "0.4.23"],
        ["unpipe", "1.0.0"],
        ["raw-body", "2.3.3"],
      ]),
    }],
  ])],
  ["bytes", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-bytes-3.0.0-d32815404d689699f85a4ea4fa8755dd13a96048/node_modules/bytes/"),
      packageDependencies: new Map([
        ["bytes", "3.0.0"],
      ]),
    }],
  ])],
  ["http-errors", new Map([
    ["1.6.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-http-errors-1.6.3-8b55680bb4be283a0b5bf4ea2e38580be1d9320d/node_modules/http-errors/"),
      packageDependencies: new Map([
        ["depd", "1.1.2"],
        ["inherits", "2.0.3"],
        ["setprototypeof", "1.1.0"],
        ["statuses", "1.5.0"],
        ["http-errors", "1.6.3"],
      ]),
    }],
  ])],
  ["depd", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-depd-1.1.2-9bcd52e14c097763e749b274c4346ed2e560b5a9/node_modules/depd/"),
      packageDependencies: new Map([
        ["depd", "1.1.2"],
      ]),
    }],
  ])],
  ["setprototypeof", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-setprototypeof-1.1.0-d0bd85536887b6fe7c0d818cb962d9d91c54e656/node_modules/setprototypeof/"),
      packageDependencies: new Map([
        ["setprototypeof", "1.1.0"],
      ]),
    }],
  ])],
  ["iconv-lite", new Map([
    ["0.4.23", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-iconv-lite-0.4.23-297871f63be507adcfbfca715d0cd0eed84e9a63/node_modules/iconv-lite/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
        ["iconv-lite", "0.4.23"],
      ]),
    }],
  ])],
  ["safer-buffer", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-safer-buffer-2.1.2-44fa161b0187b9549dd84bb91802f9bd8385cd6a/node_modules/safer-buffer/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
      ]),
    }],
  ])],
  ["resp-modifier", new Map([
    ["6.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-resp-modifier-6.0.2-b124de5c4fbafcba541f48ffa73970f4aa456b4f/node_modules/resp-modifier/"),
      packageDependencies: new Map([
        ["debug", "2.6.9"],
        ["minimatch", "3.0.4"],
        ["resp-modifier", "6.0.2"],
      ]),
    }],
  ])],
  ["minimatch", new Map([
    ["3.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-minimatch-3.0.4-5166e286457f03306064be5497e8dbb0c3d32083/node_modules/minimatch/"),
      packageDependencies: new Map([
        ["brace-expansion", "1.1.11"],
        ["minimatch", "3.0.4"],
      ]),
    }],
  ])],
  ["brace-expansion", new Map([
    ["1.1.11", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-brace-expansion-1.1.11-3c7fcbf529d87226f3d2f52b966ff5271eb441dd/node_modules/brace-expansion/"),
      packageDependencies: new Map([
        ["balanced-match", "1.0.0"],
        ["concat-map", "0.0.1"],
        ["brace-expansion", "1.1.11"],
      ]),
    }],
  ])],
  ["balanced-match", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-balanced-match-1.0.0-89b4d199ab2bee49de164ea02b89ce462d71b767/node_modules/balanced-match/"),
      packageDependencies: new Map([
        ["balanced-match", "1.0.0"],
      ]),
    }],
  ])],
  ["concat-map", new Map([
    ["0.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-concat-map-0.0.1-d8a96bd77fd68df7793a73036a3ba0d5405d477b/node_modules/concat-map/"),
      packageDependencies: new Map([
        ["concat-map", "0.0.1"],
      ]),
    }],
  ])],
  ["rx", new Map([
    ["4.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-rx-4.1.0-a5f13ff79ef3b740fe30aa803fb09f98805d4782/node_modules/rx/"),
      packageDependencies: new Map([
        ["rx", "4.1.0"],
      ]),
    }],
  ])],
  ["send", new Map([
    ["0.16.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-send-0.16.2-6ecca1e0f8c156d141597559848df64730a6bbc1/node_modules/send/"),
      packageDependencies: new Map([
        ["debug", "2.6.9"],
        ["depd", "1.1.2"],
        ["destroy", "1.0.4"],
        ["encodeurl", "1.0.2"],
        ["escape-html", "1.0.3"],
        ["etag", "1.8.1"],
        ["fresh", "0.5.2"],
        ["http-errors", "1.6.3"],
        ["mime", "1.4.1"],
        ["ms", "2.0.0"],
        ["on-finished", "2.3.0"],
        ["range-parser", "1.2.0"],
        ["statuses", "1.4.0"],
        ["send", "0.16.2"],
      ]),
    }],
  ])],
  ["destroy", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-destroy-1.0.4-978857442c44749e4206613e37946205826abd80/node_modules/destroy/"),
      packageDependencies: new Map([
        ["destroy", "1.0.4"],
      ]),
    }],
  ])],
  ["mime", new Map([
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mime-1.4.1-121f9ebc49e3766f311a76e1fa1c8003c4b03aa6/node_modules/mime/"),
      packageDependencies: new Map([
        ["mime", "1.4.1"],
      ]),
    }],
  ])],
  ["range-parser", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-range-parser-1.2.0-f49be6b487894ddc40dcc94a322f611092e00d5e/node_modules/range-parser/"),
      packageDependencies: new Map([
        ["range-parser", "1.2.0"],
      ]),
    }],
  ])],
  ["serve-index", new Map([
    ["1.9.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-serve-index-1.9.1-d3768d69b1e7d82e5ce050fff5b453bea12a9239/node_modules/serve-index/"),
      packageDependencies: new Map([
        ["accepts", "1.3.5"],
        ["batch", "0.6.1"],
        ["debug", "2.6.9"],
        ["escape-html", "1.0.3"],
        ["http-errors", "1.6.3"],
        ["mime-types", "2.1.22"],
        ["parseurl", "1.3.2"],
        ["serve-index", "1.9.1"],
      ]),
    }],
  ])],
  ["accepts", new Map([
    ["1.3.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-accepts-1.3.5-eb777df6011723a3b14e8a72c0805c8e86746bd2/node_modules/accepts/"),
      packageDependencies: new Map([
        ["mime-types", "2.1.22"],
        ["negotiator", "0.6.1"],
        ["accepts", "1.3.5"],
      ]),
    }],
  ])],
  ["mime-types", new Map([
    ["2.1.22", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mime-types-2.1.22-fe6b355a190926ab7698c9a0556a11199b2199bd/node_modules/mime-types/"),
      packageDependencies: new Map([
        ["mime-db", "1.38.0"],
        ["mime-types", "2.1.22"],
      ]),
    }],
  ])],
  ["mime-db", new Map([
    ["1.38.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mime-db-1.38.0-1a2aab16da9eb167b49c6e4df2d9c68d63d8e2ad/node_modules/mime-db/"),
      packageDependencies: new Map([
        ["mime-db", "1.38.0"],
      ]),
    }],
  ])],
  ["negotiator", new Map([
    ["0.6.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-negotiator-0.6.1-2b327184e8992101177b28563fb5e7102acd0ca9/node_modules/negotiator/"),
      packageDependencies: new Map([
        ["negotiator", "0.6.1"],
      ]),
    }],
  ])],
  ["batch", new Map([
    ["0.6.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-batch-0.6.1-dc34314f4e679318093fc760272525f94bf25c16/node_modules/batch/"),
      packageDependencies: new Map([
        ["batch", "0.6.1"],
      ]),
    }],
  ])],
  ["serve-static", new Map([
    ["1.13.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-serve-static-1.13.2-095e8472fd5b46237db50ce486a43f4b86c6cec1/node_modules/serve-static/"),
      packageDependencies: new Map([
        ["encodeurl", "1.0.2"],
        ["escape-html", "1.0.3"],
        ["parseurl", "1.3.2"],
        ["send", "0.16.2"],
        ["serve-static", "1.13.2"],
      ]),
    }],
  ])],
  ["socket.io", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-socket-io-2.1.1-a069c5feabee3e6b214a75b40ce0652e1cfb9980/node_modules/socket.io/"),
      packageDependencies: new Map([
        ["debug", "3.1.0"],
        ["engine.io", "3.2.1"],
        ["has-binary2", "1.0.3"],
        ["socket.io-adapter", "1.1.1"],
        ["socket.io-client", "2.1.1"],
        ["socket.io-parser", "3.2.0"],
        ["socket.io", "2.1.1"],
      ]),
    }],
  ])],
  ["engine.io", new Map([
    ["3.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-engine-io-3.2.1-b60281c35484a70ee0351ea0ebff83ec8c9522a2/node_modules/engine.io/"),
      packageDependencies: new Map([
        ["accepts", "1.3.5"],
        ["base64id", "1.0.0"],
        ["cookie", "0.3.1"],
        ["debug", "3.1.0"],
        ["engine.io-parser", "2.1.3"],
        ["ws", "3.3.3"],
        ["engine.io", "3.2.1"],
      ]),
    }],
  ])],
  ["base64id", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-base64id-1.0.0-47688cb99bb6804f0e06d3e763b1c32e57d8e6b6/node_modules/base64id/"),
      packageDependencies: new Map([
        ["base64id", "1.0.0"],
      ]),
    }],
  ])],
  ["cookie", new Map([
    ["0.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-cookie-0.3.1-e7e0a1f9ef43b4c8ba925c5c5a96e806d16873bb/node_modules/cookie/"),
      packageDependencies: new Map([
        ["cookie", "0.3.1"],
      ]),
    }],
  ])],
  ["ultron", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ultron-1.1.1-9fe1536a10a664a65266a1e3ccf85fd36302bc9c/node_modules/ultron/"),
      packageDependencies: new Map([
        ["ultron", "1.1.1"],
      ]),
    }],
  ])],
  ["socket.io-adapter", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-socket-io-adapter-1.1.1-2a805e8a14d6372124dd9159ad4502f8cb07f06b/node_modules/socket.io-adapter/"),
      packageDependencies: new Map([
        ["socket.io-adapter", "1.1.1"],
      ]),
    }],
  ])],
  ["ua-parser-js", new Map([
    ["0.7.17", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ua-parser-js-0.7.17-e9ec5f9498b9ec910e7ae3ac626a805c4d09ecac/node_modules/ua-parser-js/"),
      packageDependencies: new Map([
        ["ua-parser-js", "0.7.17"],
      ]),
    }],
  ])],
  ["window-size", new Map([
    ["0.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-window-size-0.2.0-b4315bb4214a3d7058ebeee892e13fa24d98b075/node_modules/window-size/"),
      packageDependencies: new Map([
        ["window-size", "0.2.0"],
      ]),
    }],
  ])],
  ["css-mqpacker", new Map([
    ["7.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-css-mqpacker-7.0.0-48f4a0ff45b81ec661c4a33ed80b9db8a026333b/node_modules/css-mqpacker/"),
      packageDependencies: new Map([
        ["minimist", "1.2.0"],
        ["postcss", "7.0.14"],
        ["css-mqpacker", "7.0.0"],
      ]),
    }],
  ])],
  ["minimist", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-minimist-1.2.0-a35008b20f41383eec1fb914f4cd5df79a264284/node_modules/minimist/"),
      packageDependencies: new Map([
        ["minimist", "1.2.0"],
      ]),
    }],
    ["0.0.8", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-minimist-0.0.8-857fcabfc3397d2625b8228262e86aa7a011b05d/node_modules/minimist/"),
      packageDependencies: new Map([
        ["minimist", "0.0.8"],
      ]),
    }],
  ])],
  ["gulp-plumber", new Map([
    ["1.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-plumber-1.2.1-d38700755a300b9d372318e4ffb5ff7ced0b2c84/node_modules/gulp-plumber/"),
      packageDependencies: new Map([
        ["chalk", "1.1.3"],
        ["fancy-log", "1.3.3"],
        ["plugin-error", "0.1.2"],
        ["through2", "2.0.5"],
        ["gulp-plumber", "1.2.1"],
      ]),
    }],
  ])],
  ["fancy-log", new Map([
    ["1.3.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fancy-log-1.3.3-dbc19154f558690150a23953a0adbd035be45fc7/node_modules/fancy-log/"),
      packageDependencies: new Map([
        ["ansi-gray", "0.1.1"],
        ["color-support", "1.1.3"],
        ["parse-node-version", "1.0.1"],
        ["time-stamp", "1.1.0"],
        ["fancy-log", "1.3.3"],
      ]),
    }],
  ])],
  ["ansi-gray", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-gray-0.1.1-2962cf54ec9792c48510a3deb524436861ef7251/node_modules/ansi-gray/"),
      packageDependencies: new Map([
        ["ansi-wrap", "0.1.0"],
        ["ansi-gray", "0.1.1"],
      ]),
    }],
  ])],
  ["ansi-wrap", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-wrap-0.1.0-a82250ddb0015e9a27ca82e82ea603bbfa45efaf/node_modules/ansi-wrap/"),
      packageDependencies: new Map([
        ["ansi-wrap", "0.1.0"],
      ]),
    }],
  ])],
  ["color-support", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-color-support-1.1.3-93834379a1cc9a0c61f82f52f0d04322251bd5a2/node_modules/color-support/"),
      packageDependencies: new Map([
        ["color-support", "1.1.3"],
      ]),
    }],
  ])],
  ["parse-node-version", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parse-node-version-1.0.1-e2b5dbede00e7fa9bc363607f53327e8b073189b/node_modules/parse-node-version/"),
      packageDependencies: new Map([
        ["parse-node-version", "1.0.1"],
      ]),
    }],
  ])],
  ["time-stamp", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-time-stamp-1.1.0-764a5a11af50561921b133f3b44e618687e0f5c3/node_modules/time-stamp/"),
      packageDependencies: new Map([
        ["time-stamp", "1.1.0"],
      ]),
    }],
  ])],
  ["plugin-error", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-plugin-error-0.1.2-3b9bb3335ccf00f425e07437e19276967da47ace/node_modules/plugin-error/"),
      packageDependencies: new Map([
        ["ansi-cyan", "0.1.1"],
        ["ansi-red", "0.1.1"],
        ["arr-diff", "1.1.0"],
        ["arr-union", "2.1.0"],
        ["extend-shallow", "1.1.4"],
        ["plugin-error", "0.1.2"],
      ]),
    }],
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-plugin-error-1.0.1-77016bd8919d0ac377fdcdd0322328953ca5781c/node_modules/plugin-error/"),
      packageDependencies: new Map([
        ["ansi-colors", "1.1.0"],
        ["arr-diff", "4.0.0"],
        ["arr-union", "3.1.0"],
        ["extend-shallow", "3.0.2"],
        ["plugin-error", "1.0.1"],
      ]),
    }],
  ])],
  ["ansi-cyan", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-cyan-0.1.1-538ae528af8982f28ae30d86f2f17456d2609873/node_modules/ansi-cyan/"),
      packageDependencies: new Map([
        ["ansi-wrap", "0.1.0"],
        ["ansi-cyan", "0.1.1"],
      ]),
    }],
  ])],
  ["ansi-red", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-red-0.1.1-8c638f9d1080800a353c9c28c8a81ca4705d946c/node_modules/ansi-red/"),
      packageDependencies: new Map([
        ["ansi-wrap", "0.1.0"],
        ["ansi-red", "0.1.1"],
      ]),
    }],
  ])],
  ["array-slice", new Map([
    ["0.2.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-slice-0.2.3-dd3cfb80ed7973a75117cdac69b0b99ec86186f5/node_modules/array-slice/"),
      packageDependencies: new Map([
        ["array-slice", "0.2.3"],
      ]),
    }],
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-slice-1.1.0-e368ea15f89bc7069f7ffb89aec3a6c7d4ac22d4/node_modules/array-slice/"),
      packageDependencies: new Map([
        ["array-slice", "1.1.0"],
      ]),
    }],
  ])],
  ["through2", new Map([
    ["2.0.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-through2-2.0.5-01c1e39eb31d07cb7d03a96a70823260b23132cd/node_modules/through2/"),
      packageDependencies: new Map([
        ["readable-stream", "2.3.6"],
        ["xtend", "4.0.1"],
        ["through2", "2.0.5"],
      ]),
    }],
  ])],
  ["xtend", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-xtend-4.0.1-a5c6d532be656e23db820efb943a1f04998d63af/node_modules/xtend/"),
      packageDependencies: new Map([
        ["xtend", "4.0.1"],
      ]),
    }],
  ])],
  ["gulp-postcss", new Map([
    ["8.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-postcss-8.0.0-8d3772cd4d27bca55ec8cb4c8e576e3bde4dc550/node_modules/gulp-postcss/"),
      packageDependencies: new Map([
        ["fancy-log", "1.3.3"],
        ["plugin-error", "1.0.1"],
        ["postcss", "7.0.14"],
        ["postcss-load-config", "2.0.0"],
        ["vinyl-sourcemaps-apply", "0.2.1"],
        ["gulp-postcss", "8.0.0"],
      ]),
    }],
  ])],
  ["ansi-colors", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ansi-colors-1.1.0-6374b4dd5d4718ff3ce27a671a3b1cad077132a9/node_modules/ansi-colors/"),
      packageDependencies: new Map([
        ["ansi-wrap", "0.1.0"],
        ["ansi-colors", "1.1.0"],
      ]),
    }],
  ])],
  ["postcss-load-config", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-postcss-load-config-2.0.0-f1312ddbf5912cd747177083c5ef7a19d62ee484/node_modules/postcss-load-config/"),
      packageDependencies: new Map([
        ["cosmiconfig", "4.0.0"],
        ["import-cwd", "2.1.0"],
        ["postcss-load-config", "2.0.0"],
      ]),
    }],
  ])],
  ["cosmiconfig", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-cosmiconfig-4.0.0-760391549580bbd2df1e562bc177b13c290972dc/node_modules/cosmiconfig/"),
      packageDependencies: new Map([
        ["is-directory", "0.3.1"],
        ["js-yaml", "3.12.2"],
        ["parse-json", "4.0.0"],
        ["require-from-string", "2.0.2"],
        ["cosmiconfig", "4.0.0"],
      ]),
    }],
  ])],
  ["is-directory", new Map([
    ["0.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-directory-0.3.1-61339b6f2475fc772fd9c9d83f5c8575dc154ae1/node_modules/is-directory/"),
      packageDependencies: new Map([
        ["is-directory", "0.3.1"],
      ]),
    }],
  ])],
  ["js-yaml", new Map([
    ["3.12.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-js-yaml-3.12.2-ef1d067c5a9d9cb65bd72f285b5d8105c77f14fc/node_modules/js-yaml/"),
      packageDependencies: new Map([
        ["argparse", "1.0.10"],
        ["esprima", "4.0.1"],
        ["js-yaml", "3.12.2"],
      ]),
    }],
  ])],
  ["argparse", new Map([
    ["1.0.10", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-argparse-1.0.10-bcd6791ea5ae09725e17e5ad988134cd40b3d911/node_modules/argparse/"),
      packageDependencies: new Map([
        ["sprintf-js", "1.0.3"],
        ["argparse", "1.0.10"],
      ]),
    }],
  ])],
  ["sprintf-js", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-sprintf-js-1.0.3-04e6926f662895354f3dd015203633b857297e2c/node_modules/sprintf-js/"),
      packageDependencies: new Map([
        ["sprintf-js", "1.0.3"],
      ]),
    }],
  ])],
  ["esprima", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-esprima-4.0.1-13b04cdb3e6c5d19df91ab6987a8695619b0aa71/node_modules/esprima/"),
      packageDependencies: new Map([
        ["esprima", "4.0.1"],
      ]),
    }],
  ])],
  ["json-parse-better-errors", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-json-parse-better-errors-1.0.2-bb867cfb3450e69107c131d1c514bab3dc8bcaa9/node_modules/json-parse-better-errors/"),
      packageDependencies: new Map([
        ["json-parse-better-errors", "1.0.2"],
      ]),
    }],
  ])],
  ["require-from-string", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-require-from-string-2.0.2-89a7fdd938261267318eafe14f9c32e598c36909/node_modules/require-from-string/"),
      packageDependencies: new Map([
        ["require-from-string", "2.0.2"],
      ]),
    }],
  ])],
  ["import-cwd", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-import-cwd-2.1.0-aa6cf36e722761285cb371ec6519f53e2435b0a9/node_modules/import-cwd/"),
      packageDependencies: new Map([
        ["import-from", "2.1.0"],
        ["import-cwd", "2.1.0"],
      ]),
    }],
  ])],
  ["import-from", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-import-from-2.1.0-335db7f2a7affd53aaa471d4b8021dee36b7f3b1/node_modules/import-from/"),
      packageDependencies: new Map([
        ["resolve-from", "3.0.0"],
        ["import-from", "2.1.0"],
      ]),
    }],
  ])],
  ["resolve-from", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-resolve-from-3.0.0-b22c7af7d9d6881bc8b6e653335eebcb0a188748/node_modules/resolve-from/"),
      packageDependencies: new Map([
        ["resolve-from", "3.0.0"],
      ]),
    }],
  ])],
  ["vinyl-sourcemaps-apply", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-vinyl-sourcemaps-apply-0.2.1-ab6549d61d172c2b1b87be5c508d239c8ef87705/node_modules/vinyl-sourcemaps-apply/"),
      packageDependencies: new Map([
        ["source-map", "0.5.7"],
        ["vinyl-sourcemaps-apply", "0.2.1"],
      ]),
    }],
  ])],
  ["gulp-rename", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-rename-1.4.0-de1c718e7c4095ae861f7296ef4f3248648240bd/node_modules/gulp-rename/"),
      packageDependencies: new Map([
        ["gulp-rename", "1.4.0"],
      ]),
    }],
  ])],
  ["gulp-sass", new Map([
    ["4.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-sass-4.0.2-cfb1e3eff2bd9852431c7ce87f43880807d8d505/node_modules/gulp-sass/"),
      packageDependencies: new Map([
        ["chalk", "2.4.2"],
        ["lodash.clonedeep", "4.5.0"],
        ["node-sass", "4.11.0"],
        ["plugin-error", "1.0.1"],
        ["replace-ext", "1.0.0"],
        ["strip-ansi", "4.0.0"],
        ["through2", "2.0.5"],
        ["vinyl-sourcemaps-apply", "0.2.1"],
        ["gulp-sass", "4.0.2"],
      ]),
    }],
  ])],
  ["lodash.clonedeep", new Map([
    ["4.5.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lodash-clonedeep-4.5.0-e23f3f9c4f8fbdde872529c1071857a086e5ccef/node_modules/lodash.clonedeep/"),
      packageDependencies: new Map([
        ["lodash.clonedeep", "4.5.0"],
      ]),
    }],
  ])],
  ["node-sass", new Map([
    ["4.11.0", {
      packageLocation: path.resolve(__dirname, "./.pnp/unplugged/npm-node-sass-4.11.0-183faec398e9cbe93ba43362e2768ca988a6369a/node_modules/node-sass/"),
      packageDependencies: new Map([
        ["async-foreach", "0.1.3"],
        ["chalk", "1.1.3"],
        ["cross-spawn", "3.0.1"],
        ["gaze", "1.1.3"],
        ["get-stdin", "4.0.1"],
        ["glob", "7.1.3"],
        ["in-publish", "2.0.0"],
        ["lodash.assign", "4.2.0"],
        ["lodash.clonedeep", "4.5.0"],
        ["lodash.mergewith", "4.6.1"],
        ["meow", "3.7.0"],
        ["mkdirp", "0.5.1"],
        ["nan", "2.12.1"],
        ["node-gyp", "3.8.0"],
        ["npmlog", "4.1.2"],
        ["request", "2.88.0"],
        ["sass-graph", "2.2.4"],
        ["stdout-stream", "1.4.1"],
        ["true-case-path", "1.0.3"],
        ["node-sass", "4.11.0"],
      ]),
    }],
  ])],
  ["async-foreach", new Map([
    ["0.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-foreach-0.1.3-36121f845c0578172de419a97dbeb1d16ec34542/node_modules/async-foreach/"),
      packageDependencies: new Map([
        ["async-foreach", "0.1.3"],
      ]),
    }],
  ])],
  ["cross-spawn", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-cross-spawn-3.0.1-1256037ecb9f0c5f79e3d6ef135e30770184b982/node_modules/cross-spawn/"),
      packageDependencies: new Map([
        ["lru-cache", "4.1.5"],
        ["which", "1.3.1"],
        ["cross-spawn", "3.0.1"],
      ]),
    }],
  ])],
  ["lru-cache", new Map([
    ["4.1.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lru-cache-4.1.5-8bbe50ea85bed59bc9e33dcab8235ee9bcf443cd/node_modules/lru-cache/"),
      packageDependencies: new Map([
        ["pseudomap", "1.0.2"],
        ["yallist", "2.1.2"],
        ["lru-cache", "4.1.5"],
      ]),
    }],
  ])],
  ["pseudomap", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pseudomap-1.0.2-f052a28da70e618917ef0a8ac34c1ae5a68286b3/node_modules/pseudomap/"),
      packageDependencies: new Map([
        ["pseudomap", "1.0.2"],
      ]),
    }],
  ])],
  ["yallist", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-yallist-2.1.2-1c11f9218f076089a47dd512f93c6699a6a81d52/node_modules/yallist/"),
      packageDependencies: new Map([
        ["yallist", "2.1.2"],
      ]),
    }],
  ])],
  ["which", new Map([
    ["1.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-which-1.3.1-a45043d54f5805316da8d62f9f50918d3da70b0a/node_modules/which/"),
      packageDependencies: new Map([
        ["isexe", "2.0.0"],
        ["which", "1.3.1"],
      ]),
    }],
  ])],
  ["isexe", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-isexe-2.0.0-e8fbf374dc556ff8947a10dcb0572d633f2cfa10/node_modules/isexe/"),
      packageDependencies: new Map([
        ["isexe", "2.0.0"],
      ]),
    }],
  ])],
  ["gaze", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gaze-1.1.3-c441733e13b927ac8c0ff0b4c3b033f28812924a/node_modules/gaze/"),
      packageDependencies: new Map([
        ["globule", "1.2.1"],
        ["gaze", "1.1.3"],
      ]),
    }],
  ])],
  ["globule", new Map([
    ["1.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-globule-1.2.1-5dffb1b191f22d20797a9369b49eab4e9839696d/node_modules/globule/"),
      packageDependencies: new Map([
        ["glob", "7.1.3"],
        ["lodash", "4.17.11"],
        ["minimatch", "3.0.4"],
        ["globule", "1.2.1"],
      ]),
    }],
  ])],
  ["glob", new Map([
    ["7.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glob-7.1.3-3960832d3f1574108342dafd3a67b332c0969df1/node_modules/glob/"),
      packageDependencies: new Map([
        ["fs.realpath", "1.0.0"],
        ["inflight", "1.0.6"],
        ["inherits", "2.0.3"],
        ["minimatch", "3.0.4"],
        ["once", "1.4.0"],
        ["path-is-absolute", "1.0.1"],
        ["glob", "7.1.3"],
      ]),
    }],
  ])],
  ["fs.realpath", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fs-realpath-1.0.0-1504ad2523158caa40db4a2787cb01411994ea4f/node_modules/fs.realpath/"),
      packageDependencies: new Map([
        ["fs.realpath", "1.0.0"],
      ]),
    }],
  ])],
  ["inflight", new Map([
    ["1.0.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-inflight-1.0.6-49bd6331d7d02d0c09bc910a1075ba8165b56df9/node_modules/inflight/"),
      packageDependencies: new Map([
        ["once", "1.4.0"],
        ["wrappy", "1.0.2"],
        ["inflight", "1.0.6"],
      ]),
    }],
  ])],
  ["once", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-once-1.4.0-583b1aa775961d4b113ac17d9c50baef9dd76bd1/node_modules/once/"),
      packageDependencies: new Map([
        ["wrappy", "1.0.2"],
        ["once", "1.4.0"],
      ]),
    }],
  ])],
  ["wrappy", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-wrappy-1.0.2-b5243d8f3ec1aa35f1364605bc0d1036e30ab69f/node_modules/wrappy/"),
      packageDependencies: new Map([
        ["wrappy", "1.0.2"],
      ]),
    }],
  ])],
  ["get-stdin", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-get-stdin-4.0.1-b968c6b0a04384324902e8bf1a5df32579a450fe/node_modules/get-stdin/"),
      packageDependencies: new Map([
        ["get-stdin", "4.0.1"],
      ]),
    }],
  ])],
  ["in-publish", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-in-publish-2.0.0-e20ff5e3a2afc2690320b6dc552682a9c7fadf51/node_modules/in-publish/"),
      packageDependencies: new Map([
        ["in-publish", "2.0.0"],
      ]),
    }],
  ])],
  ["lodash.assign", new Map([
    ["4.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lodash-assign-4.2.0-0d99f3ccd7a6d261d19bdaeb9245005d285808e7/node_modules/lodash.assign/"),
      packageDependencies: new Map([
        ["lodash.assign", "4.2.0"],
      ]),
    }],
  ])],
  ["lodash.mergewith", new Map([
    ["4.6.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lodash-mergewith-4.6.1-639057e726c3afbdb3e7d42741caa8d6e4335927/node_modules/lodash.mergewith/"),
      packageDependencies: new Map([
        ["lodash.mergewith", "4.6.1"],
      ]),
    }],
  ])],
  ["meow", new Map([
    ["3.7.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-meow-3.7.0-72cb668b425228290abbfa856892587308a801fb/node_modules/meow/"),
      packageDependencies: new Map([
        ["camelcase-keys", "2.1.0"],
        ["decamelize", "1.2.0"],
        ["loud-rejection", "1.6.0"],
        ["map-obj", "1.0.1"],
        ["minimist", "1.2.0"],
        ["normalize-package-data", "2.5.0"],
        ["object-assign", "4.1.1"],
        ["read-pkg-up", "1.0.1"],
        ["redent", "1.0.0"],
        ["trim-newlines", "1.0.0"],
        ["meow", "3.7.0"],
      ]),
    }],
  ])],
  ["camelcase-keys", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-camelcase-keys-2.1.0-308beeaffdf28119051efa1d932213c91b8f92e7/node_modules/camelcase-keys/"),
      packageDependencies: new Map([
        ["camelcase", "2.1.1"],
        ["map-obj", "1.0.1"],
        ["camelcase-keys", "2.1.0"],
      ]),
    }],
  ])],
  ["map-obj", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-map-obj-1.0.1-d933ceb9205d82bdcf4886f6742bdc2b4dea146d/node_modules/map-obj/"),
      packageDependencies: new Map([
        ["map-obj", "1.0.1"],
      ]),
    }],
  ])],
  ["loud-rejection", new Map([
    ["1.6.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-loud-rejection-1.6.0-5b46f80147edee578870f086d04821cf998e551f/node_modules/loud-rejection/"),
      packageDependencies: new Map([
        ["currently-unhandled", "0.4.1"],
        ["signal-exit", "3.0.2"],
        ["loud-rejection", "1.6.0"],
      ]),
    }],
  ])],
  ["currently-unhandled", new Map([
    ["0.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-currently-unhandled-0.4.1-988df33feab191ef799a61369dd76c17adf957ea/node_modules/currently-unhandled/"),
      packageDependencies: new Map([
        ["array-find-index", "1.0.2"],
        ["currently-unhandled", "0.4.1"],
      ]),
    }],
  ])],
  ["array-find-index", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-find-index-1.0.2-df010aa1287e164bbda6f9723b0a96a1ec4187a1/node_modules/array-find-index/"),
      packageDependencies: new Map([
        ["array-find-index", "1.0.2"],
      ]),
    }],
  ])],
  ["signal-exit", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-signal-exit-3.0.2-b5fdc08f1287ea1178628e415e25132b73646c6d/node_modules/signal-exit/"),
      packageDependencies: new Map([
        ["signal-exit", "3.0.2"],
      ]),
    }],
  ])],
  ["object-assign", new Map([
    ["4.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-assign-4.1.1-2109adc7965887cfc05cbbd442cac8bfbb360863/node_modules/object-assign/"),
      packageDependencies: new Map([
        ["object-assign", "4.1.1"],
      ]),
    }],
  ])],
  ["redent", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-redent-1.0.0-cf916ab1fd5f1f16dfb20822dd6ec7f730c2afde/node_modules/redent/"),
      packageDependencies: new Map([
        ["indent-string", "2.1.0"],
        ["strip-indent", "1.0.1"],
        ["redent", "1.0.0"],
      ]),
    }],
  ])],
  ["indent-string", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-indent-string-2.1.0-8e2d48348742121b4a8218b7a137e9a52049dc80/node_modules/indent-string/"),
      packageDependencies: new Map([
        ["repeating", "2.0.1"],
        ["indent-string", "2.1.0"],
      ]),
    }],
  ])],
  ["repeating", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-repeating-2.0.1-5214c53a926d3552707527fbab415dbc08d06dda/node_modules/repeating/"),
      packageDependencies: new Map([
        ["is-finite", "1.0.2"],
        ["repeating", "2.0.1"],
      ]),
    }],
  ])],
  ["is-finite", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-finite-1.0.2-cc6677695602be550ef11e8b4aa6305342b6d0aa/node_modules/is-finite/"),
      packageDependencies: new Map([
        ["number-is-nan", "1.0.1"],
        ["is-finite", "1.0.2"],
      ]),
    }],
  ])],
  ["strip-indent", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-strip-indent-1.0.1-0c7962a6adefa7bbd4ac366460a638552ae1a0a2/node_modules/strip-indent/"),
      packageDependencies: new Map([
        ["get-stdin", "4.0.1"],
        ["strip-indent", "1.0.1"],
      ]),
    }],
  ])],
  ["trim-newlines", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-trim-newlines-1.0.0-5887966bb582a4503a41eb524f7d35011815a613/node_modules/trim-newlines/"),
      packageDependencies: new Map([
        ["trim-newlines", "1.0.0"],
      ]),
    }],
  ])],
  ["mkdirp", new Map([
    ["0.5.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mkdirp-0.5.1-30057438eac6cf7f8c4767f38648d6697d75c903/node_modules/mkdirp/"),
      packageDependencies: new Map([
        ["minimist", "0.0.8"],
        ["mkdirp", "0.5.1"],
      ]),
    }],
  ])],
  ["nan", new Map([
    ["2.12.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-nan-2.12.1-7b1aa193e9aa86057e3c7bbd0ac448e770925552/node_modules/nan/"),
      packageDependencies: new Map([
        ["nan", "2.12.1"],
      ]),
    }],
  ])],
  ["node-gyp", new Map([
    ["3.8.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-node-gyp-3.8.0-540304261c330e80d0d5edce253a68cb3964218c/node_modules/node-gyp/"),
      packageDependencies: new Map([
        ["fstream", "1.0.11"],
        ["glob", "7.1.3"],
        ["graceful-fs", "4.1.15"],
        ["mkdirp", "0.5.1"],
        ["nopt", "3.0.6"],
        ["npmlog", "4.1.2"],
        ["osenv", "0.1.5"],
        ["request", "2.88.0"],
        ["rimraf", "2.6.3"],
        ["semver", "5.3.0"],
        ["tar", "2.2.1"],
        ["which", "1.3.1"],
        ["node-gyp", "3.8.0"],
      ]),
    }],
  ])],
  ["fstream", new Map([
    ["1.0.11", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fstream-1.0.11-5c1fb1f117477114f0632a0eb4b71b3cb0fd3171/node_modules/fstream/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["inherits", "2.0.3"],
        ["mkdirp", "0.5.1"],
        ["rimraf", "2.6.3"],
        ["fstream", "1.0.11"],
      ]),
    }],
  ])],
  ["rimraf", new Map([
    ["2.6.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-rimraf-2.6.3-b2d104fe0d8fb27cf9e0a1cda8262dd3833c6cab/node_modules/rimraf/"),
      packageDependencies: new Map([
        ["glob", "7.1.3"],
        ["rimraf", "2.6.3"],
      ]),
    }],
  ])],
  ["nopt", new Map([
    ["3.0.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-nopt-3.0.6-c6465dbf08abcd4db359317f79ac68a646b28ff9/node_modules/nopt/"),
      packageDependencies: new Map([
        ["abbrev", "1.1.1"],
        ["nopt", "3.0.6"],
      ]),
    }],
  ])],
  ["abbrev", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-abbrev-1.1.1-f8f2c887ad10bf67f634f005b6987fed3179aac8/node_modules/abbrev/"),
      packageDependencies: new Map([
        ["abbrev", "1.1.1"],
      ]),
    }],
  ])],
  ["npmlog", new Map([
    ["4.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-npmlog-4.1.2-08a7f2a8bf734604779a9efa4ad5cc717abb954b/node_modules/npmlog/"),
      packageDependencies: new Map([
        ["are-we-there-yet", "1.1.5"],
        ["console-control-strings", "1.1.0"],
        ["gauge", "2.7.4"],
        ["set-blocking", "2.0.0"],
        ["npmlog", "4.1.2"],
      ]),
    }],
  ])],
  ["are-we-there-yet", new Map([
    ["1.1.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-are-we-there-yet-1.1.5-4b35c2944f062a8bfcda66410760350fe9ddfc21/node_modules/are-we-there-yet/"),
      packageDependencies: new Map([
        ["delegates", "1.0.0"],
        ["readable-stream", "2.3.6"],
        ["are-we-there-yet", "1.1.5"],
      ]),
    }],
  ])],
  ["delegates", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-delegates-1.0.0-84c6e159b81904fdca59a0ef44cd870d31250f9a/node_modules/delegates/"),
      packageDependencies: new Map([
        ["delegates", "1.0.0"],
      ]),
    }],
  ])],
  ["console-control-strings", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-console-control-strings-1.1.0-3d7cf4464db6446ea644bf4b39507f9851008e8e/node_modules/console-control-strings/"),
      packageDependencies: new Map([
        ["console-control-strings", "1.1.0"],
      ]),
    }],
  ])],
  ["gauge", new Map([
    ["2.7.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gauge-2.7.4-2c03405c7538c39d7eb37b317022e325fb018bf7/node_modules/gauge/"),
      packageDependencies: new Map([
        ["aproba", "1.2.0"],
        ["console-control-strings", "1.1.0"],
        ["has-unicode", "2.0.1"],
        ["object-assign", "4.1.1"],
        ["signal-exit", "3.0.2"],
        ["string-width", "1.0.2"],
        ["strip-ansi", "3.0.1"],
        ["wide-align", "1.1.3"],
        ["gauge", "2.7.4"],
      ]),
    }],
  ])],
  ["aproba", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-aproba-1.2.0-6802e6264efd18c790a1b0d517f0f2627bf2c94a/node_modules/aproba/"),
      packageDependencies: new Map([
        ["aproba", "1.2.0"],
      ]),
    }],
  ])],
  ["has-unicode", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-unicode-2.0.1-e0e6fe6a28cf51138855e086d1691e771de2a8b9/node_modules/has-unicode/"),
      packageDependencies: new Map([
        ["has-unicode", "2.0.1"],
      ]),
    }],
  ])],
  ["wide-align", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-wide-align-1.1.3-ae074e6bdc0c14a431e804e624549c633b000457/node_modules/wide-align/"),
      packageDependencies: new Map([
        ["string-width", "2.1.1"],
        ["wide-align", "1.1.3"],
      ]),
    }],
  ])],
  ["osenv", new Map([
    ["0.1.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-osenv-0.1.5-85cdfafaeb28e8677f416e287592b5f3f49ea410/node_modules/osenv/"),
      packageDependencies: new Map([
        ["os-homedir", "1.0.2"],
        ["os-tmpdir", "1.0.2"],
        ["osenv", "0.1.5"],
      ]),
    }],
  ])],
  ["os-homedir", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-os-homedir-1.0.2-ffbc4988336e0e833de0c168c7ef152121aa7fb3/node_modules/os-homedir/"),
      packageDependencies: new Map([
        ["os-homedir", "1.0.2"],
      ]),
    }],
  ])],
  ["os-tmpdir", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-os-tmpdir-1.0.2-bbe67406c79aa85c5cfec766fe5734555dfa1274/node_modules/os-tmpdir/"),
      packageDependencies: new Map([
        ["os-tmpdir", "1.0.2"],
      ]),
    }],
  ])],
  ["request", new Map([
    ["2.88.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-request-2.88.0-9c2fca4f7d35b592efe57c7f0a55e81052124fef/node_modules/request/"),
      packageDependencies: new Map([
        ["aws-sign2", "0.7.0"],
        ["aws4", "1.8.0"],
        ["caseless", "0.12.0"],
        ["combined-stream", "1.0.7"],
        ["extend", "3.0.2"],
        ["forever-agent", "0.6.1"],
        ["form-data", "2.3.3"],
        ["har-validator", "5.1.3"],
        ["http-signature", "1.2.0"],
        ["is-typedarray", "1.0.0"],
        ["isstream", "0.1.2"],
        ["json-stringify-safe", "5.0.1"],
        ["mime-types", "2.1.22"],
        ["oauth-sign", "0.9.0"],
        ["performance-now", "2.1.0"],
        ["qs", "6.5.2"],
        ["safe-buffer", "5.1.2"],
        ["tough-cookie", "2.4.3"],
        ["tunnel-agent", "0.6.0"],
        ["uuid", "3.3.2"],
        ["request", "2.88.0"],
      ]),
    }],
  ])],
  ["aws-sign2", new Map([
    ["0.7.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-aws-sign2-0.7.0-b46e890934a9591f2d2f6f86d7e6a9f1b3fe76a8/node_modules/aws-sign2/"),
      packageDependencies: new Map([
        ["aws-sign2", "0.7.0"],
      ]),
    }],
  ])],
  ["aws4", new Map([
    ["1.8.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-aws4-1.8.0-f0e003d9ca9e7f59c7a508945d7b2ef9a04a542f/node_modules/aws4/"),
      packageDependencies: new Map([
        ["aws4", "1.8.0"],
      ]),
    }],
  ])],
  ["caseless", new Map([
    ["0.12.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-caseless-0.12.0-1b681c21ff84033c826543090689420d187151dc/node_modules/caseless/"),
      packageDependencies: new Map([
        ["caseless", "0.12.0"],
      ]),
    }],
  ])],
  ["combined-stream", new Map([
    ["1.0.7", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-combined-stream-1.0.7-2d1d24317afb8abe95d6d2c0b07b57813539d828/node_modules/combined-stream/"),
      packageDependencies: new Map([
        ["delayed-stream", "1.0.0"],
        ["combined-stream", "1.0.7"],
      ]),
    }],
  ])],
  ["delayed-stream", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-delayed-stream-1.0.0-df3ae199acadfb7d440aaae0b29e2272b24ec619/node_modules/delayed-stream/"),
      packageDependencies: new Map([
        ["delayed-stream", "1.0.0"],
      ]),
    }],
  ])],
  ["extend", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extend-3.0.2-f8b1136b4071fbd8eb140aff858b1019ec2915fa/node_modules/extend/"),
      packageDependencies: new Map([
        ["extend", "3.0.2"],
      ]),
    }],
  ])],
  ["forever-agent", new Map([
    ["0.6.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-forever-agent-0.6.1-fbc71f0c41adeb37f96c577ad1ed42d8fdacca91/node_modules/forever-agent/"),
      packageDependencies: new Map([
        ["forever-agent", "0.6.1"],
      ]),
    }],
  ])],
  ["form-data", new Map([
    ["2.3.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-form-data-2.3.3-dcce52c05f644f298c6a7ab936bd724ceffbf3a6/node_modules/form-data/"),
      packageDependencies: new Map([
        ["asynckit", "0.4.0"],
        ["combined-stream", "1.0.7"],
        ["mime-types", "2.1.22"],
        ["form-data", "2.3.3"],
      ]),
    }],
  ])],
  ["asynckit", new Map([
    ["0.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-asynckit-0.4.0-c79ed97f7f34cb8f2ba1bc9790bcc366474b4b79/node_modules/asynckit/"),
      packageDependencies: new Map([
        ["asynckit", "0.4.0"],
      ]),
    }],
  ])],
  ["har-validator", new Map([
    ["5.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-har-validator-5.1.3-1ef89ebd3e4996557675eed9893110dc350fa080/node_modules/har-validator/"),
      packageDependencies: new Map([
        ["ajv", "6.10.0"],
        ["har-schema", "2.0.0"],
        ["har-validator", "5.1.3"],
      ]),
    }],
  ])],
  ["ajv", new Map([
    ["6.10.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ajv-6.10.0-90d0d54439da587cd7e843bfb7045f50bd22bdf1/node_modules/ajv/"),
      packageDependencies: new Map([
        ["fast-deep-equal", "2.0.1"],
        ["fast-json-stable-stringify", "2.0.0"],
        ["json-schema-traverse", "0.4.1"],
        ["uri-js", "4.2.2"],
        ["ajv", "6.10.0"],
      ]),
    }],
  ])],
  ["fast-deep-equal", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fast-deep-equal-2.0.1-7b05218ddf9667bf7f370bf7fdb2cb15fdd0aa49/node_modules/fast-deep-equal/"),
      packageDependencies: new Map([
        ["fast-deep-equal", "2.0.1"],
      ]),
    }],
  ])],
  ["fast-json-stable-stringify", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fast-json-stable-stringify-2.0.0-d5142c0caee6b1189f87d3a76111064f86c8bbf2/node_modules/fast-json-stable-stringify/"),
      packageDependencies: new Map([
        ["fast-json-stable-stringify", "2.0.0"],
      ]),
    }],
  ])],
  ["json-schema-traverse", new Map([
    ["0.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-json-schema-traverse-0.4.1-69f6a87d9513ab8bb8fe63bdb0979c448e684660/node_modules/json-schema-traverse/"),
      packageDependencies: new Map([
        ["json-schema-traverse", "0.4.1"],
      ]),
    }],
  ])],
  ["uri-js", new Map([
    ["4.2.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-uri-js-4.2.2-94c540e1ff772956e2299507c010aea6c8838eb0/node_modules/uri-js/"),
      packageDependencies: new Map([
        ["punycode", "2.1.1"],
        ["uri-js", "4.2.2"],
      ]),
    }],
  ])],
  ["punycode", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-punycode-2.1.1-b58b010ac40c22c5657616c8d2c2c02c7bf479ec/node_modules/punycode/"),
      packageDependencies: new Map([
        ["punycode", "2.1.1"],
      ]),
    }],
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-punycode-1.4.1-c0d5a63b2718800ad8e1eb0fa5269c84dd41845e/node_modules/punycode/"),
      packageDependencies: new Map([
        ["punycode", "1.4.1"],
      ]),
    }],
  ])],
  ["har-schema", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-har-schema-2.0.0-a94c2224ebcac04782a0d9035521f24735b7ec92/node_modules/har-schema/"),
      packageDependencies: new Map([
        ["har-schema", "2.0.0"],
      ]),
    }],
  ])],
  ["http-signature", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-http-signature-1.2.0-9aecd925114772f3d95b65a60abb8f7c18fbace1/node_modules/http-signature/"),
      packageDependencies: new Map([
        ["assert-plus", "1.0.0"],
        ["jsprim", "1.4.1"],
        ["sshpk", "1.16.1"],
        ["http-signature", "1.2.0"],
      ]),
    }],
  ])],
  ["assert-plus", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-assert-plus-1.0.0-f12e0f3c5d77b0b1cdd9146942e4e96c1e4dd525/node_modules/assert-plus/"),
      packageDependencies: new Map([
        ["assert-plus", "1.0.0"],
      ]),
    }],
  ])],
  ["jsprim", new Map([
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-jsprim-1.4.1-313e66bc1e5cc06e438bc1b7499c2e5c56acb6a2/node_modules/jsprim/"),
      packageDependencies: new Map([
        ["assert-plus", "1.0.0"],
        ["extsprintf", "1.3.0"],
        ["json-schema", "0.2.3"],
        ["verror", "1.10.0"],
        ["jsprim", "1.4.1"],
      ]),
    }],
  ])],
  ["extsprintf", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extsprintf-1.3.0-96918440e3041a7a414f8c52e3c574eb3c3e1e05/node_modules/extsprintf/"),
      packageDependencies: new Map([
        ["extsprintf", "1.3.0"],
      ]),
    }],
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-extsprintf-1.4.0-e2689f8f356fad62cca65a3a91c5df5f9551692f/node_modules/extsprintf/"),
      packageDependencies: new Map([
        ["extsprintf", "1.4.0"],
      ]),
    }],
  ])],
  ["json-schema", new Map([
    ["0.2.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-json-schema-0.2.3-b480c892e59a2f05954ce727bd3f2a4e882f9e13/node_modules/json-schema/"),
      packageDependencies: new Map([
        ["json-schema", "0.2.3"],
      ]),
    }],
  ])],
  ["verror", new Map([
    ["1.10.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-verror-1.10.0-3a105ca17053af55d6e270c1f8288682e18da400/node_modules/verror/"),
      packageDependencies: new Map([
        ["assert-plus", "1.0.0"],
        ["core-util-is", "1.0.2"],
        ["extsprintf", "1.4.0"],
        ["verror", "1.10.0"],
      ]),
    }],
  ])],
  ["sshpk", new Map([
    ["1.16.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-sshpk-1.16.1-fb661c0bef29b39db40769ee39fa70093d6f6877/node_modules/sshpk/"),
      packageDependencies: new Map([
        ["asn1", "0.2.4"],
        ["assert-plus", "1.0.0"],
        ["bcrypt-pbkdf", "1.0.2"],
        ["dashdash", "1.14.1"],
        ["ecc-jsbn", "0.1.2"],
        ["getpass", "0.1.7"],
        ["jsbn", "0.1.1"],
        ["safer-buffer", "2.1.2"],
        ["tweetnacl", "0.14.5"],
        ["sshpk", "1.16.1"],
      ]),
    }],
  ])],
  ["asn1", new Map([
    ["0.2.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-asn1-0.2.4-8d2475dfab553bb33e77b54e59e880bb8ce23136/node_modules/asn1/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
        ["asn1", "0.2.4"],
      ]),
    }],
  ])],
  ["bcrypt-pbkdf", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-bcrypt-pbkdf-1.0.2-a4301d389b6a43f9b67ff3ca11a3f6637e360e9e/node_modules/bcrypt-pbkdf/"),
      packageDependencies: new Map([
        ["tweetnacl", "0.14.5"],
        ["bcrypt-pbkdf", "1.0.2"],
      ]),
    }],
  ])],
  ["tweetnacl", new Map([
    ["0.14.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-tweetnacl-0.14.5-5ae68177f192d4456269d108afa93ff8743f4f64/node_modules/tweetnacl/"),
      packageDependencies: new Map([
        ["tweetnacl", "0.14.5"],
      ]),
    }],
  ])],
  ["dashdash", new Map([
    ["1.14.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-dashdash-1.14.1-853cfa0f7cbe2fed5de20326b8dd581035f6e2f0/node_modules/dashdash/"),
      packageDependencies: new Map([
        ["assert-plus", "1.0.0"],
        ["dashdash", "1.14.1"],
      ]),
    }],
  ])],
  ["ecc-jsbn", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ecc-jsbn-0.1.2-3a83a904e54353287874c564b7549386849a98c9/node_modules/ecc-jsbn/"),
      packageDependencies: new Map([
        ["jsbn", "0.1.1"],
        ["safer-buffer", "2.1.2"],
        ["ecc-jsbn", "0.1.2"],
      ]),
    }],
  ])],
  ["jsbn", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-jsbn-0.1.1-a5e654c2e5a2deb5f201d96cefbca80c0ef2f513/node_modules/jsbn/"),
      packageDependencies: new Map([
        ["jsbn", "0.1.1"],
      ]),
    }],
  ])],
  ["getpass", new Map([
    ["0.1.7", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-getpass-0.1.7-5eff8e3e684d569ae4cb2b1282604e8ba62149fa/node_modules/getpass/"),
      packageDependencies: new Map([
        ["assert-plus", "1.0.0"],
        ["getpass", "0.1.7"],
      ]),
    }],
  ])],
  ["is-typedarray", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-typedarray-1.0.0-e479c80858df0c1b11ddda6940f96011fcda4a9a/node_modules/is-typedarray/"),
      packageDependencies: new Map([
        ["is-typedarray", "1.0.0"],
      ]),
    }],
  ])],
  ["isstream", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-isstream-0.1.2-47e63f7af55afa6f92e1500e690eb8b8529c099a/node_modules/isstream/"),
      packageDependencies: new Map([
        ["isstream", "0.1.2"],
      ]),
    }],
  ])],
  ["json-stringify-safe", new Map([
    ["5.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-json-stringify-safe-5.0.1-1296a2d58fd45f19a0f6ce01d65701e2c735b6eb/node_modules/json-stringify-safe/"),
      packageDependencies: new Map([
        ["json-stringify-safe", "5.0.1"],
      ]),
    }],
  ])],
  ["oauth-sign", new Map([
    ["0.9.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-oauth-sign-0.9.0-47a7b016baa68b5fa0ecf3dee08a85c679ac6455/node_modules/oauth-sign/"),
      packageDependencies: new Map([
        ["oauth-sign", "0.9.0"],
      ]),
    }],
  ])],
  ["performance-now", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-performance-now-2.1.0-6309f4e0e5fa913ec1c69307ae364b4b377c9e7b/node_modules/performance-now/"),
      packageDependencies: new Map([
        ["performance-now", "2.1.0"],
      ]),
    }],
  ])],
  ["tough-cookie", new Map([
    ["2.4.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-tough-cookie-2.4.3-53f36da3f47783b0925afa06ff9f3b165280f781/node_modules/tough-cookie/"),
      packageDependencies: new Map([
        ["psl", "1.1.31"],
        ["punycode", "1.4.1"],
        ["tough-cookie", "2.4.3"],
      ]),
    }],
  ])],
  ["psl", new Map([
    ["1.1.31", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-psl-1.1.31-e9aa86d0101b5b105cbe93ac6b784cd547276184/node_modules/psl/"),
      packageDependencies: new Map([
        ["psl", "1.1.31"],
      ]),
    }],
  ])],
  ["tunnel-agent", new Map([
    ["0.6.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-tunnel-agent-0.6.0-27a5dea06b36b04a0a9966774b290868f0fc40fd/node_modules/tunnel-agent/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["tunnel-agent", "0.6.0"],
      ]),
    }],
  ])],
  ["uuid", new Map([
    ["3.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-uuid-3.3.2-1b4af4955eb3077c501c23872fc6513811587131/node_modules/uuid/"),
      packageDependencies: new Map([
        ["uuid", "3.3.2"],
      ]),
    }],
  ])],
  ["tar", new Map([
    ["2.2.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-tar-2.2.1-8e4d2a256c0e2185c6b18ad694aec968b83cb1d1/node_modules/tar/"),
      packageDependencies: new Map([
        ["block-stream", "0.0.9"],
        ["fstream", "1.0.11"],
        ["inherits", "2.0.3"],
        ["tar", "2.2.1"],
      ]),
    }],
  ])],
  ["block-stream", new Map([
    ["0.0.9", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-block-stream-0.0.9-13ebfe778a03205cfe03751481ebb4b3300c126a/node_modules/block-stream/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["block-stream", "0.0.9"],
      ]),
    }],
  ])],
  ["sass-graph", new Map([
    ["2.2.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-sass-graph-2.2.4-13fbd63cd1caf0908b9fd93476ad43a51d1e0b49/node_modules/sass-graph/"),
      packageDependencies: new Map([
        ["glob", "7.1.3"],
        ["lodash", "4.17.11"],
        ["scss-tokenizer", "0.2.3"],
        ["yargs", "7.1.0"],
        ["sass-graph", "2.2.4"],
      ]),
    }],
  ])],
  ["scss-tokenizer", new Map([
    ["0.2.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-scss-tokenizer-0.2.3-8eb06db9a9723333824d3f5530641149847ce5d1/node_modules/scss-tokenizer/"),
      packageDependencies: new Map([
        ["js-base64", "2.5.1"],
        ["source-map", "0.4.4"],
        ["scss-tokenizer", "0.2.3"],
      ]),
    }],
  ])],
  ["js-base64", new Map([
    ["2.5.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-js-base64-2.5.1-1efa39ef2c5f7980bb1784ade4a8af2de3291121/node_modules/js-base64/"),
      packageDependencies: new Map([
        ["js-base64", "2.5.1"],
      ]),
    }],
  ])],
  ["amdefine", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-amdefine-1.0.1-4a5282ac164729e93619bcfd3ad151f817ce91f5/node_modules/amdefine/"),
      packageDependencies: new Map([
        ["amdefine", "1.0.1"],
      ]),
    }],
  ])],
  ["stdout-stream", new Map([
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-stdout-stream-1.4.1-5ac174cdd5cd726104aa0c0b2bd83815d8d535de/node_modules/stdout-stream/"),
      packageDependencies: new Map([
        ["readable-stream", "2.3.6"],
        ["stdout-stream", "1.4.1"],
      ]),
    }],
  ])],
  ["true-case-path", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-true-case-path-1.0.3-f813b5a8c86b40da59606722b144e3225799f47d/node_modules/true-case-path/"),
      packageDependencies: new Map([
        ["glob", "7.1.3"],
        ["true-case-path", "1.0.3"],
      ]),
    }],
  ])],
  ["replace-ext", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-replace-ext-1.0.0-de63128373fcbf7c3ccfa4de5a480c45a67958eb/node_modules/replace-ext/"),
      packageDependencies: new Map([
        ["replace-ext", "1.0.0"],
      ]),
    }],
  ])],
  ["gulp-sourcemaps", new Map([
    ["2.6.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-sourcemaps-2.6.5-a3f002d87346d2c0f3aec36af7eb873f23de8ae6/node_modules/gulp-sourcemaps/"),
      packageDependencies: new Map([
        ["@gulp-sourcemaps/identity-map", "1.0.2"],
        ["@gulp-sourcemaps/map-sources", "1.0.0"],
        ["acorn", "5.7.3"],
        ["convert-source-map", "1.6.0"],
        ["css", "2.2.4"],
        ["debug-fabulous", "1.1.0"],
        ["detect-newline", "2.1.0"],
        ["graceful-fs", "4.1.15"],
        ["source-map", "0.6.1"],
        ["strip-bom-string", "1.0.0"],
        ["through2", "2.0.5"],
        ["gulp-sourcemaps", "2.6.5"],
      ]),
    }],
  ])],
  ["@gulp-sourcemaps/identity-map", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-@gulp-sourcemaps-identity-map-1.0.2-1e6fe5d8027b1f285dc0d31762f566bccd73d5a9/node_modules/@gulp-sourcemaps/identity-map/"),
      packageDependencies: new Map([
        ["acorn", "5.7.3"],
        ["css", "2.2.4"],
        ["normalize-path", "2.1.1"],
        ["source-map", "0.6.1"],
        ["through2", "2.0.5"],
        ["@gulp-sourcemaps/identity-map", "1.0.2"],
      ]),
    }],
  ])],
  ["acorn", new Map([
    ["5.7.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-acorn-5.7.3-67aa231bf8812974b85235a96771eb6bd07ea279/node_modules/acorn/"),
      packageDependencies: new Map([
        ["acorn", "5.7.3"],
      ]),
    }],
  ])],
  ["css", new Map([
    ["2.2.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-css-2.2.4-c646755c73971f2bba6a601e2cf2fd71b1298929/node_modules/css/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["source-map", "0.6.1"],
        ["source-map-resolve", "0.5.2"],
        ["urix", "0.1.0"],
        ["css", "2.2.4"],
      ]),
    }],
  ])],
  ["@gulp-sourcemaps/map-sources", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-@gulp-sourcemaps-map-sources-1.0.0-890ae7c5d8c877f6d384860215ace9d7ec945bda/node_modules/@gulp-sourcemaps/map-sources/"),
      packageDependencies: new Map([
        ["normalize-path", "2.1.1"],
        ["through2", "2.0.5"],
        ["@gulp-sourcemaps/map-sources", "1.0.0"],
      ]),
    }],
  ])],
  ["convert-source-map", new Map([
    ["1.6.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-convert-source-map-1.6.0-51b537a8c43e0f04dec1993bffcdd504e758ac20/node_modules/convert-source-map/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["convert-source-map", "1.6.0"],
      ]),
    }],
  ])],
  ["debug-fabulous", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-debug-fabulous-1.1.0-af8a08632465224ef4174a9f06308c3c2a1ebc8e/node_modules/debug-fabulous/"),
      packageDependencies: new Map([
        ["debug", "3.2.6"],
        ["memoizee", "0.4.14"],
        ["object-assign", "4.1.1"],
        ["debug-fabulous", "1.1.0"],
      ]),
    }],
  ])],
  ["memoizee", new Map([
    ["0.4.14", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-memoizee-0.4.14-07a00f204699f9a95c2d9e77218271c7cd610d57/node_modules/memoizee/"),
      packageDependencies: new Map([
        ["d", "1.0.0"],
        ["es5-ext", "0.10.49"],
        ["es6-weak-map", "2.0.2"],
        ["event-emitter", "0.3.5"],
        ["is-promise", "2.1.0"],
        ["lru-queue", "0.1.0"],
        ["next-tick", "1.0.0"],
        ["timers-ext", "0.1.7"],
        ["memoizee", "0.4.14"],
      ]),
    }],
  ])],
  ["d", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-d-1.0.0-754bb5bfe55451da69a58b94d45f4c5b0462d58f/node_modules/d/"),
      packageDependencies: new Map([
        ["es5-ext", "0.10.49"],
        ["d", "1.0.0"],
      ]),
    }],
  ])],
  ["es5-ext", new Map([
    ["0.10.49", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-es5-ext-0.10.49-059a239de862c94494fec28f8150c977028c6c5e/node_modules/es5-ext/"),
      packageDependencies: new Map([
        ["es6-iterator", "2.0.3"],
        ["es6-symbol", "3.1.1"],
        ["next-tick", "1.0.0"],
        ["es5-ext", "0.10.49"],
      ]),
    }],
  ])],
  ["es6-iterator", new Map([
    ["2.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-es6-iterator-2.0.3-a7de889141a05a94b0854403b2d0a0fbfa98f3b7/node_modules/es6-iterator/"),
      packageDependencies: new Map([
        ["d", "1.0.0"],
        ["es5-ext", "0.10.49"],
        ["es6-symbol", "3.1.1"],
        ["es6-iterator", "2.0.3"],
      ]),
    }],
  ])],
  ["es6-symbol", new Map([
    ["3.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-es6-symbol-3.1.1-bf00ef4fdab6ba1b46ecb7b629b4c7ed5715cc77/node_modules/es6-symbol/"),
      packageDependencies: new Map([
        ["d", "1.0.0"],
        ["es5-ext", "0.10.49"],
        ["es6-symbol", "3.1.1"],
      ]),
    }],
  ])],
  ["next-tick", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-next-tick-1.0.0-ca86d1fe8828169b0120208e3dc8424b9db8342c/node_modules/next-tick/"),
      packageDependencies: new Map([
        ["next-tick", "1.0.0"],
      ]),
    }],
  ])],
  ["es6-weak-map", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-es6-weak-map-2.0.2-5e3ab32251ffd1538a1f8e5ffa1357772f92d96f/node_modules/es6-weak-map/"),
      packageDependencies: new Map([
        ["d", "1.0.0"],
        ["es5-ext", "0.10.49"],
        ["es6-iterator", "2.0.3"],
        ["es6-symbol", "3.1.1"],
        ["es6-weak-map", "2.0.2"],
      ]),
    }],
  ])],
  ["event-emitter", new Map([
    ["0.3.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-event-emitter-0.3.5-df8c69eef1647923c7157b9ce83840610b02cc39/node_modules/event-emitter/"),
      packageDependencies: new Map([
        ["d", "1.0.0"],
        ["es5-ext", "0.10.49"],
        ["event-emitter", "0.3.5"],
      ]),
    }],
  ])],
  ["is-promise", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-promise-2.1.0-79a2a9ece7f096e80f36d2b2f3bc16c1ff4bf3fa/node_modules/is-promise/"),
      packageDependencies: new Map([
        ["is-promise", "2.1.0"],
      ]),
    }],
  ])],
  ["lru-queue", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lru-queue-0.1.0-2738bd9f0d3cf4f84490c5736c48699ac632cda3/node_modules/lru-queue/"),
      packageDependencies: new Map([
        ["es5-ext", "0.10.49"],
        ["lru-queue", "0.1.0"],
      ]),
    }],
  ])],
  ["timers-ext", new Map([
    ["0.1.7", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-timers-ext-0.1.7-6f57ad8578e07a3fb9f91d9387d65647555e25c6/node_modules/timers-ext/"),
      packageDependencies: new Map([
        ["es5-ext", "0.10.49"],
        ["next-tick", "1.0.0"],
        ["timers-ext", "0.1.7"],
      ]),
    }],
  ])],
  ["detect-newline", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-detect-newline-2.1.0-f41f1c10be4b00e87b5f13da680759f2c5bfd3e2/node_modules/detect-newline/"),
      packageDependencies: new Map([
        ["detect-newline", "2.1.0"],
      ]),
    }],
  ])],
  ["strip-bom-string", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-strip-bom-string-1.0.0-e5211e9224369fbb81d633a2f00044dc8cedad92/node_modules/strip-bom-string/"),
      packageDependencies: new Map([
        ["strip-bom-string", "1.0.0"],
      ]),
    }],
  ])],
  ["gulp-uglify-es", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-uglify-es-1.0.4-59ee0d5ea98c1e09c6eaa58c8b018a6ad33f48d4/node_modules/gulp-uglify-es/"),
      packageDependencies: new Map([
        ["o-stream", "0.2.2"],
        ["plugin-error", "1.0.1"],
        ["terser", "3.17.0"],
        ["vinyl", "2.2.0"],
        ["vinyl-sourcemaps-apply", "0.2.1"],
        ["gulp-uglify-es", "1.0.4"],
      ]),
    }],
  ])],
  ["o-stream", new Map([
    ["0.2.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-o-stream-0.2.2-7fe03af870b8f9537af33b312b381b3034ab410f/node_modules/o-stream/"),
      packageDependencies: new Map([
        ["o-stream", "0.2.2"],
      ]),
    }],
  ])],
  ["terser", new Map([
    ["3.17.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-terser-3.17.0-f88ffbeda0deb5637f9d24b0da66f4e15ab10cb2/node_modules/terser/"),
      packageDependencies: new Map([
        ["commander", "2.19.0"],
        ["source-map", "0.6.1"],
        ["source-map-support", "0.5.10"],
        ["terser", "3.17.0"],
      ]),
    }],
  ])],
  ["source-map-support", new Map([
    ["0.5.10", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-source-map-support-0.5.10-2214080bc9d51832511ee2bab96e3c2f9353120c/node_modules/source-map-support/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
        ["source-map", "0.6.1"],
        ["source-map-support", "0.5.10"],
      ]),
    }],
  ])],
  ["buffer-from", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-buffer-from-1.1.1-32713bc028f75c02fdb710d7c7bcec1f2c6070ef/node_modules/buffer-from/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
      ]),
    }],
  ])],
  ["vinyl", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-vinyl-2.2.0-d85b07da96e458d25b2ffe19fece9f2caa13ed86/node_modules/vinyl/"),
      packageDependencies: new Map([
        ["clone", "2.1.2"],
        ["clone-buffer", "1.0.0"],
        ["clone-stats", "1.0.0"],
        ["cloneable-readable", "1.1.2"],
        ["remove-trailing-separator", "1.1.0"],
        ["replace-ext", "1.0.0"],
        ["vinyl", "2.2.0"],
      ]),
    }],
  ])],
  ["clone", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-clone-2.1.2-1b7f4b9f591f1e8f83670401600345a02887435f/node_modules/clone/"),
      packageDependencies: new Map([
        ["clone", "2.1.2"],
      ]),
    }],
  ])],
  ["clone-buffer", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-clone-buffer-1.0.0-e3e25b207ac4e701af721e2cb5a16792cac3dc58/node_modules/clone-buffer/"),
      packageDependencies: new Map([
        ["clone-buffer", "1.0.0"],
      ]),
    }],
  ])],
  ["clone-stats", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-clone-stats-1.0.0-b3782dff8bb5474e18b9b6bf0fdfe782f8777680/node_modules/clone-stats/"),
      packageDependencies: new Map([
        ["clone-stats", "1.0.0"],
      ]),
    }],
  ])],
  ["cloneable-readable", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-cloneable-readable-1.1.2-d591dee4a8f8bc15da43ce97dceeba13d43e2a65/node_modules/cloneable-readable/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["process-nextick-args", "2.0.0"],
        ["readable-stream", "2.3.6"],
        ["cloneable-readable", "1.1.2"],
      ]),
    }],
  ])],
  ["gulp", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-4.0.0-95766c601dade4a77ed3e7b2b6dc03881b596366/node_modules/gulp/"),
      packageDependencies: new Map([
        ["glob-watcher", "5.0.3"],
        ["gulp-cli", "2.0.1"],
        ["undertaker", "1.2.0"],
        ["vinyl-fs", "3.0.3"],
        ["gulp", "4.0.0"],
      ]),
    }],
  ])],
  ["glob-watcher", new Map([
    ["5.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glob-watcher-5.0.3-88a8abf1c4d131eb93928994bc4a593c2e5dd626/node_modules/glob-watcher/"),
      packageDependencies: new Map([
        ["anymatch", "2.0.0"],
        ["async-done", "1.3.1"],
        ["chokidar", "2.1.2"],
        ["is-negated-glob", "1.0.0"],
        ["just-debounce", "1.0.0"],
        ["object.defaults", "1.1.0"],
        ["glob-watcher", "5.0.3"],
      ]),
    }],
  ])],
  ["async-done", new Map([
    ["1.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-done-1.3.1-14b7b73667b864c8f02b5b253fc9c6eddb777f3e/node_modules/async-done/"),
      packageDependencies: new Map([
        ["end-of-stream", "1.4.1"],
        ["once", "1.4.0"],
        ["process-nextick-args", "1.0.7"],
        ["stream-exhaust", "1.0.2"],
        ["async-done", "1.3.1"],
      ]),
    }],
  ])],
  ["end-of-stream", new Map([
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-end-of-stream-1.4.1-ed29634d19baba463b6ce6b80a37213eab71ec43/node_modules/end-of-stream/"),
      packageDependencies: new Map([
        ["once", "1.4.0"],
        ["end-of-stream", "1.4.1"],
      ]),
    }],
  ])],
  ["stream-exhaust", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-stream-exhaust-1.0.2-acdac8da59ef2bc1e17a2c0ccf6c320d120e555d/node_modules/stream-exhaust/"),
      packageDependencies: new Map([
        ["stream-exhaust", "1.0.2"],
      ]),
    }],
  ])],
  ["is-negated-glob", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-negated-glob-1.0.0-6910bca5da8c95e784b5751b976cf5a10fee36d2/node_modules/is-negated-glob/"),
      packageDependencies: new Map([
        ["is-negated-glob", "1.0.0"],
      ]),
    }],
  ])],
  ["just-debounce", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-just-debounce-1.0.0-87fccfaeffc0b68cd19d55f6722943f929ea35ea/node_modules/just-debounce/"),
      packageDependencies: new Map([
        ["just-debounce", "1.0.0"],
      ]),
    }],
  ])],
  ["object.defaults", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-defaults-1.1.0-3a7f868334b407dea06da16d88d5cd29e435fecf/node_modules/object.defaults/"),
      packageDependencies: new Map([
        ["array-each", "1.0.1"],
        ["array-slice", "1.1.0"],
        ["for-own", "1.0.0"],
        ["isobject", "3.0.1"],
        ["object.defaults", "1.1.0"],
      ]),
    }],
  ])],
  ["array-each", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-each-1.0.1-a794af0c05ab1752846ee753a1f211a05ba0c44f/node_modules/array-each/"),
      packageDependencies: new Map([
        ["array-each", "1.0.1"],
      ]),
    }],
  ])],
  ["gulp-cli", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulp-cli-2.0.1-7847e220cb3662f2be8a6d572bf14e17be5a994b/node_modules/gulp-cli/"),
      packageDependencies: new Map([
        ["ansi-colors", "1.1.0"],
        ["archy", "1.0.0"],
        ["array-sort", "1.0.0"],
        ["color-support", "1.1.3"],
        ["concat-stream", "1.6.2"],
        ["copy-props", "2.0.4"],
        ["fancy-log", "1.3.3"],
        ["gulplog", "1.0.0"],
        ["interpret", "1.2.0"],
        ["isobject", "3.0.1"],
        ["liftoff", "2.5.0"],
        ["matchdep", "2.0.0"],
        ["mute-stdout", "1.0.1"],
        ["pretty-hrtime", "1.0.3"],
        ["replace-homedir", "1.0.0"],
        ["semver-greatest-satisfied-range", "1.1.0"],
        ["v8flags", "3.1.2"],
        ["yargs", "7.1.0"],
        ["gulp-cli", "2.0.1"],
      ]),
    }],
  ])],
  ["archy", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-archy-1.0.0-f9c8c13757cc1dd7bc379ac77b2c62a5c2868c40/node_modules/archy/"),
      packageDependencies: new Map([
        ["archy", "1.0.0"],
      ]),
    }],
  ])],
  ["array-sort", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-sort-1.0.0-e4c05356453f56f53512a7d1d6123f2c54c0a88a/node_modules/array-sort/"),
      packageDependencies: new Map([
        ["default-compare", "1.0.0"],
        ["get-value", "2.0.6"],
        ["kind-of", "5.1.0"],
        ["array-sort", "1.0.0"],
      ]),
    }],
  ])],
  ["default-compare", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-default-compare-1.0.0-cb61131844ad84d84788fb68fd01681ca7781a2f/node_modules/default-compare/"),
      packageDependencies: new Map([
        ["kind-of", "5.1.0"],
        ["default-compare", "1.0.0"],
      ]),
    }],
  ])],
  ["concat-stream", new Map([
    ["1.6.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-concat-stream-1.6.2-904bdf194cd3122fc675c77fc4ac3d4ff0fd1a34/node_modules/concat-stream/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["typedarray", "0.0.6"],
        ["concat-stream", "1.6.2"],
      ]),
    }],
  ])],
  ["typedarray", new Map([
    ["0.0.6", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-typedarray-0.0.6-867ac74e3864187b1d3d47d996a78ec5c8830777/node_modules/typedarray/"),
      packageDependencies: new Map([
        ["typedarray", "0.0.6"],
      ]),
    }],
  ])],
  ["copy-props", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-copy-props-2.0.4-93bb1cadfafd31da5bb8a9d4b41f471ec3a72dfe/node_modules/copy-props/"),
      packageDependencies: new Map([
        ["each-props", "1.3.2"],
        ["is-plain-object", "2.0.4"],
        ["copy-props", "2.0.4"],
      ]),
    }],
  ])],
  ["each-props", new Map([
    ["1.3.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-each-props-1.3.2-ea45a414d16dd5cfa419b1a81720d5ca06892333/node_modules/each-props/"),
      packageDependencies: new Map([
        ["is-plain-object", "2.0.4"],
        ["object.defaults", "1.1.0"],
        ["each-props", "1.3.2"],
      ]),
    }],
  ])],
  ["gulplog", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-gulplog-1.0.0-e28c4d45d05ecbbed818363ce8f9c5926229ffe5/node_modules/gulplog/"),
      packageDependencies: new Map([
        ["glogg", "1.0.2"],
        ["gulplog", "1.0.0"],
      ]),
    }],
  ])],
  ["glogg", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glogg-1.0.2-2d7dd702beda22eb3bffadf880696da6d846313f/node_modules/glogg/"),
      packageDependencies: new Map([
        ["sparkles", "1.0.1"],
        ["glogg", "1.0.2"],
      ]),
    }],
  ])],
  ["sparkles", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-sparkles-1.0.1-008db65edce6c50eec0c5e228e1945061dd0437c/node_modules/sparkles/"),
      packageDependencies: new Map([
        ["sparkles", "1.0.1"],
      ]),
    }],
  ])],
  ["interpret", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-interpret-1.2.0-d5061a6224be58e8083985f5014d844359576296/node_modules/interpret/"),
      packageDependencies: new Map([
        ["interpret", "1.2.0"],
      ]),
    }],
  ])],
  ["liftoff", new Map([
    ["2.5.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-liftoff-2.5.0-2009291bb31cea861bbf10a7c15a28caf75c31ec/node_modules/liftoff/"),
      packageDependencies: new Map([
        ["extend", "3.0.2"],
        ["findup-sync", "2.0.0"],
        ["fined", "1.1.1"],
        ["flagged-respawn", "1.0.1"],
        ["is-plain-object", "2.0.4"],
        ["object.map", "1.0.1"],
        ["rechoir", "0.6.2"],
        ["resolve", "1.10.0"],
        ["liftoff", "2.5.0"],
      ]),
    }],
  ])],
  ["findup-sync", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-findup-sync-2.0.0-9326b1488c22d1a6088650a86901b2d9a90a2cbc/node_modules/findup-sync/"),
      packageDependencies: new Map([
        ["detect-file", "1.0.0"],
        ["is-glob", "3.1.0"],
        ["micromatch", "3.1.10"],
        ["resolve-dir", "1.0.1"],
        ["findup-sync", "2.0.0"],
      ]),
    }],
  ])],
  ["detect-file", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-detect-file-1.0.0-f0d66d03672a825cb1b73bdb3fe62310c8e552b7/node_modules/detect-file/"),
      packageDependencies: new Map([
        ["detect-file", "1.0.0"],
      ]),
    }],
  ])],
  ["resolve-dir", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-resolve-dir-1.0.1-79a40644c362be82f26effe739c9bb5382046f43/node_modules/resolve-dir/"),
      packageDependencies: new Map([
        ["expand-tilde", "2.0.2"],
        ["global-modules", "1.0.0"],
        ["resolve-dir", "1.0.1"],
      ]),
    }],
  ])],
  ["expand-tilde", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-expand-tilde-2.0.2-97e801aa052df02454de46b02bf621642cdc8502/node_modules/expand-tilde/"),
      packageDependencies: new Map([
        ["homedir-polyfill", "1.0.3"],
        ["expand-tilde", "2.0.2"],
      ]),
    }],
  ])],
  ["homedir-polyfill", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-homedir-polyfill-1.0.3-743298cef4e5af3e194161fbadcc2151d3a058e8/node_modules/homedir-polyfill/"),
      packageDependencies: new Map([
        ["parse-passwd", "1.0.0"],
        ["homedir-polyfill", "1.0.3"],
      ]),
    }],
  ])],
  ["parse-passwd", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parse-passwd-1.0.0-6d5b934a456993b23d37f40a382d6f1666a8e5c6/node_modules/parse-passwd/"),
      packageDependencies: new Map([
        ["parse-passwd", "1.0.0"],
      ]),
    }],
  ])],
  ["global-modules", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-global-modules-1.0.0-6d770f0eb523ac78164d72b5e71a8877265cc3ea/node_modules/global-modules/"),
      packageDependencies: new Map([
        ["global-prefix", "1.0.2"],
        ["is-windows", "1.0.2"],
        ["resolve-dir", "1.0.1"],
        ["global-modules", "1.0.0"],
      ]),
    }],
  ])],
  ["global-prefix", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-global-prefix-1.0.2-dbf743c6c14992593c655568cb66ed32c0122ebe/node_modules/global-prefix/"),
      packageDependencies: new Map([
        ["expand-tilde", "2.0.2"],
        ["homedir-polyfill", "1.0.3"],
        ["ini", "1.3.5"],
        ["is-windows", "1.0.2"],
        ["which", "1.3.1"],
        ["global-prefix", "1.0.2"],
      ]),
    }],
  ])],
  ["ini", new Map([
    ["1.3.5", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ini-1.3.5-eee25f56db1c9ec6085e0c22778083f596abf927/node_modules/ini/"),
      packageDependencies: new Map([
        ["ini", "1.3.5"],
      ]),
    }],
  ])],
  ["fined", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fined-1.1.1-95d88ff329123dd1a6950fdfcd321f746271e01f/node_modules/fined/"),
      packageDependencies: new Map([
        ["expand-tilde", "2.0.2"],
        ["is-plain-object", "2.0.4"],
        ["object.defaults", "1.1.0"],
        ["object.pick", "1.3.0"],
        ["parse-filepath", "1.0.2"],
        ["fined", "1.1.1"],
      ]),
    }],
  ])],
  ["parse-filepath", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-parse-filepath-1.0.2-a632127f53aaf3d15876f5872f3ffac763d6c891/node_modules/parse-filepath/"),
      packageDependencies: new Map([
        ["is-absolute", "1.0.0"],
        ["map-cache", "0.2.2"],
        ["path-root", "0.1.1"],
        ["parse-filepath", "1.0.2"],
      ]),
    }],
  ])],
  ["is-absolute", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-absolute-1.0.0-395e1ae84b11f26ad1795e73c17378e48a301576/node_modules/is-absolute/"),
      packageDependencies: new Map([
        ["is-relative", "1.0.0"],
        ["is-windows", "1.0.2"],
        ["is-absolute", "1.0.0"],
      ]),
    }],
  ])],
  ["is-relative", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-relative-1.0.0-a1bb6935ce8c5dba1e8b9754b9b2dcc020e2260d/node_modules/is-relative/"),
      packageDependencies: new Map([
        ["is-unc-path", "1.0.0"],
        ["is-relative", "1.0.0"],
      ]),
    }],
  ])],
  ["is-unc-path", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-unc-path-1.0.0-d731e8898ed090a12c352ad2eaed5095ad322c9d/node_modules/is-unc-path/"),
      packageDependencies: new Map([
        ["unc-path-regex", "0.1.2"],
        ["is-unc-path", "1.0.0"],
      ]),
    }],
  ])],
  ["unc-path-regex", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-unc-path-regex-0.1.2-e73dd3d7b0d7c5ed86fbac6b0ae7d8c6a69d50fa/node_modules/unc-path-regex/"),
      packageDependencies: new Map([
        ["unc-path-regex", "0.1.2"],
      ]),
    }],
  ])],
  ["path-root", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-root-0.1.1-9a4a6814cac1c0cd73360a95f32083c8ea4745b7/node_modules/path-root/"),
      packageDependencies: new Map([
        ["path-root-regex", "0.1.2"],
        ["path-root", "0.1.1"],
      ]),
    }],
  ])],
  ["path-root-regex", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-path-root-regex-0.1.2-bfccdc8df5b12dc52c8b43ec38d18d72c04ba96d/node_modules/path-root-regex/"),
      packageDependencies: new Map([
        ["path-root-regex", "0.1.2"],
      ]),
    }],
  ])],
  ["flagged-respawn", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-flagged-respawn-1.0.1-e7de6f1279ddd9ca9aac8a5971d618606b3aab41/node_modules/flagged-respawn/"),
      packageDependencies: new Map([
        ["flagged-respawn", "1.0.1"],
      ]),
    }],
  ])],
  ["object.map", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-map-1.0.1-cf83e59dc8fcc0ad5f4250e1f78b3b81bd801d37/node_modules/object.map/"),
      packageDependencies: new Map([
        ["for-own", "1.0.0"],
        ["make-iterator", "1.0.1"],
        ["object.map", "1.0.1"],
      ]),
    }],
  ])],
  ["make-iterator", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-make-iterator-1.0.1-29b33f312aa8f547c4a5e490f56afcec99133ad6/node_modules/make-iterator/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
        ["make-iterator", "1.0.1"],
      ]),
    }],
  ])],
  ["rechoir", new Map([
    ["0.6.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-rechoir-0.6.2-85204b54dba82d5742e28c96756ef43af50e3384/node_modules/rechoir/"),
      packageDependencies: new Map([
        ["resolve", "1.10.0"],
        ["rechoir", "0.6.2"],
      ]),
    }],
  ])],
  ["matchdep", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-matchdep-2.0.0-c6f34834a0d8dbc3b37c27ee8bbcb27c7775582e/node_modules/matchdep/"),
      packageDependencies: new Map([
        ["findup-sync", "2.0.0"],
        ["micromatch", "3.1.10"],
        ["resolve", "1.10.0"],
        ["stack-trace", "0.0.10"],
        ["matchdep", "2.0.0"],
      ]),
    }],
  ])],
  ["stack-trace", new Map([
    ["0.0.10", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-stack-trace-0.0.10-547c70b347e8d32b4e108ea1a2a159e5fdde19c0/node_modules/stack-trace/"),
      packageDependencies: new Map([
        ["stack-trace", "0.0.10"],
      ]),
    }],
  ])],
  ["mute-stdout", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-mute-stdout-1.0.1-acb0300eb4de23a7ddeec014e3e96044b3472331/node_modules/mute-stdout/"),
      packageDependencies: new Map([
        ["mute-stdout", "1.0.1"],
      ]),
    }],
  ])],
  ["pretty-hrtime", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pretty-hrtime-1.0.3-b7e3ea42435a4c9b2759d99e0f201eb195802ee1/node_modules/pretty-hrtime/"),
      packageDependencies: new Map([
        ["pretty-hrtime", "1.0.3"],
      ]),
    }],
  ])],
  ["replace-homedir", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-replace-homedir-1.0.0-e87f6d513b928dde808260c12be7fec6ff6e798c/node_modules/replace-homedir/"),
      packageDependencies: new Map([
        ["homedir-polyfill", "1.0.3"],
        ["is-absolute", "1.0.0"],
        ["remove-trailing-separator", "1.1.0"],
        ["replace-homedir", "1.0.0"],
      ]),
    }],
  ])],
  ["semver-greatest-satisfied-range", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-semver-greatest-satisfied-range-1.1.0-13e8c2658ab9691cb0cd71093240280d36f77a5b/node_modules/semver-greatest-satisfied-range/"),
      packageDependencies: new Map([
        ["sver-compat", "1.5.0"],
        ["semver-greatest-satisfied-range", "1.1.0"],
      ]),
    }],
  ])],
  ["sver-compat", new Map([
    ["1.5.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-sver-compat-1.5.0-3cf87dfeb4d07b4a3f14827bc186b3fd0c645cd8/node_modules/sver-compat/"),
      packageDependencies: new Map([
        ["es6-iterator", "2.0.3"],
        ["es6-symbol", "3.1.1"],
        ["sver-compat", "1.5.0"],
      ]),
    }],
  ])],
  ["v8flags", new Map([
    ["3.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-v8flags-3.1.2-fc5cd0c227428181e6c29b2992e4f8f1da5e0c9f/node_modules/v8flags/"),
      packageDependencies: new Map([
        ["homedir-polyfill", "1.0.3"],
        ["v8flags", "3.1.2"],
      ]),
    }],
  ])],
  ["undertaker", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-undertaker-1.2.0-339da4646252d082dc378e708067299750e11b49/node_modules/undertaker/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
        ["arr-map", "2.0.2"],
        ["bach", "1.2.0"],
        ["collection-map", "1.0.0"],
        ["es6-weak-map", "2.0.2"],
        ["last-run", "1.1.1"],
        ["object.defaults", "1.1.0"],
        ["object.reduce", "1.0.1"],
        ["undertaker-registry", "1.0.1"],
        ["undertaker", "1.2.0"],
      ]),
    }],
  ])],
  ["arr-map", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-map-2.0.2-3a77345ffc1cf35e2a91825601f9e58f2e24cac4/node_modules/arr-map/"),
      packageDependencies: new Map([
        ["make-iterator", "1.0.1"],
        ["arr-map", "2.0.2"],
      ]),
    }],
  ])],
  ["bach", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-bach-1.2.0-4b3ce96bf27134f79a1b414a51c14e34c3bd9880/node_modules/bach/"),
      packageDependencies: new Map([
        ["arr-filter", "1.1.2"],
        ["arr-flatten", "1.1.0"],
        ["arr-map", "2.0.2"],
        ["array-each", "1.0.1"],
        ["array-initial", "1.1.0"],
        ["array-last", "1.3.0"],
        ["async-done", "1.3.1"],
        ["async-settle", "1.0.0"],
        ["now-and-later", "2.0.0"],
        ["bach", "1.2.0"],
      ]),
    }],
  ])],
  ["arr-filter", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-arr-filter-1.1.2-43fdddd091e8ef11aa4c45d9cdc18e2dff1711ee/node_modules/arr-filter/"),
      packageDependencies: new Map([
        ["make-iterator", "1.0.1"],
        ["arr-filter", "1.1.2"],
      ]),
    }],
  ])],
  ["array-initial", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-initial-1.1.0-2fa74b26739371c3947bd7a7adc73be334b3d795/node_modules/array-initial/"),
      packageDependencies: new Map([
        ["array-slice", "1.1.0"],
        ["is-number", "4.0.0"],
        ["array-initial", "1.1.0"],
      ]),
    }],
  ])],
  ["array-last", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-array-last-1.3.0-7aa77073fec565ddab2493f5f88185f404a9d336/node_modules/array-last/"),
      packageDependencies: new Map([
        ["is-number", "4.0.0"],
        ["array-last", "1.3.0"],
      ]),
    }],
  ])],
  ["async-settle", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-async-settle-1.0.0-1d0a914bb02575bec8a8f3a74e5080f72b2c0c6b/node_modules/async-settle/"),
      packageDependencies: new Map([
        ["async-done", "1.3.1"],
        ["async-settle", "1.0.0"],
      ]),
    }],
  ])],
  ["now-and-later", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-now-and-later-2.0.0-bc61cbb456d79cb32207ce47ca05136ff2e7d6ee/node_modules/now-and-later/"),
      packageDependencies: new Map([
        ["once", "1.4.0"],
        ["now-and-later", "2.0.0"],
      ]),
    }],
  ])],
  ["collection-map", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-collection-map-1.0.0-aea0f06f8d26c780c2b75494385544b2255af18c/node_modules/collection-map/"),
      packageDependencies: new Map([
        ["arr-map", "2.0.2"],
        ["for-own", "1.0.0"],
        ["make-iterator", "1.0.1"],
        ["collection-map", "1.0.0"],
      ]),
    }],
  ])],
  ["last-run", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-last-run-1.1.1-45b96942c17b1c79c772198259ba943bebf8ca5b/node_modules/last-run/"),
      packageDependencies: new Map([
        ["default-resolution", "2.0.0"],
        ["es6-weak-map", "2.0.2"],
        ["last-run", "1.1.1"],
      ]),
    }],
  ])],
  ["default-resolution", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-default-resolution-2.0.0-bcb82baa72ad79b426a76732f1a81ad6df26d684/node_modules/default-resolution/"),
      packageDependencies: new Map([
        ["default-resolution", "2.0.0"],
      ]),
    }],
  ])],
  ["object.reduce", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-reduce-1.0.1-6fe348f2ac7fa0f95ca621226599096825bb03ad/node_modules/object.reduce/"),
      packageDependencies: new Map([
        ["for-own", "1.0.0"],
        ["make-iterator", "1.0.1"],
        ["object.reduce", "1.0.1"],
      ]),
    }],
  ])],
  ["undertaker-registry", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-undertaker-registry-1.0.1-5e4bda308e4a8a2ae584f9b9a4359a499825cc50/node_modules/undertaker-registry/"),
      packageDependencies: new Map([
        ["undertaker-registry", "1.0.1"],
      ]),
    }],
  ])],
  ["vinyl-fs", new Map([
    ["3.0.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-vinyl-fs-3.0.3-c85849405f67428feabbbd5c5dbdd64f47d31bc7/node_modules/vinyl-fs/"),
      packageDependencies: new Map([
        ["fs-mkdirp-stream", "1.0.0"],
        ["glob-stream", "6.1.0"],
        ["graceful-fs", "4.1.15"],
        ["is-valid-glob", "1.0.0"],
        ["lazystream", "1.0.0"],
        ["lead", "1.0.0"],
        ["object.assign", "4.1.0"],
        ["pumpify", "1.5.1"],
        ["readable-stream", "2.3.6"],
        ["remove-bom-buffer", "3.0.0"],
        ["remove-bom-stream", "1.2.0"],
        ["resolve-options", "1.1.0"],
        ["through2", "2.0.5"],
        ["to-through", "2.0.0"],
        ["value-or-function", "3.0.0"],
        ["vinyl", "2.2.0"],
        ["vinyl-sourcemap", "1.1.0"],
        ["vinyl-fs", "3.0.3"],
      ]),
    }],
  ])],
  ["fs-mkdirp-stream", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-fs-mkdirp-stream-1.0.0-0b7815fc3201c6a69e14db98ce098c16935259eb/node_modules/fs-mkdirp-stream/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["through2", "2.0.5"],
        ["fs-mkdirp-stream", "1.0.0"],
      ]),
    }],
  ])],
  ["glob-stream", new Map([
    ["6.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-glob-stream-6.1.0-7045c99413b3eb94888d83ab46d0b404cc7bdde4/node_modules/glob-stream/"),
      packageDependencies: new Map([
        ["extend", "3.0.2"],
        ["glob", "7.1.3"],
        ["glob-parent", "3.1.0"],
        ["is-negated-glob", "1.0.0"],
        ["ordered-read-streams", "1.0.1"],
        ["pumpify", "1.5.1"],
        ["readable-stream", "2.3.6"],
        ["remove-trailing-separator", "1.1.0"],
        ["to-absolute-glob", "2.0.2"],
        ["unique-stream", "2.3.1"],
        ["glob-stream", "6.1.0"],
      ]),
    }],
  ])],
  ["ordered-read-streams", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-ordered-read-streams-1.0.1-77c0cb37c41525d64166d990ffad7ec6a0e1363e/node_modules/ordered-read-streams/"),
      packageDependencies: new Map([
        ["readable-stream", "2.3.6"],
        ["ordered-read-streams", "1.0.1"],
      ]),
    }],
  ])],
  ["pumpify", new Map([
    ["1.5.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pumpify-1.5.1-36513be246ab27570b1a374a5ce278bfd74370ce/node_modules/pumpify/"),
      packageDependencies: new Map([
        ["duplexify", "3.7.1"],
        ["inherits", "2.0.3"],
        ["pump", "2.0.1"],
        ["pumpify", "1.5.1"],
      ]),
    }],
  ])],
  ["duplexify", new Map([
    ["3.7.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-duplexify-3.7.1-2a4df5317f6ccfd91f86d6fd25d8d8a103b88309/node_modules/duplexify/"),
      packageDependencies: new Map([
        ["end-of-stream", "1.4.1"],
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["stream-shift", "1.0.0"],
        ["duplexify", "3.7.1"],
      ]),
    }],
  ])],
  ["stream-shift", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-stream-shift-1.0.0-d5c752825e5367e786f78e18e445ea223a155952/node_modules/stream-shift/"),
      packageDependencies: new Map([
        ["stream-shift", "1.0.0"],
      ]),
    }],
  ])],
  ["pump", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-pump-2.0.1-12399add6e4cf7526d973cbc8b5ce2e2908b3909/node_modules/pump/"),
      packageDependencies: new Map([
        ["end-of-stream", "1.4.1"],
        ["once", "1.4.0"],
        ["pump", "2.0.1"],
      ]),
    }],
  ])],
  ["to-absolute-glob", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-to-absolute-glob-2.0.2-1865f43d9e74b0822db9f145b78cff7d0f7c849b/node_modules/to-absolute-glob/"),
      packageDependencies: new Map([
        ["is-absolute", "1.0.0"],
        ["is-negated-glob", "1.0.0"],
        ["to-absolute-glob", "2.0.2"],
      ]),
    }],
  ])],
  ["unique-stream", new Map([
    ["2.3.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-unique-stream-2.3.1-c65d110e9a4adf9a6c5948b28053d9a8d04cbeac/node_modules/unique-stream/"),
      packageDependencies: new Map([
        ["json-stable-stringify-without-jsonify", "1.0.1"],
        ["through2-filter", "3.0.0"],
        ["unique-stream", "2.3.1"],
      ]),
    }],
  ])],
  ["json-stable-stringify-without-jsonify", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-json-stable-stringify-without-jsonify-1.0.1-9db7b59496ad3f3cfef30a75142d2d930ad72651/node_modules/json-stable-stringify-without-jsonify/"),
      packageDependencies: new Map([
        ["json-stable-stringify-without-jsonify", "1.0.1"],
      ]),
    }],
  ])],
  ["through2-filter", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-through2-filter-3.0.0-700e786df2367c2c88cd8aa5be4cf9c1e7831254/node_modules/through2-filter/"),
      packageDependencies: new Map([
        ["through2", "2.0.5"],
        ["xtend", "4.0.1"],
        ["through2-filter", "3.0.0"],
      ]),
    }],
  ])],
  ["is-valid-glob", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-is-valid-glob-1.0.0-29bf3eff701be2d4d315dbacc39bc39fe8f601aa/node_modules/is-valid-glob/"),
      packageDependencies: new Map([
        ["is-valid-glob", "1.0.0"],
      ]),
    }],
  ])],
  ["lazystream", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lazystream-1.0.0-f6995fe0f820392f61396be89462407bb77168e4/node_modules/lazystream/"),
      packageDependencies: new Map([
        ["readable-stream", "2.3.6"],
        ["lazystream", "1.0.0"],
      ]),
    }],
  ])],
  ["lead", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-lead-1.0.0-6f14f99a37be3a9dd784f5495690e5903466ee42/node_modules/lead/"),
      packageDependencies: new Map([
        ["flush-write-stream", "1.1.1"],
        ["lead", "1.0.0"],
      ]),
    }],
  ])],
  ["flush-write-stream", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-flush-write-stream-1.1.1-8dd7d873a1babc207d94ead0c2e0e44276ebf2e8/node_modules/flush-write-stream/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["flush-write-stream", "1.1.1"],
      ]),
    }],
  ])],
  ["object.assign", new Map([
    ["4.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-assign-4.1.0-968bf1100d7956bb3ca086f006f846b3bc4008da/node_modules/object.assign/"),
      packageDependencies: new Map([
        ["define-properties", "1.1.3"],
        ["function-bind", "1.1.1"],
        ["has-symbols", "1.0.0"],
        ["object-keys", "1.1.0"],
        ["object.assign", "4.1.0"],
      ]),
    }],
  ])],
  ["define-properties", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-define-properties-1.1.3-cf88da6cbee26fe6db7094f61d870cbd84cee9f1/node_modules/define-properties/"),
      packageDependencies: new Map([
        ["object-keys", "1.1.0"],
        ["define-properties", "1.1.3"],
      ]),
    }],
  ])],
  ["object-keys", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-object-keys-1.1.0-11bd22348dd2e096a045ab06f6c85bcc340fa032/node_modules/object-keys/"),
      packageDependencies: new Map([
        ["object-keys", "1.1.0"],
      ]),
    }],
  ])],
  ["function-bind", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-function-bind-1.1.1-a56899d3ea3c9bab874bb9773b7c5ede92f4895d/node_modules/function-bind/"),
      packageDependencies: new Map([
        ["function-bind", "1.1.1"],
      ]),
    }],
  ])],
  ["has-symbols", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-has-symbols-1.0.0-ba1a8f1af2a0fc39650f5c850367704122063b44/node_modules/has-symbols/"),
      packageDependencies: new Map([
        ["has-symbols", "1.0.0"],
      ]),
    }],
  ])],
  ["remove-bom-buffer", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-remove-bom-buffer-3.0.0-c2bf1e377520d324f623892e33c10cac2c252b53/node_modules/remove-bom-buffer/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
        ["is-utf8", "0.2.1"],
        ["remove-bom-buffer", "3.0.0"],
      ]),
    }],
  ])],
  ["remove-bom-stream", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-remove-bom-stream-1.2.0-05f1a593f16e42e1fb90ebf59de8e569525f9523/node_modules/remove-bom-stream/"),
      packageDependencies: new Map([
        ["remove-bom-buffer", "3.0.0"],
        ["safe-buffer", "5.1.2"],
        ["through2", "2.0.5"],
        ["remove-bom-stream", "1.2.0"],
      ]),
    }],
  ])],
  ["resolve-options", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-resolve-options-1.1.0-32bb9e39c06d67338dc9378c0d6d6074566ad131/node_modules/resolve-options/"),
      packageDependencies: new Map([
        ["value-or-function", "3.0.0"],
        ["resolve-options", "1.1.0"],
      ]),
    }],
  ])],
  ["value-or-function", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-value-or-function-3.0.0-1c243a50b595c1be54a754bfece8563b9ff8d813/node_modules/value-or-function/"),
      packageDependencies: new Map([
        ["value-or-function", "3.0.0"],
      ]),
    }],
  ])],
  ["to-through", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-to-through-2.0.0-fc92adaba072647bc0b67d6b03664aa195093af6/node_modules/to-through/"),
      packageDependencies: new Map([
        ["through2", "2.0.5"],
        ["to-through", "2.0.0"],
      ]),
    }],
  ])],
  ["vinyl-sourcemap", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-vinyl-sourcemap-1.1.0-92a800593a38703a8cdb11d8b300ad4be63b3e16/node_modules/vinyl-sourcemap/"),
      packageDependencies: new Map([
        ["append-buffer", "1.0.2"],
        ["convert-source-map", "1.6.0"],
        ["graceful-fs", "4.1.15"],
        ["normalize-path", "2.1.1"],
        ["now-and-later", "2.0.0"],
        ["remove-bom-buffer", "3.0.0"],
        ["vinyl", "2.2.0"],
        ["vinyl-sourcemap", "1.1.0"],
      ]),
    }],
  ])],
  ["append-buffer", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-append-buffer-1.0.2-d8220cf466081525efea50614f3de6514dfa58f1/node_modules/append-buffer/"),
      packageDependencies: new Map([
        ["buffer-equal", "1.0.0"],
        ["append-buffer", "1.0.2"],
      ]),
    }],
  ])],
  ["buffer-equal", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../.cache/yarn/v4/npm-buffer-equal-1.0.0-59616b498304d556abd466966b22eeda3eca5fbe/node_modules/buffer-equal/"),
      packageDependencies: new Map([
        ["buffer-equal", "1.0.0"],
      ]),
    }],
  ])],
  [null, new Map([
    [null, {
      packageLocation: path.resolve(__dirname, "./"),
      packageDependencies: new Map([
        ["autoprefixer", "9.4.10"],
        ["browser-sync", "2.26.3"],
        ["css-mqpacker", "7.0.0"],
        ["gulp-plumber", "1.2.1"],
        ["gulp-postcss", "8.0.0"],
        ["gulp-rename", "1.4.0"],
        ["gulp-sass", "4.0.2"],
        ["gulp-sourcemaps", "2.6.5"],
        ["gulp-uglify-es", "1.0.4"],
        ["gulp", "4.0.0"],
      ]),
    }],
  ])],
]);

let locatorsByLocations = new Map([
  ["../../.cache/yarn/v4/npm-autoprefixer-9.4.10-e1be61fc728bacac8f4252ed242711ec0dcc6a7b/node_modules/autoprefixer/", {"name":"autoprefixer","reference":"9.4.10"}],
  ["../../.cache/yarn/v4/npm-browserslist-4.4.2-6ea8a74d6464bb0bd549105f659b41197d8f0ba2/node_modules/browserslist/", {"name":"browserslist","reference":"4.4.2"}],
  ["../../.cache/yarn/v4/npm-caniuse-lite-1.0.30000945-d51e3750416dd05126d5ac94a9c57d1c26c6fd21/node_modules/caniuse-lite/", {"name":"caniuse-lite","reference":"1.0.30000945"}],
  ["../../.cache/yarn/v4/npm-electron-to-chromium-1.3.115-fdaa56c19b9f7386dbf29abc1cc632ff5468ff3b/node_modules/electron-to-chromium/", {"name":"electron-to-chromium","reference":"1.3.115"}],
  ["../../.cache/yarn/v4/npm-node-releases-1.1.10-5dbeb6bc7f4e9c85b899e2e7adcc0635c9b2adf7/node_modules/node-releases/", {"name":"node-releases","reference":"1.1.10"}],
  ["../../.cache/yarn/v4/npm-semver-5.6.0-7e74256fbaa49c75aa7c7a205cc22799cac80004/node_modules/semver/", {"name":"semver","reference":"5.6.0"}],
  ["../../.cache/yarn/v4/npm-semver-5.3.0-9b2ce5d3de02d17c6012ad326aa6b4d0cf54f94f/node_modules/semver/", {"name":"semver","reference":"5.3.0"}],
  ["../../.cache/yarn/v4/npm-normalize-range-0.1.2-2d10c06bdfd312ea9777695a4d28439456b75942/node_modules/normalize-range/", {"name":"normalize-range","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-num2fraction-1.2.2-6f682b6a027a4e9ddfa4564cd2589d1d4e669ede/node_modules/num2fraction/", {"name":"num2fraction","reference":"1.2.2"}],
  ["../../.cache/yarn/v4/npm-postcss-7.0.14-4527ed6b1ca0d82c53ce5ec1a2041c2346bbd6e5/node_modules/postcss/", {"name":"postcss","reference":"7.0.14"}],
  ["../../.cache/yarn/v4/npm-chalk-2.4.2-cd42541677a54333cf541a49108c1432b44c9424/node_modules/chalk/", {"name":"chalk","reference":"2.4.2"}],
  ["../../.cache/yarn/v4/npm-chalk-1.1.3-a8115c55e4a702fe4d150abd3872822a7e09fc98/node_modules/chalk/", {"name":"chalk","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-ansi-styles-3.2.1-41fbb20243e50b12be0f04b8dedbf07520ce841d/node_modules/ansi-styles/", {"name":"ansi-styles","reference":"3.2.1"}],
  ["../../.cache/yarn/v4/npm-ansi-styles-2.2.1-b432dd3358b634cf75e1e4664368240533c1ddbe/node_modules/ansi-styles/", {"name":"ansi-styles","reference":"2.2.1"}],
  ["../../.cache/yarn/v4/npm-color-convert-1.9.3-bb71850690e1f136567de629d2d5471deda4c1e8/node_modules/color-convert/", {"name":"color-convert","reference":"1.9.3"}],
  ["../../.cache/yarn/v4/npm-color-name-1.1.3-a7d0558bd89c42f795dd42328f740831ca53bc25/node_modules/color-name/", {"name":"color-name","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-escape-string-regexp-1.0.5-1b61c0562190a8dff6ae3bb2cf0200ca130b86d4/node_modules/escape-string-regexp/", {"name":"escape-string-regexp","reference":"1.0.5"}],
  ["../../.cache/yarn/v4/npm-supports-color-5.5.0-e2e69a44ac8772f78a1ec0b35b689df6530efc8f/node_modules/supports-color/", {"name":"supports-color","reference":"5.5.0"}],
  ["../../.cache/yarn/v4/npm-supports-color-6.1.0-0764abc69c63d5ac842dd4867e8d025e880df8f3/node_modules/supports-color/", {"name":"supports-color","reference":"6.1.0"}],
  ["../../.cache/yarn/v4/npm-supports-color-2.0.0-535d045ce6b6363fa40117084629995e9df324c7/node_modules/supports-color/", {"name":"supports-color","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-has-flag-3.0.0-b5d454dc2199ae225699f3467e5a07f3b955bafd/node_modules/has-flag/", {"name":"has-flag","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-source-map-0.6.1-74722af32e9614e9c287a8d0bbde48b5e2f1a263/node_modules/source-map/", {"name":"source-map","reference":"0.6.1"}],
  ["../../.cache/yarn/v4/npm-source-map-0.5.7-8a039d2d1021d22d1ea14c80d8ea468ba2ef3fcc/node_modules/source-map/", {"name":"source-map","reference":"0.5.7"}],
  ["../../.cache/yarn/v4/npm-source-map-0.4.4-eba4f5da9c0dc999de68032d8b4f76173652036b/node_modules/source-map/", {"name":"source-map","reference":"0.4.4"}],
  ["../../.cache/yarn/v4/npm-postcss-value-parser-3.3.1-9ff822547e2893213cf1c30efa51ac5fd1ba8281/node_modules/postcss-value-parser/", {"name":"postcss-value-parser","reference":"3.3.1"}],
  ["../../.cache/yarn/v4/npm-browser-sync-2.26.3-1b59bd5935938a5b0fa73b3d78ef1050bd2bf912/node_modules/browser-sync/", {"name":"browser-sync","reference":"2.26.3"}],
  ["../../.cache/yarn/v4/npm-browser-sync-client-2.26.2-dd0070c80bdc6d9021e89f7837ee70ed0a8acf91/node_modules/browser-sync-client/", {"name":"browser-sync-client","reference":"2.26.2"}],
  ["../../.cache/yarn/v4/npm-etag-1.8.1-41ae2eeb65efa62268aebfea83ac7d79299b0887/node_modules/etag/", {"name":"etag","reference":"1.8.1"}],
  ["../../.cache/yarn/v4/npm-fresh-0.5.2-3d8cadd90d976569fa835ab1f8e4b23a105605a7/node_modules/fresh/", {"name":"fresh","reference":"0.5.2"}],
  ["../../.cache/yarn/v4/npm-mitt-1.1.3-528c506238a05dce11cd914a741ea2cc332da9b8/node_modules/mitt/", {"name":"mitt","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-rxjs-5.5.12-6fa61b8a77c3d793dbaf270bee2f43f652d741cc/node_modules/rxjs/", {"name":"rxjs","reference":"5.5.12"}],
  ["../../.cache/yarn/v4/npm-symbol-observable-1.0.1-8340fc4702c3122df5d22288f88283f513d3fdd4/node_modules/symbol-observable/", {"name":"symbol-observable","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-browser-sync-ui-2.26.2-a1d8e107cfed5849d77e3bbd84ae5d566beb4ea0/node_modules/browser-sync-ui/", {"name":"browser-sync-ui","reference":"2.26.2"}],
  ["../../.cache/yarn/v4/npm-async-each-series-0.1.1-7617c1917401fd8ca4a28aadce3dbae98afeb432/node_modules/async-each-series/", {"name":"async-each-series","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-connect-history-api-fallback-1.6.0-8b32089359308d111115d81cad3fceab888f97bc/node_modules/connect-history-api-fallback/", {"name":"connect-history-api-fallback","reference":"1.6.0"}],
  ["../../.cache/yarn/v4/npm-immutable-3.8.2-c2439951455bb39913daf281376f1530e104adf3/node_modules/immutable/", {"name":"immutable","reference":"3.8.2"}],
  ["../../.cache/yarn/v4/npm-server-destroy-1.0.1-f13bf928e42b9c3e79383e61cc3998b5d14e6cdd/node_modules/server-destroy/", {"name":"server-destroy","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-socket-io-client-2.2.0-84e73ee3c43d5020ccc1a258faeeb9aec2723af7/node_modules/socket.io-client/", {"name":"socket.io-client","reference":"2.2.0"}],
  ["../../.cache/yarn/v4/npm-socket-io-client-2.1.1-dcb38103436ab4578ddb026638ae2f21b623671f/node_modules/socket.io-client/", {"name":"socket.io-client","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-backo2-1.0.2-31ab1ac8b129363463e35b3ebb69f4dfcfba7947/node_modules/backo2/", {"name":"backo2","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-base64-arraybuffer-0.1.5-73926771923b5a19747ad666aa5cd4bf9c6e9ce8/node_modules/base64-arraybuffer/", {"name":"base64-arraybuffer","reference":"0.1.5"}],
  ["../../.cache/yarn/v4/npm-component-bind-1.0.0-00c608ab7dcd93897c0009651b1d3a8e1e73bbd1/node_modules/component-bind/", {"name":"component-bind","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-component-emitter-1.2.1-137918d6d78283f7df7a6b7c5a63e140e69425e6/node_modules/component-emitter/", {"name":"component-emitter","reference":"1.2.1"}],
  ["../../.cache/yarn/v4/npm-debug-3.1.0-5bb5a0672628b64149566ba16819e61518c67261/node_modules/debug/", {"name":"debug","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-debug-2.6.9-5d128515df134ff327e90a4c93f4e077a536341f/node_modules/debug/", {"name":"debug","reference":"2.6.9"}],
  ["../../.cache/yarn/v4/npm-debug-3.2.6-e83d17de16d8a7efb7717edbe5fb10135eee629b/node_modules/debug/", {"name":"debug","reference":"3.2.6"}],
  ["../../.cache/yarn/v4/npm-ms-2.0.0-5608aeadfc00be6c2901df5f9861788de0d597c8/node_modules/ms/", {"name":"ms","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-ms-2.1.1-30a5864eb3ebb0a66f2ebe6d727af06a09d86e0a/node_modules/ms/", {"name":"ms","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-engine-io-client-3.3.2-04e068798d75beda14375a264bb3d742d7bc33aa/node_modules/engine.io-client/", {"name":"engine.io-client","reference":"3.3.2"}],
  ["../../.cache/yarn/v4/npm-engine-io-client-3.2.1-6f54c0475de487158a1a7c77d10178708b6add36/node_modules/engine.io-client/", {"name":"engine.io-client","reference":"3.2.1"}],
  ["../../.cache/yarn/v4/npm-component-inherit-0.0.3-645fc4adf58b72b649d5cae65135619db26ff143/node_modules/component-inherit/", {"name":"component-inherit","reference":"0.0.3"}],
  ["../../.cache/yarn/v4/npm-engine-io-parser-2.1.3-757ab970fbf2dfb32c7b74b033216d5739ef79a6/node_modules/engine.io-parser/", {"name":"engine.io-parser","reference":"2.1.3"}],
  ["../../.cache/yarn/v4/npm-after-0.8.2-fedb394f9f0e02aa9768e702bda23b505fae7e1f/node_modules/after/", {"name":"after","reference":"0.8.2"}],
  ["../../.cache/yarn/v4/npm-arraybuffer-slice-0.0.7-3bbc4275dd584cc1b10809b89d4e8b63a69e7675/node_modules/arraybuffer.slice/", {"name":"arraybuffer.slice","reference":"0.0.7"}],
  ["../../.cache/yarn/v4/npm-blob-0.0.5-d680eeef25f8cd91ad533f5b01eed48e64caf683/node_modules/blob/", {"name":"blob","reference":"0.0.5"}],
  ["../../.cache/yarn/v4/npm-has-binary2-1.0.3-7776ac627f3ea77250cfc332dab7ddf5e4f5d11d/node_modules/has-binary2/", {"name":"has-binary2","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-isarray-2.0.1-a37d94ed9cda2d59865c9f76fe596ee1f338741e/node_modules/isarray/", {"name":"isarray","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-isarray-1.0.0-bb935d48582cba168c06834957a54a3e07124f11/node_modules/isarray/", {"name":"isarray","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-has-cors-1.1.0-5e474793f7ea9843d1bb99c23eef49ff126fff39/node_modules/has-cors/", {"name":"has-cors","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-indexof-0.0.1-82dc336d232b9062179d05ab3293a66059fd435d/node_modules/indexof/", {"name":"indexof","reference":"0.0.1"}],
  ["../../.cache/yarn/v4/npm-parseqs-0.0.5-d5208a3738e46766e291ba2ea173684921a8b89d/node_modules/parseqs/", {"name":"parseqs","reference":"0.0.5"}],
  ["../../.cache/yarn/v4/npm-better-assert-1.0.2-40866b9e1b9e0b55b481894311e68faffaebc522/node_modules/better-assert/", {"name":"better-assert","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-callsite-1.0.0-280398e5d664bd74038b6f0905153e6e8af1bc20/node_modules/callsite/", {"name":"callsite","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-parseuri-0.0.5-80204a50d4dbb779bfdc6ebe2778d90e4bce320a/node_modules/parseuri/", {"name":"parseuri","reference":"0.0.5"}],
  ["../../.cache/yarn/v4/npm-ws-6.1.4-5b5c8800afab925e94ccb29d153c8d02c1776ef9/node_modules/ws/", {"name":"ws","reference":"6.1.4"}],
  ["../../.cache/yarn/v4/npm-ws-3.3.3-f1cf84fe2d5e901ebce94efaece785f187a228f2/node_modules/ws/", {"name":"ws","reference":"3.3.3"}],
  ["../../.cache/yarn/v4/npm-async-limiter-1.0.0-78faed8c3d074ab81f22b4e985d79e8738f720f8/node_modules/async-limiter/", {"name":"async-limiter","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-xmlhttprequest-ssl-1.5.5-c2876b06168aadc40e57d97e81191ac8f4398b3e/node_modules/xmlhttprequest-ssl/", {"name":"xmlhttprequest-ssl","reference":"1.5.5"}],
  ["../../.cache/yarn/v4/npm-yeast-0.1.2-008e06d8094320c372dbc2f8ed76a0ca6c8ac419/node_modules/yeast/", {"name":"yeast","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-object-component-0.0.3-f0c69aa50efc95b866c186f400a33769cb2f1291/node_modules/object-component/", {"name":"object-component","reference":"0.0.3"}],
  ["../../.cache/yarn/v4/npm-socket-io-parser-3.3.0-2b52a96a509fdf31440ba40fed6094c7d4f1262f/node_modules/socket.io-parser/", {"name":"socket.io-parser","reference":"3.3.0"}],
  ["../../.cache/yarn/v4/npm-socket-io-parser-3.2.0-e7c6228b6aa1f814e6148aea325b51aa9499e077/node_modules/socket.io-parser/", {"name":"socket.io-parser","reference":"3.2.0"}],
  ["../../.cache/yarn/v4/npm-to-array-0.1.4-17e6c11f73dd4f3d74cda7a4ff3238e9ad9bf890/node_modules/to-array/", {"name":"to-array","reference":"0.1.4"}],
  ["../../.cache/yarn/v4/npm-stream-throttle-0.1.3-add57c8d7cc73a81630d31cd55d3961cfafba9c3/node_modules/stream-throttle/", {"name":"stream-throttle","reference":"0.1.3"}],
  ["../../.cache/yarn/v4/npm-commander-2.19.0-f6198aa84e5b83c46054b94ddedbfed5ee9ff12a/node_modules/commander/", {"name":"commander","reference":"2.19.0"}],
  ["../../.cache/yarn/v4/npm-limiter-1.1.4-87c9c3972d389fdb0ba67a45aadbc5d2f8413bc1/node_modules/limiter/", {"name":"limiter","reference":"1.1.4"}],
  ["../../.cache/yarn/v4/npm-bs-recipes-1.3.4-0d2d4d48a718c8c044769fdc4f89592dc8b69585/node_modules/bs-recipes/", {"name":"bs-recipes","reference":"1.3.4"}],
  ["../../.cache/yarn/v4/npm-bs-snippet-injector-2.0.1-61b5393f11f52559ed120693100343b6edb04dd5/node_modules/bs-snippet-injector/", {"name":"bs-snippet-injector","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-chokidar-2.1.2-9c23ea40b01638439e0513864d362aeacc5ad058/node_modules/chokidar/", {"name":"chokidar","reference":"2.1.2"}],
  ["../../.cache/yarn/v4/npm-anymatch-2.0.0-bcb24b4f37934d9aa7ac17b4adaf89e7c76ef2eb/node_modules/anymatch/", {"name":"anymatch","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-micromatch-3.1.10-70859bc95c9840952f359a068a3fc49f9ecfac23/node_modules/micromatch/", {"name":"micromatch","reference":"3.1.10"}],
  ["../../.cache/yarn/v4/npm-micromatch-2.3.11-86677c97d1720b363431d04d0d15293bd38c1565/node_modules/micromatch/", {"name":"micromatch","reference":"2.3.11"}],
  ["../../.cache/yarn/v4/npm-arr-diff-4.0.0-d6461074febfec71e7e15235761a329a5dc7c520/node_modules/arr-diff/", {"name":"arr-diff","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-arr-diff-2.0.0-8f3b827f955a8bd669697e4a4256ac3ceae356cf/node_modules/arr-diff/", {"name":"arr-diff","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-arr-diff-1.1.0-687c32758163588fef7de7b36fabe495eb1a399a/node_modules/arr-diff/", {"name":"arr-diff","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-array-unique-0.3.2-a894b75d4bc4f6cd679ef3244a9fd8f46ae2d428/node_modules/array-unique/", {"name":"array-unique","reference":"0.3.2"}],
  ["../../.cache/yarn/v4/npm-array-unique-0.2.1-a1d97ccafcbc2625cc70fadceb36a50c58b01a53/node_modules/array-unique/", {"name":"array-unique","reference":"0.2.1"}],
  ["../../.cache/yarn/v4/npm-braces-2.3.2-5979fd3f14cd531565e5fa2df1abfff1dfaee729/node_modules/braces/", {"name":"braces","reference":"2.3.2"}],
  ["../../.cache/yarn/v4/npm-braces-1.8.5-ba77962e12dff969d6b76711e914b737857bf6a7/node_modules/braces/", {"name":"braces","reference":"1.8.5"}],
  ["../../.cache/yarn/v4/npm-arr-flatten-1.1.0-36048bbff4e7b47e136644316c99669ea5ae91f1/node_modules/arr-flatten/", {"name":"arr-flatten","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-extend-shallow-2.0.1-51af7d614ad9a9f610ea1bafbb989d6b1c56890f/node_modules/extend-shallow/", {"name":"extend-shallow","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-extend-shallow-3.0.2-26a71aaf073b39fb2127172746131c2704028db8/node_modules/extend-shallow/", {"name":"extend-shallow","reference":"3.0.2"}],
  ["../../.cache/yarn/v4/npm-extend-shallow-1.1.4-19d6bf94dfc09d76ba711f39b872d21ff4dd9071/node_modules/extend-shallow/", {"name":"extend-shallow","reference":"1.1.4"}],
  ["../../.cache/yarn/v4/npm-is-extendable-0.1.1-62b110e289a471418e3ec36a617d472e301dfc89/node_modules/is-extendable/", {"name":"is-extendable","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-is-extendable-1.0.1-a7470f9e426733d81bd81e1155264e3a3507cab4/node_modules/is-extendable/", {"name":"is-extendable","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-fill-range-4.0.0-d544811d428f98eb06a63dc402d2403c328c38f7/node_modules/fill-range/", {"name":"fill-range","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-fill-range-2.2.4-eb1e773abb056dcd8df2bfdf6af59b8b3a936565/node_modules/fill-range/", {"name":"fill-range","reference":"2.2.4"}],
  ["../../.cache/yarn/v4/npm-is-number-3.0.0-24fd6201a4782cf50561c810276afc7d12d71195/node_modules/is-number/", {"name":"is-number","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-is-number-2.1.0-01fcbbb393463a548f2f466cce16dece49db908f/node_modules/is-number/", {"name":"is-number","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-is-number-4.0.0-0026e37f5454d73e356dfe6564699867c6a7f0ff/node_modules/is-number/", {"name":"is-number","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-kind-of-3.2.2-31ea21a734bab9bbb0f32466d893aea51e4a3c64/node_modules/kind-of/", {"name":"kind-of","reference":"3.2.2"}],
  ["../../.cache/yarn/v4/npm-kind-of-4.0.0-20813df3d712928b207378691a45066fae72dd57/node_modules/kind-of/", {"name":"kind-of","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-kind-of-5.1.0-729c91e2d857b7a419a1f9aa65685c4c33f5845d/node_modules/kind-of/", {"name":"kind-of","reference":"5.1.0"}],
  ["../../.cache/yarn/v4/npm-kind-of-6.0.2-01146b36a6218e64e58f3a8d66de5d7fc6f6d051/node_modules/kind-of/", {"name":"kind-of","reference":"6.0.2"}],
  ["../../.cache/yarn/v4/npm-kind-of-1.1.0-140a3d2d41a36d2efcfa9377b62c24f8495a5c44/node_modules/kind-of/", {"name":"kind-of","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-is-buffer-1.1.6-efaa2ea9daa0d7ab2ea13a97b2b8ad51fefbe8be/node_modules/is-buffer/", {"name":"is-buffer","reference":"1.1.6"}],
  ["../../.cache/yarn/v4/npm-repeat-string-1.6.1-8dcae470e1c88abc2d600fff4a776286da75e637/node_modules/repeat-string/", {"name":"repeat-string","reference":"1.6.1"}],
  ["../../.cache/yarn/v4/npm-to-regex-range-2.1.1-7c80c17b9dfebe599e27367e0d4dd5590141db38/node_modules/to-regex-range/", {"name":"to-regex-range","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-isobject-3.0.1-4e431e92b11a9731636aa1f9c8d1ccbcfdab78df/node_modules/isobject/", {"name":"isobject","reference":"3.0.1"}],
  ["../../.cache/yarn/v4/npm-isobject-2.1.0-f065561096a3f1da2ef46272f815c840d87e0c89/node_modules/isobject/", {"name":"isobject","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-repeat-element-1.1.3-782e0d825c0c5a3bb39731f84efee6b742e6b1ce/node_modules/repeat-element/", {"name":"repeat-element","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-snapdragon-0.8.2-64922e7c565b0e14204ba1aa7d6964278d25182d/node_modules/snapdragon/", {"name":"snapdragon","reference":"0.8.2"}],
  ["../../.cache/yarn/v4/npm-base-0.11.2-7bde5ced145b6d551a90db87f83c558b4eb48a8f/node_modules/base/", {"name":"base","reference":"0.11.2"}],
  ["../../.cache/yarn/v4/npm-cache-base-1.0.1-0a7f46416831c8b662ee36fe4e7c59d76f666ab2/node_modules/cache-base/", {"name":"cache-base","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-collection-visit-1.0.0-4bc0373c164bc3291b4d368c829cf1a80a59dca0/node_modules/collection-visit/", {"name":"collection-visit","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-map-visit-1.0.0-ecdca8f13144e660f1b5bd41f12f3479d98dfb8f/node_modules/map-visit/", {"name":"map-visit","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-object-visit-1.0.1-f79c4493af0c5377b59fe39d395e41042dd045bb/node_modules/object-visit/", {"name":"object-visit","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-get-value-2.0.6-dc15ca1c672387ca76bd37ac0a395ba2042a2c28/node_modules/get-value/", {"name":"get-value","reference":"2.0.6"}],
  ["../../.cache/yarn/v4/npm-has-value-1.0.0-18b281da585b1c5c51def24c930ed29a0be6b177/node_modules/has-value/", {"name":"has-value","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-has-value-0.3.1-7b1f58bada62ca827ec0a2078025654845995e1f/node_modules/has-value/", {"name":"has-value","reference":"0.3.1"}],
  ["../../.cache/yarn/v4/npm-has-values-1.0.0-95b0b63fec2146619a6fe57fe75628d5a39efe4f/node_modules/has-values/", {"name":"has-values","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-has-values-0.1.4-6d61de95d91dfca9b9a02089ad384bff8f62b771/node_modules/has-values/", {"name":"has-values","reference":"0.1.4"}],
  ["../../.cache/yarn/v4/npm-set-value-2.0.0-71ae4a88f0feefbbf52d1ea604f3fb315ebb6274/node_modules/set-value/", {"name":"set-value","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-set-value-0.4.3-7db08f9d3d22dc7f78e53af3c3bf4666ecdfccf1/node_modules/set-value/", {"name":"set-value","reference":"0.4.3"}],
  ["../../.cache/yarn/v4/npm-is-plain-object-2.0.4-2c163b3fafb1b606d9d17928f05c2a1c38e07677/node_modules/is-plain-object/", {"name":"is-plain-object","reference":"2.0.4"}],
  ["../../.cache/yarn/v4/npm-split-string-3.1.0-7cb09dda3a86585705c64b39a6466038682e8fe2/node_modules/split-string/", {"name":"split-string","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-assign-symbols-1.0.0-59667f41fadd4f20ccbc2bb96b8d4f7f78ec0367/node_modules/assign-symbols/", {"name":"assign-symbols","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-to-object-path-0.3.0-297588b7b0e7e0ac08e04e672f85c1f4999e17af/node_modules/to-object-path/", {"name":"to-object-path","reference":"0.3.0"}],
  ["../../.cache/yarn/v4/npm-union-value-1.0.0-5c71c34cb5bad5dcebe3ea0cd08207ba5aa1aea4/node_modules/union-value/", {"name":"union-value","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-arr-union-3.1.0-e39b09aea9def866a8f206e288af63919bae39c4/node_modules/arr-union/", {"name":"arr-union","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-arr-union-2.1.0-20f9eab5ec70f5c7d215b1077b1c39161d292c7d/node_modules/arr-union/", {"name":"arr-union","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-unset-value-1.0.0-8376873f7d2335179ffb1e6fc3a8ed0dfc8ab559/node_modules/unset-value/", {"name":"unset-value","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-class-utils-0.3.6-f93369ae8b9a7ce02fd41faad0ca83033190c463/node_modules/class-utils/", {"name":"class-utils","reference":"0.3.6"}],
  ["../../.cache/yarn/v4/npm-define-property-0.2.5-c35b1ef918ec3c990f9a5bc57be04aacec5c8116/node_modules/define-property/", {"name":"define-property","reference":"0.2.5"}],
  ["../../.cache/yarn/v4/npm-define-property-1.0.0-769ebaaf3f4a63aad3af9e8d304c9bbe79bfb0e6/node_modules/define-property/", {"name":"define-property","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-define-property-2.0.2-d459689e8d654ba77e02a817f8710d702cb16e9d/node_modules/define-property/", {"name":"define-property","reference":"2.0.2"}],
  ["../../.cache/yarn/v4/npm-is-descriptor-0.1.6-366d8240dde487ca51823b1ab9f07a10a78251ca/node_modules/is-descriptor/", {"name":"is-descriptor","reference":"0.1.6"}],
  ["../../.cache/yarn/v4/npm-is-descriptor-1.0.2-3b159746a66604b04f8c81524ba365c5f14d86ec/node_modules/is-descriptor/", {"name":"is-descriptor","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-is-accessor-descriptor-0.1.6-a9e12cb3ae8d876727eeef3843f8a0897b5c98d6/node_modules/is-accessor-descriptor/", {"name":"is-accessor-descriptor","reference":"0.1.6"}],
  ["../../.cache/yarn/v4/npm-is-accessor-descriptor-1.0.0-169c2f6d3df1f992618072365c9b0ea1f6878656/node_modules/is-accessor-descriptor/", {"name":"is-accessor-descriptor","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-is-data-descriptor-0.1.4-0b5ee648388e2c860282e793f1856fec3f301b56/node_modules/is-data-descriptor/", {"name":"is-data-descriptor","reference":"0.1.4"}],
  ["../../.cache/yarn/v4/npm-is-data-descriptor-1.0.0-d84876321d0e7add03990406abbbbd36ba9268c7/node_modules/is-data-descriptor/", {"name":"is-data-descriptor","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-static-extend-0.1.2-60809c39cbff55337226fd5e0b520f341f1fb5c6/node_modules/static-extend/", {"name":"static-extend","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-object-copy-0.1.0-7e7d858b781bd7c991a41ba975ed3812754e998c/node_modules/object-copy/", {"name":"object-copy","reference":"0.1.0"}],
  ["../../.cache/yarn/v4/npm-copy-descriptor-0.1.1-676f6eb3c39997c2ee1ac3a924fd6124748f578d/node_modules/copy-descriptor/", {"name":"copy-descriptor","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-mixin-deep-1.3.1-a49e7268dce1a0d9698e45326c5626df3543d0fe/node_modules/mixin-deep/", {"name":"mixin-deep","reference":"1.3.1"}],
  ["../../.cache/yarn/v4/npm-for-in-1.0.2-81068d295a8142ec0ac726c6e2200c30fb6d5e80/node_modules/for-in/", {"name":"for-in","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-pascalcase-0.1.1-b363e55e8006ca6fe21784d2db22bd15d7917f14/node_modules/pascalcase/", {"name":"pascalcase","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-map-cache-0.2.2-c32abd0bd6525d9b051645bb4f26ac5dc98a0dbf/node_modules/map-cache/", {"name":"map-cache","reference":"0.2.2"}],
  ["../../.cache/yarn/v4/npm-source-map-resolve-0.5.2-72e2cc34095543e43b2c62b2c4c10d4a9054f259/node_modules/source-map-resolve/", {"name":"source-map-resolve","reference":"0.5.2"}],
  ["../../.cache/yarn/v4/npm-atob-2.1.2-6d9517eb9e030d2436666651e86bd9f6f13533c9/node_modules/atob/", {"name":"atob","reference":"2.1.2"}],
  ["../../.cache/yarn/v4/npm-decode-uri-component-0.2.0-eb3913333458775cb84cd1a1fae062106bb87545/node_modules/decode-uri-component/", {"name":"decode-uri-component","reference":"0.2.0"}],
  ["../../.cache/yarn/v4/npm-resolve-url-0.2.1-2c637fe77c893afd2a663fe21aa9080068e2052a/node_modules/resolve-url/", {"name":"resolve-url","reference":"0.2.1"}],
  ["../../.cache/yarn/v4/npm-source-map-url-0.4.0-3e935d7ddd73631b97659956d55128e87b5084a3/node_modules/source-map-url/", {"name":"source-map-url","reference":"0.4.0"}],
  ["../../.cache/yarn/v4/npm-urix-0.1.0-da937f7a62e21fec1fd18d49b35c2935067a6c72/node_modules/urix/", {"name":"urix","reference":"0.1.0"}],
  ["../../.cache/yarn/v4/npm-use-3.1.1-d50c8cac79a19fbc20f2911f56eb973f4e10070f/node_modules/use/", {"name":"use","reference":"3.1.1"}],
  ["../../.cache/yarn/v4/npm-snapdragon-node-2.1.1-6c175f86ff14bdb0724563e8f3c1b021a286853b/node_modules/snapdragon-node/", {"name":"snapdragon-node","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-snapdragon-util-3.0.1-f956479486f2acd79700693f6f7b805e45ab56e2/node_modules/snapdragon-util/", {"name":"snapdragon-util","reference":"3.0.1"}],
  ["../../.cache/yarn/v4/npm-to-regex-3.0.2-13cfdd9b336552f30b51f33a8ae1b42a7a7599ce/node_modules/to-regex/", {"name":"to-regex","reference":"3.0.2"}],
  ["../../.cache/yarn/v4/npm-regex-not-1.0.2-1f4ece27e00b0b65e0247a6810e6a85d83a5752c/node_modules/regex-not/", {"name":"regex-not","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-safe-regex-1.1.0-40a3669f3b077d1e943d44629e157dd48023bf2e/node_modules/safe-regex/", {"name":"safe-regex","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-ret-0.1.15-b8a4825d5bdb1fc3f6f53c2bc33f81388681c7bc/node_modules/ret/", {"name":"ret","reference":"0.1.15"}],
  ["../../.cache/yarn/v4/npm-extglob-2.0.4-ad00fe4dc612a9232e8718711dc5cb5ab0285543/node_modules/extglob/", {"name":"extglob","reference":"2.0.4"}],
  ["../../.cache/yarn/v4/npm-extglob-0.3.2-2e18ff3d2f49ab2765cec9023f011daa8d8349a1/node_modules/extglob/", {"name":"extglob","reference":"0.3.2"}],
  ["../../.cache/yarn/v4/npm-expand-brackets-2.1.4-b77735e315ce30f6b6eff0f83b04151a22449622/node_modules/expand-brackets/", {"name":"expand-brackets","reference":"2.1.4"}],
  ["../../.cache/yarn/v4/npm-expand-brackets-0.1.5-df07284e342a807cd733ac5af72411e581d1177b/node_modules/expand-brackets/", {"name":"expand-brackets","reference":"0.1.5"}],
  ["../../.cache/yarn/v4/npm-posix-character-classes-0.1.1-01eac0fe3b5af71a2a6c02feabb8c1fef7e00eab/node_modules/posix-character-classes/", {"name":"posix-character-classes","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-fragment-cache-0.2.1-4290fad27f13e89be7f33799c6bc5a0abfff0d19/node_modules/fragment-cache/", {"name":"fragment-cache","reference":"0.2.1"}],
  ["../../.cache/yarn/v4/npm-nanomatch-1.2.13-b87a8aa4fc0de8fe6be88895b38983ff265bd119/node_modules/nanomatch/", {"name":"nanomatch","reference":"1.2.13"}],
  ["../../.cache/yarn/v4/npm-is-windows-1.0.2-d1850eb9791ecd18e6182ce12a30f396634bb19d/node_modules/is-windows/", {"name":"is-windows","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-object-pick-1.3.0-87a10ac4c1694bd2e1cbf53591a66141fb5dd747/node_modules/object.pick/", {"name":"object.pick","reference":"1.3.0"}],
  ["../../.cache/yarn/v4/npm-normalize-path-2.1.1-1ab28b556e198363a8c1a6f7e6fa20137fe6aed9/node_modules/normalize-path/", {"name":"normalize-path","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-normalize-path-3.0.0-0dcd69ff23a1c9b11fd0978316644a0388216a65/node_modules/normalize-path/", {"name":"normalize-path","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-remove-trailing-separator-1.1.0-c24bce2a283adad5bc3f58e0d48249b92379d8ef/node_modules/remove-trailing-separator/", {"name":"remove-trailing-separator","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-async-each-1.0.1-19d386a1d9edc6e7c1c85d388aedbcc56d33602d/node_modules/async-each/", {"name":"async-each","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-glob-parent-3.1.0-9e6af6299d8d3bd2bd40430832bd113df906c5ae/node_modules/glob-parent/", {"name":"glob-parent","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-glob-parent-2.0.0-81383d72db054fcccf5336daa902f182f6edbb28/node_modules/glob-parent/", {"name":"glob-parent","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-is-glob-3.1.0-7ba5ae24217804ac70707b96922567486cc3e84a/node_modules/is-glob/", {"name":"is-glob","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-is-glob-4.0.0-9521c76845cc2610a85203ddf080a958c2ffabc0/node_modules/is-glob/", {"name":"is-glob","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-is-glob-2.0.1-d096f926a3ded5600f3fdfd91198cb0888c2d863/node_modules/is-glob/", {"name":"is-glob","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-is-extglob-2.1.1-a88c02535791f02ed37c76a1b9ea9773c833f8c2/node_modules/is-extglob/", {"name":"is-extglob","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-is-extglob-1.0.0-ac468177c4943405a092fc8f29760c6ffc6206c0/node_modules/is-extglob/", {"name":"is-extglob","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-path-dirname-1.0.2-cc33d24d525e099a5388c0336c6e32b9160609e0/node_modules/path-dirname/", {"name":"path-dirname","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-inherits-2.0.3-633c2c83e3da42a502f52466022480f4208261de/node_modules/inherits/", {"name":"inherits","reference":"2.0.3"}],
  ["../../.cache/yarn/v4/npm-is-binary-path-1.0.1-75f16642b480f187a711c814161fd3a4a7655898/node_modules/is-binary-path/", {"name":"is-binary-path","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-binary-extensions-1.13.0-9523e001306a32444b907423f1de2164222f6ab1/node_modules/binary-extensions/", {"name":"binary-extensions","reference":"1.13.0"}],
  ["../../.cache/yarn/v4/npm-path-is-absolute-1.0.1-174b9268735534ffbc7ace6bf53a5a9e1b5c5f5f/node_modules/path-is-absolute/", {"name":"path-is-absolute","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-readdirp-2.2.1-0e87622a3325aa33e892285caf8b4e846529a525/node_modules/readdirp/", {"name":"readdirp","reference":"2.2.1"}],
  ["../../.cache/yarn/v4/npm-graceful-fs-4.1.15-ffb703e1066e8a0eeaa4c8b80ba9253eeefbfb00/node_modules/graceful-fs/", {"name":"graceful-fs","reference":"4.1.15"}],
  ["../../.cache/yarn/v4/npm-readable-stream-2.3.6-b11c27d88b8ff1fbe070643cf94b0c79ae1b0aaf/node_modules/readable-stream/", {"name":"readable-stream","reference":"2.3.6"}],
  ["../../.cache/yarn/v4/npm-core-util-is-1.0.2-b5fd54220aa2bc5ab57aab7140c940754503c1a7/node_modules/core-util-is/", {"name":"core-util-is","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-process-nextick-args-2.0.0-a37d732f4271b4ab1ad070d35508e8290788ffaa/node_modules/process-nextick-args/", {"name":"process-nextick-args","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-process-nextick-args-1.0.7-150e20b756590ad3f91093f25a4f2ad8bff30ba3/node_modules/process-nextick-args/", {"name":"process-nextick-args","reference":"1.0.7"}],
  ["../../.cache/yarn/v4/npm-safe-buffer-5.1.2-991ec69d296e0313747d59bdfd2b745c35f8828d/node_modules/safe-buffer/", {"name":"safe-buffer","reference":"5.1.2"}],
  ["../../.cache/yarn/v4/npm-string-decoder-1.1.1-9cf1611ba62685d7030ae9e4ba34149c3af03fc8/node_modules/string_decoder/", {"name":"string_decoder","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-util-deprecate-1.0.2-450d4dc9fa70de732762fbd2d4a28981419a0ccf/node_modules/util-deprecate/", {"name":"util-deprecate","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-upath-1.1.2-3db658600edaeeccbe6db5e684d67ee8c2acd068/node_modules/upath/", {"name":"upath","reference":"1.1.2"}],
  ["../../.cache/yarn/v4/npm-connect-3.6.6-09eff6c55af7236e137135a72574858b6786f524/node_modules/connect/", {"name":"connect","reference":"3.6.6"}],
  ["../../.cache/yarn/v4/npm-finalhandler-1.1.0-ce0b6855b45853e791b2fcc680046d88253dd7f5/node_modules/finalhandler/", {"name":"finalhandler","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-encodeurl-1.0.2-ad3ff4c86ec2d029322f5a02c3a9a606c95b3f59/node_modules/encodeurl/", {"name":"encodeurl","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-escape-html-1.0.3-0258eae4d3d0c0974de1c169188ef0051d1d1988/node_modules/escape-html/", {"name":"escape-html","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-on-finished-2.3.0-20f1336481b083cd75337992a16971aa2d906947/node_modules/on-finished/", {"name":"on-finished","reference":"2.3.0"}],
  ["../../.cache/yarn/v4/npm-ee-first-1.1.1-590c61156b0ae2f4f0255732a158b266bc56b21d/node_modules/ee-first/", {"name":"ee-first","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-parseurl-1.3.2-fc289d4ed8993119460c156253262cdc8de65bf3/node_modules/parseurl/", {"name":"parseurl","reference":"1.3.2"}],
  ["../../.cache/yarn/v4/npm-statuses-1.3.1-faf51b9eb74aaef3b3acf4ad5f61abf24cb7b93e/node_modules/statuses/", {"name":"statuses","reference":"1.3.1"}],
  ["../../.cache/yarn/v4/npm-statuses-1.5.0-161c7dac177659fd9811f43771fa99381478628c/node_modules/statuses/", {"name":"statuses","reference":"1.5.0"}],
  ["../../.cache/yarn/v4/npm-statuses-1.4.0-bb73d446da2796106efcc1b601a253d6c46bd087/node_modules/statuses/", {"name":"statuses","reference":"1.4.0"}],
  ["../../.cache/yarn/v4/npm-unpipe-1.0.0-b2bf4ee8514aae6165b4817829d21b2ef49904ec/node_modules/unpipe/", {"name":"unpipe","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-utils-merge-1.0.1-9f95710f50a267947b2ccc124741c1028427e713/node_modules/utils-merge/", {"name":"utils-merge","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-dev-ip-1.0.1-a76a3ed1855be7a012bb8ac16cb80f3c00dc28f0/node_modules/dev-ip/", {"name":"dev-ip","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-easy-extender-2.3.4-298789b64f9aaba62169c77a2b3b64b4c9589b8f/node_modules/easy-extender/", {"name":"easy-extender","reference":"2.3.4"}],
  ["../../.cache/yarn/v4/npm-lodash-4.17.11-b39ea6229ef607ecd89e2c8df12536891cac9b8d/node_modules/lodash/", {"name":"lodash","reference":"4.17.11"}],
  ["../../.cache/yarn/v4/npm-eazy-logger-3.0.2-a325aa5e53d13a2225889b2ac4113b2b9636f4fc/node_modules/eazy-logger/", {"name":"eazy-logger","reference":"3.0.2"}],
  ["../../.cache/yarn/v4/npm-tfunk-3.1.0-38e4414fc64977d87afdaa72facb6d29f82f7b5b/node_modules/tfunk/", {"name":"tfunk","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-has-ansi-2.0.0-34f5049ce1ecdf2b0649af3ef24e45ed35416d91/node_modules/has-ansi/", {"name":"has-ansi","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-ansi-regex-2.1.1-c3b33ab5ee360d86e0e628f0468ae7ef27d654df/node_modules/ansi-regex/", {"name":"ansi-regex","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-ansi-regex-3.0.0-ed0317c322064f79466c02966bddb605ab37d998/node_modules/ansi-regex/", {"name":"ansi-regex","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-strip-ansi-3.0.1-6a385fb8853d952d5ff05d0e8aaf94278dc63dcf/node_modules/strip-ansi/", {"name":"strip-ansi","reference":"3.0.1"}],
  ["../../.cache/yarn/v4/npm-strip-ansi-4.0.0-a8479022eb1ac368a871389b635262c505ee368f/node_modules/strip-ansi/", {"name":"strip-ansi","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-object-path-0.9.2-0fd9a74fc5fad1ae3968b586bda5c632bd6c05a5/node_modules/object-path/", {"name":"object-path","reference":"0.9.2"}],
  ["../../.cache/yarn/v4/npm-fs-extra-3.0.1-3794f378c58b342ea7dbbb23095109c4b3b62291/node_modules/fs-extra/", {"name":"fs-extra","reference":"3.0.1"}],
  ["../../.cache/yarn/v4/npm-jsonfile-3.0.1-a5ecc6f65f53f662c4415c7675a0331d0992ec66/node_modules/jsonfile/", {"name":"jsonfile","reference":"3.0.1"}],
  ["../../.cache/yarn/v4/npm-universalify-0.1.2-b646f69be3942dabcecc9d6639c80dc105efaa66/node_modules/universalify/", {"name":"universalify","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-http-proxy-1.15.2-642fdcaffe52d3448d2bda3b0079e9409064da31/node_modules/http-proxy/", {"name":"http-proxy","reference":"1.15.2"}],
  ["../../.cache/yarn/v4/npm-eventemitter3-1.2.0-1c86991d816ad1e504750e73874224ecf3bec508/node_modules/eventemitter3/", {"name":"eventemitter3","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-requires-port-1.0.0-925d2601d39ac485e091cf0da5c6e694dc3dcaff/node_modules/requires-port/", {"name":"requires-port","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-localtunnel-1.9.1-1d1737eab658add5a40266d8e43f389b646ee3b1/node_modules/localtunnel/", {"name":"localtunnel","reference":"1.9.1"}],
  ["../../.cache/yarn/v4/npm-axios-0.17.1-2d8e3e5d0bdbd7327f91bc814f5c57660f81824d/node_modules/axios/", {"name":"axios","reference":"0.17.1"}],
  ["../../.cache/yarn/v4/npm-follow-redirects-1.7.0-489ebc198dc0e7f64167bd23b03c4c19b5784c76/node_modules/follow-redirects/", {"name":"follow-redirects","reference":"1.7.0"}],
  ["../../.cache/yarn/v4/npm-openurl-1.1.1-3875b4b0ef7a52c156f0db41d4609dbb0f94b387/node_modules/openurl/", {"name":"openurl","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-yargs-6.6.0-782ec21ef403345f830a808ca3d513af56065208/node_modules/yargs/", {"name":"yargs","reference":"6.6.0"}],
  ["../../.cache/yarn/v4/npm-yargs-6.4.0-816e1a866d5598ccf34e5596ddce22d92da490d4/node_modules/yargs/", {"name":"yargs","reference":"6.4.0"}],
  ["../../.cache/yarn/v4/npm-yargs-7.1.0-6ba318eb16961727f5d284f8ea003e8d6154d0c8/node_modules/yargs/", {"name":"yargs","reference":"7.1.0"}],
  ["../../.cache/yarn/v4/npm-camelcase-3.0.0-32fc4b9fcdaf845fcdf7e73bb97cac2261f0ab0a/node_modules/camelcase/", {"name":"camelcase","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-camelcase-2.1.1-7c1d16d679a1bbe59ca02cacecfb011e201f5a1f/node_modules/camelcase/", {"name":"camelcase","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-cliui-3.2.0-120601537a916d29940f934da3b48d585a39213d/node_modules/cliui/", {"name":"cliui","reference":"3.2.0"}],
  ["../../.cache/yarn/v4/npm-string-width-1.0.2-118bdf5b8cdc51a2a7e70d211e07e2b0b9b107d3/node_modules/string-width/", {"name":"string-width","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-string-width-2.1.1-ab93f27a8dc13d28cac815c462143a6d9012ae9e/node_modules/string-width/", {"name":"string-width","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-code-point-at-1.1.0-0d070b4d043a5bea33a2f1a40e2edb3d9a4ccf77/node_modules/code-point-at/", {"name":"code-point-at","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-is-fullwidth-code-point-1.0.0-ef9e31386f031a7f0d643af82fde50c457ef00cb/node_modules/is-fullwidth-code-point/", {"name":"is-fullwidth-code-point","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-is-fullwidth-code-point-2.0.0-a3b30a5c4f199183167aaab93beefae3ddfb654f/node_modules/is-fullwidth-code-point/", {"name":"is-fullwidth-code-point","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-number-is-nan-1.0.1-097b602b53422a522c1afb8790318336941a011d/node_modules/number-is-nan/", {"name":"number-is-nan","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-wrap-ansi-2.1.0-d8fc3d284dd05794fe84973caecdd1cf824fdd85/node_modules/wrap-ansi/", {"name":"wrap-ansi","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-decamelize-1.2.0-f6534d15148269b20352e7bee26f501f9a191290/node_modules/decamelize/", {"name":"decamelize","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-get-caller-file-1.0.3-f978fa4c90d1dfe7ff2d6beda2a515e713bdcf4a/node_modules/get-caller-file/", {"name":"get-caller-file","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-os-locale-1.4.0-20f9f17ae29ed345e8bde583b13d2009803c14d9/node_modules/os-locale/", {"name":"os-locale","reference":"1.4.0"}],
  ["../../.cache/yarn/v4/npm-lcid-1.0.0-308accafa0bc483a3867b4b6f2b9506251d1b835/node_modules/lcid/", {"name":"lcid","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-invert-kv-1.0.0-104a8e4aaca6d3d8cd157a8ef8bfab2d7a3ffdb6/node_modules/invert-kv/", {"name":"invert-kv","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-read-pkg-up-1.0.1-9d63c13276c065918d57f002a57f40a1b643fb02/node_modules/read-pkg-up/", {"name":"read-pkg-up","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-find-up-1.1.2-6b2e9822b1a2ce0a60ab64d610eccad53cb24d0f/node_modules/find-up/", {"name":"find-up","reference":"1.1.2"}],
  ["../../.cache/yarn/v4/npm-path-exists-2.1.0-0feb6c64f0fc518d9a754dd5efb62c7022761f4b/node_modules/path-exists/", {"name":"path-exists","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-pinkie-promise-2.0.1-2135d6dfa7a358c069ac9b178776288228450ffa/node_modules/pinkie-promise/", {"name":"pinkie-promise","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-pinkie-2.0.4-72556b80cfa0d48a974e80e77248e80ed4f7f870/node_modules/pinkie/", {"name":"pinkie","reference":"2.0.4"}],
  ["../../.cache/yarn/v4/npm-read-pkg-1.1.0-f5ffaa5ecd29cb31c0474bca7d756b6bb29e3f28/node_modules/read-pkg/", {"name":"read-pkg","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-load-json-file-1.1.0-956905708d58b4bab4c2261b04f59f31c99374c0/node_modules/load-json-file/", {"name":"load-json-file","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-parse-json-2.2.0-f480f40434ef80741f8469099f8dea18f55a4dc9/node_modules/parse-json/", {"name":"parse-json","reference":"2.2.0"}],
  ["../../.cache/yarn/v4/npm-parse-json-4.0.0-be35f5425be1f7f6c747184f98a788cb99477ee0/node_modules/parse-json/", {"name":"parse-json","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-error-ex-1.3.2-b4ac40648107fdcdcfae242f428bea8a14d4f1bf/node_modules/error-ex/", {"name":"error-ex","reference":"1.3.2"}],
  ["../../.cache/yarn/v4/npm-is-arrayish-0.2.1-77c99840527aa8ecb1a8ba697b80645a7a926a9d/node_modules/is-arrayish/", {"name":"is-arrayish","reference":"0.2.1"}],
  ["../../.cache/yarn/v4/npm-pify-2.3.0-ed141a6ac043a849ea588498e7dca8b15330e90c/node_modules/pify/", {"name":"pify","reference":"2.3.0"}],
  ["../../.cache/yarn/v4/npm-strip-bom-2.0.0-6219a85616520491f35788bdbf1447a99c7e6b0e/node_modules/strip-bom/", {"name":"strip-bom","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-is-utf8-0.2.1-4b0da1442104d1b336340e80797e865cf39f7d72/node_modules/is-utf8/", {"name":"is-utf8","reference":"0.2.1"}],
  ["../../.cache/yarn/v4/npm-normalize-package-data-2.5.0-e66db1838b200c1dfc233225d12cb36520e234a8/node_modules/normalize-package-data/", {"name":"normalize-package-data","reference":"2.5.0"}],
  ["../../.cache/yarn/v4/npm-hosted-git-info-2.7.1-97f236977bd6e125408930ff6de3eec6281ec047/node_modules/hosted-git-info/", {"name":"hosted-git-info","reference":"2.7.1"}],
  ["../../.cache/yarn/v4/npm-resolve-1.10.0-3bdaaeaf45cc07f375656dfd2e54ed0810b101ba/node_modules/resolve/", {"name":"resolve","reference":"1.10.0"}],
  ["../../.cache/yarn/v4/npm-path-parse-1.0.6-d62dbb5679405d72c4737ec58600e9ddcf06d24c/node_modules/path-parse/", {"name":"path-parse","reference":"1.0.6"}],
  ["../../.cache/yarn/v4/npm-validate-npm-package-license-3.0.4-fc91f6b9c7ba15c857f4cb2c5defeec39d4f410a/node_modules/validate-npm-package-license/", {"name":"validate-npm-package-license","reference":"3.0.4"}],
  ["../../.cache/yarn/v4/npm-spdx-correct-3.1.0-fb83e504445268f154b074e218c87c003cd31df4/node_modules/spdx-correct/", {"name":"spdx-correct","reference":"3.1.0"}],
  ["../../.cache/yarn/v4/npm-spdx-expression-parse-3.0.0-99e119b7a5da00e05491c9fa338b7904823b41d0/node_modules/spdx-expression-parse/", {"name":"spdx-expression-parse","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-spdx-exceptions-2.2.0-2ea450aee74f2a89bfb94519c07fcd6f41322977/node_modules/spdx-exceptions/", {"name":"spdx-exceptions","reference":"2.2.0"}],
  ["../../.cache/yarn/v4/npm-spdx-license-ids-3.0.3-81c0ce8f21474756148bbb5f3bfc0f36bf15d76e/node_modules/spdx-license-ids/", {"name":"spdx-license-ids","reference":"3.0.3"}],
  ["../../.cache/yarn/v4/npm-path-type-1.1.0-59c44f7ee491da704da415da5a4070ba4f8fe441/node_modules/path-type/", {"name":"path-type","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-require-directory-2.1.1-8c64ad5fd30dab1c976e2344ffe7f792a6a6df42/node_modules/require-directory/", {"name":"require-directory","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-require-main-filename-1.0.1-97f717b69d48784f5f526a6c5aa8ffdda055a4d1/node_modules/require-main-filename/", {"name":"require-main-filename","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-set-blocking-2.0.0-045f9782d011ae9a6803ddd382b24392b3d890f7/node_modules/set-blocking/", {"name":"set-blocking","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-which-module-1.0.0-bba63ca861948994ff307736089e3b96026c2a4f/node_modules/which-module/", {"name":"which-module","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-y18n-3.2.1-6d15fba884c08679c0d77e88e7759e811e07fa41/node_modules/y18n/", {"name":"y18n","reference":"3.2.1"}],
  ["../../.cache/yarn/v4/npm-yargs-parser-4.2.1-29cceac0dc4f03c6c87b4a9f217dd18c9f74871c/node_modules/yargs-parser/", {"name":"yargs-parser","reference":"4.2.1"}],
  ["../../.cache/yarn/v4/npm-yargs-parser-5.0.0-275ecf0d7ffe05c77e64e7c86e4cd94bf0e1228a/node_modules/yargs-parser/", {"name":"yargs-parser","reference":"5.0.0"}],
  ["../../.cache/yarn/v4/npm-expand-range-1.8.2-a299effd335fe2721ebae8e257ec79644fc85337/node_modules/expand-range/", {"name":"expand-range","reference":"1.8.2"}],
  ["../../.cache/yarn/v4/npm-randomatic-3.1.1-b776efc59375984e36c537b2f51a1f0aff0da1ed/node_modules/randomatic/", {"name":"randomatic","reference":"3.1.1"}],
  ["../../.cache/yarn/v4/npm-math-random-1.0.4-5dd6943c938548267016d4e34f057583080c514c/node_modules/math-random/", {"name":"math-random","reference":"1.0.4"}],
  ["../../.cache/yarn/v4/npm-preserve-0.2.0-815ed1f6ebc65926f865b310c0713bcb3315ce4b/node_modules/preserve/", {"name":"preserve","reference":"0.2.0"}],
  ["../../.cache/yarn/v4/npm-is-posix-bracket-0.1.1-3334dc79774368e92f016e6fbc0a88f5cd6e6bc4/node_modules/is-posix-bracket/", {"name":"is-posix-bracket","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-filename-regex-2.0.1-c1c4b9bee3e09725ddb106b75c1e301fe2f18b26/node_modules/filename-regex/", {"name":"filename-regex","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-object-omit-2.0.1-1a9c744829f39dbb858c76ca3579ae2a54ebd1fa/node_modules/object.omit/", {"name":"object.omit","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-for-own-0.1.5-5265c681a4f294dabbf17c9509b6763aa84510ce/node_modules/for-own/", {"name":"for-own","reference":"0.1.5"}],
  ["../../.cache/yarn/v4/npm-for-own-1.0.0-c63332f415cedc4b04dbfe70cf836494c53cb44b/node_modules/for-own/", {"name":"for-own","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-parse-glob-3.0.4-b2c376cfb11f35513badd173ef0bb6e3a388391c/node_modules/parse-glob/", {"name":"parse-glob","reference":"3.0.4"}],
  ["../../.cache/yarn/v4/npm-glob-base-0.3.0-dbb164f6221b1c0b1ccf82aea328b497df0ea3c4/node_modules/glob-base/", {"name":"glob-base","reference":"0.3.0"}],
  ["../../.cache/yarn/v4/npm-is-dotfile-1.0.3-a6a2f32ffd2dfb04f5ca25ecd0f6b83cf798a1e1/node_modules/is-dotfile/", {"name":"is-dotfile","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-regex-cache-0.4.4-75bdc58a2a1496cec48a12835bc54c8d562336dd/node_modules/regex-cache/", {"name":"regex-cache","reference":"0.4.4"}],
  ["../../.cache/yarn/v4/npm-is-equal-shallow-0.1.3-2238098fc221de0bcfa5d9eac4c45d638aa1c534/node_modules/is-equal-shallow/", {"name":"is-equal-shallow","reference":"0.1.3"}],
  ["../../.cache/yarn/v4/npm-is-primitive-2.0.0-207bab91638499c07b2adf240a41a87210034575/node_modules/is-primitive/", {"name":"is-primitive","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-opn-5.3.0-64871565c863875f052cfdf53d3e3cb5adb53b1c/node_modules/opn/", {"name":"opn","reference":"5.3.0"}],
  ["../../.cache/yarn/v4/npm-is-wsl-1.1.0-1f16e4aa22b04d1336b66188a66af3c600c3a66d/node_modules/is-wsl/", {"name":"is-wsl","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-portscanner-2.1.1-eabb409e4de24950f5a2a516d35ae769343fbb96/node_modules/portscanner/", {"name":"portscanner","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-async-1.5.2-ec6a61ae56480c0c3cb241c95618e20892f9672a/node_modules/async/", {"name":"async","reference":"1.5.2"}],
  ["../../.cache/yarn/v4/npm-is-number-like-1.0.8-2e129620b50891042e44e9bbbb30593e75cfbbe3/node_modules/is-number-like/", {"name":"is-number-like","reference":"1.0.8"}],
  ["../../.cache/yarn/v4/npm-lodash-isfinite-3.3.2-fb89b65a9a80281833f0b7478b3a5104f898ebb3/node_modules/lodash.isfinite/", {"name":"lodash.isfinite","reference":"3.3.2"}],
  ["../../.cache/yarn/v4/npm-qs-6.2.3-1cfcb25c10a9b2b483053ff39f5dfc9233908cfe/node_modules/qs/", {"name":"qs","reference":"6.2.3"}],
  ["../../.cache/yarn/v4/npm-qs-6.5.2-cb3ae806e8740444584ef154ce8ee98d403f3e36/node_modules/qs/", {"name":"qs","reference":"6.5.2"}],
  ["../../.cache/yarn/v4/npm-raw-body-2.3.3-1b324ece6b5706e153855bc1148c65bb7f6ea0c3/node_modules/raw-body/", {"name":"raw-body","reference":"2.3.3"}],
  ["../../.cache/yarn/v4/npm-bytes-3.0.0-d32815404d689699f85a4ea4fa8755dd13a96048/node_modules/bytes/", {"name":"bytes","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-http-errors-1.6.3-8b55680bb4be283a0b5bf4ea2e38580be1d9320d/node_modules/http-errors/", {"name":"http-errors","reference":"1.6.3"}],
  ["../../.cache/yarn/v4/npm-depd-1.1.2-9bcd52e14c097763e749b274c4346ed2e560b5a9/node_modules/depd/", {"name":"depd","reference":"1.1.2"}],
  ["../../.cache/yarn/v4/npm-setprototypeof-1.1.0-d0bd85536887b6fe7c0d818cb962d9d91c54e656/node_modules/setprototypeof/", {"name":"setprototypeof","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-iconv-lite-0.4.23-297871f63be507adcfbfca715d0cd0eed84e9a63/node_modules/iconv-lite/", {"name":"iconv-lite","reference":"0.4.23"}],
  ["../../.cache/yarn/v4/npm-safer-buffer-2.1.2-44fa161b0187b9549dd84bb91802f9bd8385cd6a/node_modules/safer-buffer/", {"name":"safer-buffer","reference":"2.1.2"}],
  ["../../.cache/yarn/v4/npm-resp-modifier-6.0.2-b124de5c4fbafcba541f48ffa73970f4aa456b4f/node_modules/resp-modifier/", {"name":"resp-modifier","reference":"6.0.2"}],
  ["../../.cache/yarn/v4/npm-minimatch-3.0.4-5166e286457f03306064be5497e8dbb0c3d32083/node_modules/minimatch/", {"name":"minimatch","reference":"3.0.4"}],
  ["../../.cache/yarn/v4/npm-brace-expansion-1.1.11-3c7fcbf529d87226f3d2f52b966ff5271eb441dd/node_modules/brace-expansion/", {"name":"brace-expansion","reference":"1.1.11"}],
  ["../../.cache/yarn/v4/npm-balanced-match-1.0.0-89b4d199ab2bee49de164ea02b89ce462d71b767/node_modules/balanced-match/", {"name":"balanced-match","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-concat-map-0.0.1-d8a96bd77fd68df7793a73036a3ba0d5405d477b/node_modules/concat-map/", {"name":"concat-map","reference":"0.0.1"}],
  ["../../.cache/yarn/v4/npm-rx-4.1.0-a5f13ff79ef3b740fe30aa803fb09f98805d4782/node_modules/rx/", {"name":"rx","reference":"4.1.0"}],
  ["../../.cache/yarn/v4/npm-send-0.16.2-6ecca1e0f8c156d141597559848df64730a6bbc1/node_modules/send/", {"name":"send","reference":"0.16.2"}],
  ["../../.cache/yarn/v4/npm-destroy-1.0.4-978857442c44749e4206613e37946205826abd80/node_modules/destroy/", {"name":"destroy","reference":"1.0.4"}],
  ["../../.cache/yarn/v4/npm-mime-1.4.1-121f9ebc49e3766f311a76e1fa1c8003c4b03aa6/node_modules/mime/", {"name":"mime","reference":"1.4.1"}],
  ["../../.cache/yarn/v4/npm-range-parser-1.2.0-f49be6b487894ddc40dcc94a322f611092e00d5e/node_modules/range-parser/", {"name":"range-parser","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-serve-index-1.9.1-d3768d69b1e7d82e5ce050fff5b453bea12a9239/node_modules/serve-index/", {"name":"serve-index","reference":"1.9.1"}],
  ["../../.cache/yarn/v4/npm-accepts-1.3.5-eb777df6011723a3b14e8a72c0805c8e86746bd2/node_modules/accepts/", {"name":"accepts","reference":"1.3.5"}],
  ["../../.cache/yarn/v4/npm-mime-types-2.1.22-fe6b355a190926ab7698c9a0556a11199b2199bd/node_modules/mime-types/", {"name":"mime-types","reference":"2.1.22"}],
  ["../../.cache/yarn/v4/npm-mime-db-1.38.0-1a2aab16da9eb167b49c6e4df2d9c68d63d8e2ad/node_modules/mime-db/", {"name":"mime-db","reference":"1.38.0"}],
  ["../../.cache/yarn/v4/npm-negotiator-0.6.1-2b327184e8992101177b28563fb5e7102acd0ca9/node_modules/negotiator/", {"name":"negotiator","reference":"0.6.1"}],
  ["../../.cache/yarn/v4/npm-batch-0.6.1-dc34314f4e679318093fc760272525f94bf25c16/node_modules/batch/", {"name":"batch","reference":"0.6.1"}],
  ["../../.cache/yarn/v4/npm-serve-static-1.13.2-095e8472fd5b46237db50ce486a43f4b86c6cec1/node_modules/serve-static/", {"name":"serve-static","reference":"1.13.2"}],
  ["../../.cache/yarn/v4/npm-socket-io-2.1.1-a069c5feabee3e6b214a75b40ce0652e1cfb9980/node_modules/socket.io/", {"name":"socket.io","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-engine-io-3.2.1-b60281c35484a70ee0351ea0ebff83ec8c9522a2/node_modules/engine.io/", {"name":"engine.io","reference":"3.2.1"}],
  ["../../.cache/yarn/v4/npm-base64id-1.0.0-47688cb99bb6804f0e06d3e763b1c32e57d8e6b6/node_modules/base64id/", {"name":"base64id","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-cookie-0.3.1-e7e0a1f9ef43b4c8ba925c5c5a96e806d16873bb/node_modules/cookie/", {"name":"cookie","reference":"0.3.1"}],
  ["../../.cache/yarn/v4/npm-ultron-1.1.1-9fe1536a10a664a65266a1e3ccf85fd36302bc9c/node_modules/ultron/", {"name":"ultron","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-socket-io-adapter-1.1.1-2a805e8a14d6372124dd9159ad4502f8cb07f06b/node_modules/socket.io-adapter/", {"name":"socket.io-adapter","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-ua-parser-js-0.7.17-e9ec5f9498b9ec910e7ae3ac626a805c4d09ecac/node_modules/ua-parser-js/", {"name":"ua-parser-js","reference":"0.7.17"}],
  ["../../.cache/yarn/v4/npm-window-size-0.2.0-b4315bb4214a3d7058ebeee892e13fa24d98b075/node_modules/window-size/", {"name":"window-size","reference":"0.2.0"}],
  ["../../.cache/yarn/v4/npm-css-mqpacker-7.0.0-48f4a0ff45b81ec661c4a33ed80b9db8a026333b/node_modules/css-mqpacker/", {"name":"css-mqpacker","reference":"7.0.0"}],
  ["../../.cache/yarn/v4/npm-minimist-1.2.0-a35008b20f41383eec1fb914f4cd5df79a264284/node_modules/minimist/", {"name":"minimist","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-minimist-0.0.8-857fcabfc3397d2625b8228262e86aa7a011b05d/node_modules/minimist/", {"name":"minimist","reference":"0.0.8"}],
  ["../../.cache/yarn/v4/npm-gulp-plumber-1.2.1-d38700755a300b9d372318e4ffb5ff7ced0b2c84/node_modules/gulp-plumber/", {"name":"gulp-plumber","reference":"1.2.1"}],
  ["../../.cache/yarn/v4/npm-fancy-log-1.3.3-dbc19154f558690150a23953a0adbd035be45fc7/node_modules/fancy-log/", {"name":"fancy-log","reference":"1.3.3"}],
  ["../../.cache/yarn/v4/npm-ansi-gray-0.1.1-2962cf54ec9792c48510a3deb524436861ef7251/node_modules/ansi-gray/", {"name":"ansi-gray","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-ansi-wrap-0.1.0-a82250ddb0015e9a27ca82e82ea603bbfa45efaf/node_modules/ansi-wrap/", {"name":"ansi-wrap","reference":"0.1.0"}],
  ["../../.cache/yarn/v4/npm-color-support-1.1.3-93834379a1cc9a0c61f82f52f0d04322251bd5a2/node_modules/color-support/", {"name":"color-support","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-parse-node-version-1.0.1-e2b5dbede00e7fa9bc363607f53327e8b073189b/node_modules/parse-node-version/", {"name":"parse-node-version","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-time-stamp-1.1.0-764a5a11af50561921b133f3b44e618687e0f5c3/node_modules/time-stamp/", {"name":"time-stamp","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-plugin-error-0.1.2-3b9bb3335ccf00f425e07437e19276967da47ace/node_modules/plugin-error/", {"name":"plugin-error","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-plugin-error-1.0.1-77016bd8919d0ac377fdcdd0322328953ca5781c/node_modules/plugin-error/", {"name":"plugin-error","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-ansi-cyan-0.1.1-538ae528af8982f28ae30d86f2f17456d2609873/node_modules/ansi-cyan/", {"name":"ansi-cyan","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-ansi-red-0.1.1-8c638f9d1080800a353c9c28c8a81ca4705d946c/node_modules/ansi-red/", {"name":"ansi-red","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-array-slice-0.2.3-dd3cfb80ed7973a75117cdac69b0b99ec86186f5/node_modules/array-slice/", {"name":"array-slice","reference":"0.2.3"}],
  ["../../.cache/yarn/v4/npm-array-slice-1.1.0-e368ea15f89bc7069f7ffb89aec3a6c7d4ac22d4/node_modules/array-slice/", {"name":"array-slice","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-through2-2.0.5-01c1e39eb31d07cb7d03a96a70823260b23132cd/node_modules/through2/", {"name":"through2","reference":"2.0.5"}],
  ["../../.cache/yarn/v4/npm-xtend-4.0.1-a5c6d532be656e23db820efb943a1f04998d63af/node_modules/xtend/", {"name":"xtend","reference":"4.0.1"}],
  ["../../.cache/yarn/v4/npm-gulp-postcss-8.0.0-8d3772cd4d27bca55ec8cb4c8e576e3bde4dc550/node_modules/gulp-postcss/", {"name":"gulp-postcss","reference":"8.0.0"}],
  ["../../.cache/yarn/v4/npm-ansi-colors-1.1.0-6374b4dd5d4718ff3ce27a671a3b1cad077132a9/node_modules/ansi-colors/", {"name":"ansi-colors","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-postcss-load-config-2.0.0-f1312ddbf5912cd747177083c5ef7a19d62ee484/node_modules/postcss-load-config/", {"name":"postcss-load-config","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-cosmiconfig-4.0.0-760391549580bbd2df1e562bc177b13c290972dc/node_modules/cosmiconfig/", {"name":"cosmiconfig","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-is-directory-0.3.1-61339b6f2475fc772fd9c9d83f5c8575dc154ae1/node_modules/is-directory/", {"name":"is-directory","reference":"0.3.1"}],
  ["../../.cache/yarn/v4/npm-js-yaml-3.12.2-ef1d067c5a9d9cb65bd72f285b5d8105c77f14fc/node_modules/js-yaml/", {"name":"js-yaml","reference":"3.12.2"}],
  ["../../.cache/yarn/v4/npm-argparse-1.0.10-bcd6791ea5ae09725e17e5ad988134cd40b3d911/node_modules/argparse/", {"name":"argparse","reference":"1.0.10"}],
  ["../../.cache/yarn/v4/npm-sprintf-js-1.0.3-04e6926f662895354f3dd015203633b857297e2c/node_modules/sprintf-js/", {"name":"sprintf-js","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-esprima-4.0.1-13b04cdb3e6c5d19df91ab6987a8695619b0aa71/node_modules/esprima/", {"name":"esprima","reference":"4.0.1"}],
  ["../../.cache/yarn/v4/npm-json-parse-better-errors-1.0.2-bb867cfb3450e69107c131d1c514bab3dc8bcaa9/node_modules/json-parse-better-errors/", {"name":"json-parse-better-errors","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-require-from-string-2.0.2-89a7fdd938261267318eafe14f9c32e598c36909/node_modules/require-from-string/", {"name":"require-from-string","reference":"2.0.2"}],
  ["../../.cache/yarn/v4/npm-import-cwd-2.1.0-aa6cf36e722761285cb371ec6519f53e2435b0a9/node_modules/import-cwd/", {"name":"import-cwd","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-import-from-2.1.0-335db7f2a7affd53aaa471d4b8021dee36b7f3b1/node_modules/import-from/", {"name":"import-from","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-resolve-from-3.0.0-b22c7af7d9d6881bc8b6e653335eebcb0a188748/node_modules/resolve-from/", {"name":"resolve-from","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-vinyl-sourcemaps-apply-0.2.1-ab6549d61d172c2b1b87be5c508d239c8ef87705/node_modules/vinyl-sourcemaps-apply/", {"name":"vinyl-sourcemaps-apply","reference":"0.2.1"}],
  ["../../.cache/yarn/v4/npm-gulp-rename-1.4.0-de1c718e7c4095ae861f7296ef4f3248648240bd/node_modules/gulp-rename/", {"name":"gulp-rename","reference":"1.4.0"}],
  ["../../.cache/yarn/v4/npm-gulp-sass-4.0.2-cfb1e3eff2bd9852431c7ce87f43880807d8d505/node_modules/gulp-sass/", {"name":"gulp-sass","reference":"4.0.2"}],
  ["../../.cache/yarn/v4/npm-lodash-clonedeep-4.5.0-e23f3f9c4f8fbdde872529c1071857a086e5ccef/node_modules/lodash.clonedeep/", {"name":"lodash.clonedeep","reference":"4.5.0"}],
  ["./.pnp/unplugged/npm-node-sass-4.11.0-183faec398e9cbe93ba43362e2768ca988a6369a/node_modules/node-sass/", {"name":"node-sass","reference":"4.11.0"}],
  ["../../.cache/yarn/v4/npm-async-foreach-0.1.3-36121f845c0578172de419a97dbeb1d16ec34542/node_modules/async-foreach/", {"name":"async-foreach","reference":"0.1.3"}],
  ["../../.cache/yarn/v4/npm-cross-spawn-3.0.1-1256037ecb9f0c5f79e3d6ef135e30770184b982/node_modules/cross-spawn/", {"name":"cross-spawn","reference":"3.0.1"}],
  ["../../.cache/yarn/v4/npm-lru-cache-4.1.5-8bbe50ea85bed59bc9e33dcab8235ee9bcf443cd/node_modules/lru-cache/", {"name":"lru-cache","reference":"4.1.5"}],
  ["../../.cache/yarn/v4/npm-pseudomap-1.0.2-f052a28da70e618917ef0a8ac34c1ae5a68286b3/node_modules/pseudomap/", {"name":"pseudomap","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-yallist-2.1.2-1c11f9218f076089a47dd512f93c6699a6a81d52/node_modules/yallist/", {"name":"yallist","reference":"2.1.2"}],
  ["../../.cache/yarn/v4/npm-which-1.3.1-a45043d54f5805316da8d62f9f50918d3da70b0a/node_modules/which/", {"name":"which","reference":"1.3.1"}],
  ["../../.cache/yarn/v4/npm-isexe-2.0.0-e8fbf374dc556ff8947a10dcb0572d633f2cfa10/node_modules/isexe/", {"name":"isexe","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-gaze-1.1.3-c441733e13b927ac8c0ff0b4c3b033f28812924a/node_modules/gaze/", {"name":"gaze","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-globule-1.2.1-5dffb1b191f22d20797a9369b49eab4e9839696d/node_modules/globule/", {"name":"globule","reference":"1.2.1"}],
  ["../../.cache/yarn/v4/npm-glob-7.1.3-3960832d3f1574108342dafd3a67b332c0969df1/node_modules/glob/", {"name":"glob","reference":"7.1.3"}],
  ["../../.cache/yarn/v4/npm-fs-realpath-1.0.0-1504ad2523158caa40db4a2787cb01411994ea4f/node_modules/fs.realpath/", {"name":"fs.realpath","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-inflight-1.0.6-49bd6331d7d02d0c09bc910a1075ba8165b56df9/node_modules/inflight/", {"name":"inflight","reference":"1.0.6"}],
  ["../../.cache/yarn/v4/npm-once-1.4.0-583b1aa775961d4b113ac17d9c50baef9dd76bd1/node_modules/once/", {"name":"once","reference":"1.4.0"}],
  ["../../.cache/yarn/v4/npm-wrappy-1.0.2-b5243d8f3ec1aa35f1364605bc0d1036e30ab69f/node_modules/wrappy/", {"name":"wrappy","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-get-stdin-4.0.1-b968c6b0a04384324902e8bf1a5df32579a450fe/node_modules/get-stdin/", {"name":"get-stdin","reference":"4.0.1"}],
  ["../../.cache/yarn/v4/npm-in-publish-2.0.0-e20ff5e3a2afc2690320b6dc552682a9c7fadf51/node_modules/in-publish/", {"name":"in-publish","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-lodash-assign-4.2.0-0d99f3ccd7a6d261d19bdaeb9245005d285808e7/node_modules/lodash.assign/", {"name":"lodash.assign","reference":"4.2.0"}],
  ["../../.cache/yarn/v4/npm-lodash-mergewith-4.6.1-639057e726c3afbdb3e7d42741caa8d6e4335927/node_modules/lodash.mergewith/", {"name":"lodash.mergewith","reference":"4.6.1"}],
  ["../../.cache/yarn/v4/npm-meow-3.7.0-72cb668b425228290abbfa856892587308a801fb/node_modules/meow/", {"name":"meow","reference":"3.7.0"}],
  ["../../.cache/yarn/v4/npm-camelcase-keys-2.1.0-308beeaffdf28119051efa1d932213c91b8f92e7/node_modules/camelcase-keys/", {"name":"camelcase-keys","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-map-obj-1.0.1-d933ceb9205d82bdcf4886f6742bdc2b4dea146d/node_modules/map-obj/", {"name":"map-obj","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-loud-rejection-1.6.0-5b46f80147edee578870f086d04821cf998e551f/node_modules/loud-rejection/", {"name":"loud-rejection","reference":"1.6.0"}],
  ["../../.cache/yarn/v4/npm-currently-unhandled-0.4.1-988df33feab191ef799a61369dd76c17adf957ea/node_modules/currently-unhandled/", {"name":"currently-unhandled","reference":"0.4.1"}],
  ["../../.cache/yarn/v4/npm-array-find-index-1.0.2-df010aa1287e164bbda6f9723b0a96a1ec4187a1/node_modules/array-find-index/", {"name":"array-find-index","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-signal-exit-3.0.2-b5fdc08f1287ea1178628e415e25132b73646c6d/node_modules/signal-exit/", {"name":"signal-exit","reference":"3.0.2"}],
  ["../../.cache/yarn/v4/npm-object-assign-4.1.1-2109adc7965887cfc05cbbd442cac8bfbb360863/node_modules/object-assign/", {"name":"object-assign","reference":"4.1.1"}],
  ["../../.cache/yarn/v4/npm-redent-1.0.0-cf916ab1fd5f1f16dfb20822dd6ec7f730c2afde/node_modules/redent/", {"name":"redent","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-indent-string-2.1.0-8e2d48348742121b4a8218b7a137e9a52049dc80/node_modules/indent-string/", {"name":"indent-string","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-repeating-2.0.1-5214c53a926d3552707527fbab415dbc08d06dda/node_modules/repeating/", {"name":"repeating","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-is-finite-1.0.2-cc6677695602be550ef11e8b4aa6305342b6d0aa/node_modules/is-finite/", {"name":"is-finite","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-strip-indent-1.0.1-0c7962a6adefa7bbd4ac366460a638552ae1a0a2/node_modules/strip-indent/", {"name":"strip-indent","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-trim-newlines-1.0.0-5887966bb582a4503a41eb524f7d35011815a613/node_modules/trim-newlines/", {"name":"trim-newlines","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-mkdirp-0.5.1-30057438eac6cf7f8c4767f38648d6697d75c903/node_modules/mkdirp/", {"name":"mkdirp","reference":"0.5.1"}],
  ["../../.cache/yarn/v4/npm-nan-2.12.1-7b1aa193e9aa86057e3c7bbd0ac448e770925552/node_modules/nan/", {"name":"nan","reference":"2.12.1"}],
  ["../../.cache/yarn/v4/npm-node-gyp-3.8.0-540304261c330e80d0d5edce253a68cb3964218c/node_modules/node-gyp/", {"name":"node-gyp","reference":"3.8.0"}],
  ["../../.cache/yarn/v4/npm-fstream-1.0.11-5c1fb1f117477114f0632a0eb4b71b3cb0fd3171/node_modules/fstream/", {"name":"fstream","reference":"1.0.11"}],
  ["../../.cache/yarn/v4/npm-rimraf-2.6.3-b2d104fe0d8fb27cf9e0a1cda8262dd3833c6cab/node_modules/rimraf/", {"name":"rimraf","reference":"2.6.3"}],
  ["../../.cache/yarn/v4/npm-nopt-3.0.6-c6465dbf08abcd4db359317f79ac68a646b28ff9/node_modules/nopt/", {"name":"nopt","reference":"3.0.6"}],
  ["../../.cache/yarn/v4/npm-abbrev-1.1.1-f8f2c887ad10bf67f634f005b6987fed3179aac8/node_modules/abbrev/", {"name":"abbrev","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-npmlog-4.1.2-08a7f2a8bf734604779a9efa4ad5cc717abb954b/node_modules/npmlog/", {"name":"npmlog","reference":"4.1.2"}],
  ["../../.cache/yarn/v4/npm-are-we-there-yet-1.1.5-4b35c2944f062a8bfcda66410760350fe9ddfc21/node_modules/are-we-there-yet/", {"name":"are-we-there-yet","reference":"1.1.5"}],
  ["../../.cache/yarn/v4/npm-delegates-1.0.0-84c6e159b81904fdca59a0ef44cd870d31250f9a/node_modules/delegates/", {"name":"delegates","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-console-control-strings-1.1.0-3d7cf4464db6446ea644bf4b39507f9851008e8e/node_modules/console-control-strings/", {"name":"console-control-strings","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-gauge-2.7.4-2c03405c7538c39d7eb37b317022e325fb018bf7/node_modules/gauge/", {"name":"gauge","reference":"2.7.4"}],
  ["../../.cache/yarn/v4/npm-aproba-1.2.0-6802e6264efd18c790a1b0d517f0f2627bf2c94a/node_modules/aproba/", {"name":"aproba","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-has-unicode-2.0.1-e0e6fe6a28cf51138855e086d1691e771de2a8b9/node_modules/has-unicode/", {"name":"has-unicode","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-wide-align-1.1.3-ae074e6bdc0c14a431e804e624549c633b000457/node_modules/wide-align/", {"name":"wide-align","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-osenv-0.1.5-85cdfafaeb28e8677f416e287592b5f3f49ea410/node_modules/osenv/", {"name":"osenv","reference":"0.1.5"}],
  ["../../.cache/yarn/v4/npm-os-homedir-1.0.2-ffbc4988336e0e833de0c168c7ef152121aa7fb3/node_modules/os-homedir/", {"name":"os-homedir","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-os-tmpdir-1.0.2-bbe67406c79aa85c5cfec766fe5734555dfa1274/node_modules/os-tmpdir/", {"name":"os-tmpdir","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-request-2.88.0-9c2fca4f7d35b592efe57c7f0a55e81052124fef/node_modules/request/", {"name":"request","reference":"2.88.0"}],
  ["../../.cache/yarn/v4/npm-aws-sign2-0.7.0-b46e890934a9591f2d2f6f86d7e6a9f1b3fe76a8/node_modules/aws-sign2/", {"name":"aws-sign2","reference":"0.7.0"}],
  ["../../.cache/yarn/v4/npm-aws4-1.8.0-f0e003d9ca9e7f59c7a508945d7b2ef9a04a542f/node_modules/aws4/", {"name":"aws4","reference":"1.8.0"}],
  ["../../.cache/yarn/v4/npm-caseless-0.12.0-1b681c21ff84033c826543090689420d187151dc/node_modules/caseless/", {"name":"caseless","reference":"0.12.0"}],
  ["../../.cache/yarn/v4/npm-combined-stream-1.0.7-2d1d24317afb8abe95d6d2c0b07b57813539d828/node_modules/combined-stream/", {"name":"combined-stream","reference":"1.0.7"}],
  ["../../.cache/yarn/v4/npm-delayed-stream-1.0.0-df3ae199acadfb7d440aaae0b29e2272b24ec619/node_modules/delayed-stream/", {"name":"delayed-stream","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-extend-3.0.2-f8b1136b4071fbd8eb140aff858b1019ec2915fa/node_modules/extend/", {"name":"extend","reference":"3.0.2"}],
  ["../../.cache/yarn/v4/npm-forever-agent-0.6.1-fbc71f0c41adeb37f96c577ad1ed42d8fdacca91/node_modules/forever-agent/", {"name":"forever-agent","reference":"0.6.1"}],
  ["../../.cache/yarn/v4/npm-form-data-2.3.3-dcce52c05f644f298c6a7ab936bd724ceffbf3a6/node_modules/form-data/", {"name":"form-data","reference":"2.3.3"}],
  ["../../.cache/yarn/v4/npm-asynckit-0.4.0-c79ed97f7f34cb8f2ba1bc9790bcc366474b4b79/node_modules/asynckit/", {"name":"asynckit","reference":"0.4.0"}],
  ["../../.cache/yarn/v4/npm-har-validator-5.1.3-1ef89ebd3e4996557675eed9893110dc350fa080/node_modules/har-validator/", {"name":"har-validator","reference":"5.1.3"}],
  ["../../.cache/yarn/v4/npm-ajv-6.10.0-90d0d54439da587cd7e843bfb7045f50bd22bdf1/node_modules/ajv/", {"name":"ajv","reference":"6.10.0"}],
  ["../../.cache/yarn/v4/npm-fast-deep-equal-2.0.1-7b05218ddf9667bf7f370bf7fdb2cb15fdd0aa49/node_modules/fast-deep-equal/", {"name":"fast-deep-equal","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-fast-json-stable-stringify-2.0.0-d5142c0caee6b1189f87d3a76111064f86c8bbf2/node_modules/fast-json-stable-stringify/", {"name":"fast-json-stable-stringify","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-json-schema-traverse-0.4.1-69f6a87d9513ab8bb8fe63bdb0979c448e684660/node_modules/json-schema-traverse/", {"name":"json-schema-traverse","reference":"0.4.1"}],
  ["../../.cache/yarn/v4/npm-uri-js-4.2.2-94c540e1ff772956e2299507c010aea6c8838eb0/node_modules/uri-js/", {"name":"uri-js","reference":"4.2.2"}],
  ["../../.cache/yarn/v4/npm-punycode-2.1.1-b58b010ac40c22c5657616c8d2c2c02c7bf479ec/node_modules/punycode/", {"name":"punycode","reference":"2.1.1"}],
  ["../../.cache/yarn/v4/npm-punycode-1.4.1-c0d5a63b2718800ad8e1eb0fa5269c84dd41845e/node_modules/punycode/", {"name":"punycode","reference":"1.4.1"}],
  ["../../.cache/yarn/v4/npm-har-schema-2.0.0-a94c2224ebcac04782a0d9035521f24735b7ec92/node_modules/har-schema/", {"name":"har-schema","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-http-signature-1.2.0-9aecd925114772f3d95b65a60abb8f7c18fbace1/node_modules/http-signature/", {"name":"http-signature","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-assert-plus-1.0.0-f12e0f3c5d77b0b1cdd9146942e4e96c1e4dd525/node_modules/assert-plus/", {"name":"assert-plus","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-jsprim-1.4.1-313e66bc1e5cc06e438bc1b7499c2e5c56acb6a2/node_modules/jsprim/", {"name":"jsprim","reference":"1.4.1"}],
  ["../../.cache/yarn/v4/npm-extsprintf-1.3.0-96918440e3041a7a414f8c52e3c574eb3c3e1e05/node_modules/extsprintf/", {"name":"extsprintf","reference":"1.3.0"}],
  ["../../.cache/yarn/v4/npm-extsprintf-1.4.0-e2689f8f356fad62cca65a3a91c5df5f9551692f/node_modules/extsprintf/", {"name":"extsprintf","reference":"1.4.0"}],
  ["../../.cache/yarn/v4/npm-json-schema-0.2.3-b480c892e59a2f05954ce727bd3f2a4e882f9e13/node_modules/json-schema/", {"name":"json-schema","reference":"0.2.3"}],
  ["../../.cache/yarn/v4/npm-verror-1.10.0-3a105ca17053af55d6e270c1f8288682e18da400/node_modules/verror/", {"name":"verror","reference":"1.10.0"}],
  ["../../.cache/yarn/v4/npm-sshpk-1.16.1-fb661c0bef29b39db40769ee39fa70093d6f6877/node_modules/sshpk/", {"name":"sshpk","reference":"1.16.1"}],
  ["../../.cache/yarn/v4/npm-asn1-0.2.4-8d2475dfab553bb33e77b54e59e880bb8ce23136/node_modules/asn1/", {"name":"asn1","reference":"0.2.4"}],
  ["../../.cache/yarn/v4/npm-bcrypt-pbkdf-1.0.2-a4301d389b6a43f9b67ff3ca11a3f6637e360e9e/node_modules/bcrypt-pbkdf/", {"name":"bcrypt-pbkdf","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-tweetnacl-0.14.5-5ae68177f192d4456269d108afa93ff8743f4f64/node_modules/tweetnacl/", {"name":"tweetnacl","reference":"0.14.5"}],
  ["../../.cache/yarn/v4/npm-dashdash-1.14.1-853cfa0f7cbe2fed5de20326b8dd581035f6e2f0/node_modules/dashdash/", {"name":"dashdash","reference":"1.14.1"}],
  ["../../.cache/yarn/v4/npm-ecc-jsbn-0.1.2-3a83a904e54353287874c564b7549386849a98c9/node_modules/ecc-jsbn/", {"name":"ecc-jsbn","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-jsbn-0.1.1-a5e654c2e5a2deb5f201d96cefbca80c0ef2f513/node_modules/jsbn/", {"name":"jsbn","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-getpass-0.1.7-5eff8e3e684d569ae4cb2b1282604e8ba62149fa/node_modules/getpass/", {"name":"getpass","reference":"0.1.7"}],
  ["../../.cache/yarn/v4/npm-is-typedarray-1.0.0-e479c80858df0c1b11ddda6940f96011fcda4a9a/node_modules/is-typedarray/", {"name":"is-typedarray","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-isstream-0.1.2-47e63f7af55afa6f92e1500e690eb8b8529c099a/node_modules/isstream/", {"name":"isstream","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-json-stringify-safe-5.0.1-1296a2d58fd45f19a0f6ce01d65701e2c735b6eb/node_modules/json-stringify-safe/", {"name":"json-stringify-safe","reference":"5.0.1"}],
  ["../../.cache/yarn/v4/npm-oauth-sign-0.9.0-47a7b016baa68b5fa0ecf3dee08a85c679ac6455/node_modules/oauth-sign/", {"name":"oauth-sign","reference":"0.9.0"}],
  ["../../.cache/yarn/v4/npm-performance-now-2.1.0-6309f4e0e5fa913ec1c69307ae364b4b377c9e7b/node_modules/performance-now/", {"name":"performance-now","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-tough-cookie-2.4.3-53f36da3f47783b0925afa06ff9f3b165280f781/node_modules/tough-cookie/", {"name":"tough-cookie","reference":"2.4.3"}],
  ["../../.cache/yarn/v4/npm-psl-1.1.31-e9aa86d0101b5b105cbe93ac6b784cd547276184/node_modules/psl/", {"name":"psl","reference":"1.1.31"}],
  ["../../.cache/yarn/v4/npm-tunnel-agent-0.6.0-27a5dea06b36b04a0a9966774b290868f0fc40fd/node_modules/tunnel-agent/", {"name":"tunnel-agent","reference":"0.6.0"}],
  ["../../.cache/yarn/v4/npm-uuid-3.3.2-1b4af4955eb3077c501c23872fc6513811587131/node_modules/uuid/", {"name":"uuid","reference":"3.3.2"}],
  ["../../.cache/yarn/v4/npm-tar-2.2.1-8e4d2a256c0e2185c6b18ad694aec968b83cb1d1/node_modules/tar/", {"name":"tar","reference":"2.2.1"}],
  ["../../.cache/yarn/v4/npm-block-stream-0.0.9-13ebfe778a03205cfe03751481ebb4b3300c126a/node_modules/block-stream/", {"name":"block-stream","reference":"0.0.9"}],
  ["../../.cache/yarn/v4/npm-sass-graph-2.2.4-13fbd63cd1caf0908b9fd93476ad43a51d1e0b49/node_modules/sass-graph/", {"name":"sass-graph","reference":"2.2.4"}],
  ["../../.cache/yarn/v4/npm-scss-tokenizer-0.2.3-8eb06db9a9723333824d3f5530641149847ce5d1/node_modules/scss-tokenizer/", {"name":"scss-tokenizer","reference":"0.2.3"}],
  ["../../.cache/yarn/v4/npm-js-base64-2.5.1-1efa39ef2c5f7980bb1784ade4a8af2de3291121/node_modules/js-base64/", {"name":"js-base64","reference":"2.5.1"}],
  ["../../.cache/yarn/v4/npm-amdefine-1.0.1-4a5282ac164729e93619bcfd3ad151f817ce91f5/node_modules/amdefine/", {"name":"amdefine","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-stdout-stream-1.4.1-5ac174cdd5cd726104aa0c0b2bd83815d8d535de/node_modules/stdout-stream/", {"name":"stdout-stream","reference":"1.4.1"}],
  ["../../.cache/yarn/v4/npm-true-case-path-1.0.3-f813b5a8c86b40da59606722b144e3225799f47d/node_modules/true-case-path/", {"name":"true-case-path","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-replace-ext-1.0.0-de63128373fcbf7c3ccfa4de5a480c45a67958eb/node_modules/replace-ext/", {"name":"replace-ext","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-gulp-sourcemaps-2.6.5-a3f002d87346d2c0f3aec36af7eb873f23de8ae6/node_modules/gulp-sourcemaps/", {"name":"gulp-sourcemaps","reference":"2.6.5"}],
  ["../../.cache/yarn/v4/npm-@gulp-sourcemaps-identity-map-1.0.2-1e6fe5d8027b1f285dc0d31762f566bccd73d5a9/node_modules/@gulp-sourcemaps/identity-map/", {"name":"@gulp-sourcemaps/identity-map","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-acorn-5.7.3-67aa231bf8812974b85235a96771eb6bd07ea279/node_modules/acorn/", {"name":"acorn","reference":"5.7.3"}],
  ["../../.cache/yarn/v4/npm-css-2.2.4-c646755c73971f2bba6a601e2cf2fd71b1298929/node_modules/css/", {"name":"css","reference":"2.2.4"}],
  ["../../.cache/yarn/v4/npm-@gulp-sourcemaps-map-sources-1.0.0-890ae7c5d8c877f6d384860215ace9d7ec945bda/node_modules/@gulp-sourcemaps/map-sources/", {"name":"@gulp-sourcemaps/map-sources","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-convert-source-map-1.6.0-51b537a8c43e0f04dec1993bffcdd504e758ac20/node_modules/convert-source-map/", {"name":"convert-source-map","reference":"1.6.0"}],
  ["../../.cache/yarn/v4/npm-debug-fabulous-1.1.0-af8a08632465224ef4174a9f06308c3c2a1ebc8e/node_modules/debug-fabulous/", {"name":"debug-fabulous","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-memoizee-0.4.14-07a00f204699f9a95c2d9e77218271c7cd610d57/node_modules/memoizee/", {"name":"memoizee","reference":"0.4.14"}],
  ["../../.cache/yarn/v4/npm-d-1.0.0-754bb5bfe55451da69a58b94d45f4c5b0462d58f/node_modules/d/", {"name":"d","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-es5-ext-0.10.49-059a239de862c94494fec28f8150c977028c6c5e/node_modules/es5-ext/", {"name":"es5-ext","reference":"0.10.49"}],
  ["../../.cache/yarn/v4/npm-es6-iterator-2.0.3-a7de889141a05a94b0854403b2d0a0fbfa98f3b7/node_modules/es6-iterator/", {"name":"es6-iterator","reference":"2.0.3"}],
  ["../../.cache/yarn/v4/npm-es6-symbol-3.1.1-bf00ef4fdab6ba1b46ecb7b629b4c7ed5715cc77/node_modules/es6-symbol/", {"name":"es6-symbol","reference":"3.1.1"}],
  ["../../.cache/yarn/v4/npm-next-tick-1.0.0-ca86d1fe8828169b0120208e3dc8424b9db8342c/node_modules/next-tick/", {"name":"next-tick","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-es6-weak-map-2.0.2-5e3ab32251ffd1538a1f8e5ffa1357772f92d96f/node_modules/es6-weak-map/", {"name":"es6-weak-map","reference":"2.0.2"}],
  ["../../.cache/yarn/v4/npm-event-emitter-0.3.5-df8c69eef1647923c7157b9ce83840610b02cc39/node_modules/event-emitter/", {"name":"event-emitter","reference":"0.3.5"}],
  ["../../.cache/yarn/v4/npm-is-promise-2.1.0-79a2a9ece7f096e80f36d2b2f3bc16c1ff4bf3fa/node_modules/is-promise/", {"name":"is-promise","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-lru-queue-0.1.0-2738bd9f0d3cf4f84490c5736c48699ac632cda3/node_modules/lru-queue/", {"name":"lru-queue","reference":"0.1.0"}],
  ["../../.cache/yarn/v4/npm-timers-ext-0.1.7-6f57ad8578e07a3fb9f91d9387d65647555e25c6/node_modules/timers-ext/", {"name":"timers-ext","reference":"0.1.7"}],
  ["../../.cache/yarn/v4/npm-detect-newline-2.1.0-f41f1c10be4b00e87b5f13da680759f2c5bfd3e2/node_modules/detect-newline/", {"name":"detect-newline","reference":"2.1.0"}],
  ["../../.cache/yarn/v4/npm-strip-bom-string-1.0.0-e5211e9224369fbb81d633a2f00044dc8cedad92/node_modules/strip-bom-string/", {"name":"strip-bom-string","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-gulp-uglify-es-1.0.4-59ee0d5ea98c1e09c6eaa58c8b018a6ad33f48d4/node_modules/gulp-uglify-es/", {"name":"gulp-uglify-es","reference":"1.0.4"}],
  ["../../.cache/yarn/v4/npm-o-stream-0.2.2-7fe03af870b8f9537af33b312b381b3034ab410f/node_modules/o-stream/", {"name":"o-stream","reference":"0.2.2"}],
  ["../../.cache/yarn/v4/npm-terser-3.17.0-f88ffbeda0deb5637f9d24b0da66f4e15ab10cb2/node_modules/terser/", {"name":"terser","reference":"3.17.0"}],
  ["../../.cache/yarn/v4/npm-source-map-support-0.5.10-2214080bc9d51832511ee2bab96e3c2f9353120c/node_modules/source-map-support/", {"name":"source-map-support","reference":"0.5.10"}],
  ["../../.cache/yarn/v4/npm-buffer-from-1.1.1-32713bc028f75c02fdb710d7c7bcec1f2c6070ef/node_modules/buffer-from/", {"name":"buffer-from","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-vinyl-2.2.0-d85b07da96e458d25b2ffe19fece9f2caa13ed86/node_modules/vinyl/", {"name":"vinyl","reference":"2.2.0"}],
  ["../../.cache/yarn/v4/npm-clone-2.1.2-1b7f4b9f591f1e8f83670401600345a02887435f/node_modules/clone/", {"name":"clone","reference":"2.1.2"}],
  ["../../.cache/yarn/v4/npm-clone-buffer-1.0.0-e3e25b207ac4e701af721e2cb5a16792cac3dc58/node_modules/clone-buffer/", {"name":"clone-buffer","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-clone-stats-1.0.0-b3782dff8bb5474e18b9b6bf0fdfe782f8777680/node_modules/clone-stats/", {"name":"clone-stats","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-cloneable-readable-1.1.2-d591dee4a8f8bc15da43ce97dceeba13d43e2a65/node_modules/cloneable-readable/", {"name":"cloneable-readable","reference":"1.1.2"}],
  ["../../.cache/yarn/v4/npm-gulp-4.0.0-95766c601dade4a77ed3e7b2b6dc03881b596366/node_modules/gulp/", {"name":"gulp","reference":"4.0.0"}],
  ["../../.cache/yarn/v4/npm-glob-watcher-5.0.3-88a8abf1c4d131eb93928994bc4a593c2e5dd626/node_modules/glob-watcher/", {"name":"glob-watcher","reference":"5.0.3"}],
  ["../../.cache/yarn/v4/npm-async-done-1.3.1-14b7b73667b864c8f02b5b253fc9c6eddb777f3e/node_modules/async-done/", {"name":"async-done","reference":"1.3.1"}],
  ["../../.cache/yarn/v4/npm-end-of-stream-1.4.1-ed29634d19baba463b6ce6b80a37213eab71ec43/node_modules/end-of-stream/", {"name":"end-of-stream","reference":"1.4.1"}],
  ["../../.cache/yarn/v4/npm-stream-exhaust-1.0.2-acdac8da59ef2bc1e17a2c0ccf6c320d120e555d/node_modules/stream-exhaust/", {"name":"stream-exhaust","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-is-negated-glob-1.0.0-6910bca5da8c95e784b5751b976cf5a10fee36d2/node_modules/is-negated-glob/", {"name":"is-negated-glob","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-just-debounce-1.0.0-87fccfaeffc0b68cd19d55f6722943f929ea35ea/node_modules/just-debounce/", {"name":"just-debounce","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-object-defaults-1.1.0-3a7f868334b407dea06da16d88d5cd29e435fecf/node_modules/object.defaults/", {"name":"object.defaults","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-array-each-1.0.1-a794af0c05ab1752846ee753a1f211a05ba0c44f/node_modules/array-each/", {"name":"array-each","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-gulp-cli-2.0.1-7847e220cb3662f2be8a6d572bf14e17be5a994b/node_modules/gulp-cli/", {"name":"gulp-cli","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-archy-1.0.0-f9c8c13757cc1dd7bc379ac77b2c62a5c2868c40/node_modules/archy/", {"name":"archy","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-array-sort-1.0.0-e4c05356453f56f53512a7d1d6123f2c54c0a88a/node_modules/array-sort/", {"name":"array-sort","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-default-compare-1.0.0-cb61131844ad84d84788fb68fd01681ca7781a2f/node_modules/default-compare/", {"name":"default-compare","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-concat-stream-1.6.2-904bdf194cd3122fc675c77fc4ac3d4ff0fd1a34/node_modules/concat-stream/", {"name":"concat-stream","reference":"1.6.2"}],
  ["../../.cache/yarn/v4/npm-typedarray-0.0.6-867ac74e3864187b1d3d47d996a78ec5c8830777/node_modules/typedarray/", {"name":"typedarray","reference":"0.0.6"}],
  ["../../.cache/yarn/v4/npm-copy-props-2.0.4-93bb1cadfafd31da5bb8a9d4b41f471ec3a72dfe/node_modules/copy-props/", {"name":"copy-props","reference":"2.0.4"}],
  ["../../.cache/yarn/v4/npm-each-props-1.3.2-ea45a414d16dd5cfa419b1a81720d5ca06892333/node_modules/each-props/", {"name":"each-props","reference":"1.3.2"}],
  ["../../.cache/yarn/v4/npm-gulplog-1.0.0-e28c4d45d05ecbbed818363ce8f9c5926229ffe5/node_modules/gulplog/", {"name":"gulplog","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-glogg-1.0.2-2d7dd702beda22eb3bffadf880696da6d846313f/node_modules/glogg/", {"name":"glogg","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-sparkles-1.0.1-008db65edce6c50eec0c5e228e1945061dd0437c/node_modules/sparkles/", {"name":"sparkles","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-interpret-1.2.0-d5061a6224be58e8083985f5014d844359576296/node_modules/interpret/", {"name":"interpret","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-liftoff-2.5.0-2009291bb31cea861bbf10a7c15a28caf75c31ec/node_modules/liftoff/", {"name":"liftoff","reference":"2.5.0"}],
  ["../../.cache/yarn/v4/npm-findup-sync-2.0.0-9326b1488c22d1a6088650a86901b2d9a90a2cbc/node_modules/findup-sync/", {"name":"findup-sync","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-detect-file-1.0.0-f0d66d03672a825cb1b73bdb3fe62310c8e552b7/node_modules/detect-file/", {"name":"detect-file","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-resolve-dir-1.0.1-79a40644c362be82f26effe739c9bb5382046f43/node_modules/resolve-dir/", {"name":"resolve-dir","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-expand-tilde-2.0.2-97e801aa052df02454de46b02bf621642cdc8502/node_modules/expand-tilde/", {"name":"expand-tilde","reference":"2.0.2"}],
  ["../../.cache/yarn/v4/npm-homedir-polyfill-1.0.3-743298cef4e5af3e194161fbadcc2151d3a058e8/node_modules/homedir-polyfill/", {"name":"homedir-polyfill","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-parse-passwd-1.0.0-6d5b934a456993b23d37f40a382d6f1666a8e5c6/node_modules/parse-passwd/", {"name":"parse-passwd","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-global-modules-1.0.0-6d770f0eb523ac78164d72b5e71a8877265cc3ea/node_modules/global-modules/", {"name":"global-modules","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-global-prefix-1.0.2-dbf743c6c14992593c655568cb66ed32c0122ebe/node_modules/global-prefix/", {"name":"global-prefix","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-ini-1.3.5-eee25f56db1c9ec6085e0c22778083f596abf927/node_modules/ini/", {"name":"ini","reference":"1.3.5"}],
  ["../../.cache/yarn/v4/npm-fined-1.1.1-95d88ff329123dd1a6950fdfcd321f746271e01f/node_modules/fined/", {"name":"fined","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-parse-filepath-1.0.2-a632127f53aaf3d15876f5872f3ffac763d6c891/node_modules/parse-filepath/", {"name":"parse-filepath","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-is-absolute-1.0.0-395e1ae84b11f26ad1795e73c17378e48a301576/node_modules/is-absolute/", {"name":"is-absolute","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-is-relative-1.0.0-a1bb6935ce8c5dba1e8b9754b9b2dcc020e2260d/node_modules/is-relative/", {"name":"is-relative","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-is-unc-path-1.0.0-d731e8898ed090a12c352ad2eaed5095ad322c9d/node_modules/is-unc-path/", {"name":"is-unc-path","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-unc-path-regex-0.1.2-e73dd3d7b0d7c5ed86fbac6b0ae7d8c6a69d50fa/node_modules/unc-path-regex/", {"name":"unc-path-regex","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-path-root-0.1.1-9a4a6814cac1c0cd73360a95f32083c8ea4745b7/node_modules/path-root/", {"name":"path-root","reference":"0.1.1"}],
  ["../../.cache/yarn/v4/npm-path-root-regex-0.1.2-bfccdc8df5b12dc52c8b43ec38d18d72c04ba96d/node_modules/path-root-regex/", {"name":"path-root-regex","reference":"0.1.2"}],
  ["../../.cache/yarn/v4/npm-flagged-respawn-1.0.1-e7de6f1279ddd9ca9aac8a5971d618606b3aab41/node_modules/flagged-respawn/", {"name":"flagged-respawn","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-object-map-1.0.1-cf83e59dc8fcc0ad5f4250e1f78b3b81bd801d37/node_modules/object.map/", {"name":"object.map","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-make-iterator-1.0.1-29b33f312aa8f547c4a5e490f56afcec99133ad6/node_modules/make-iterator/", {"name":"make-iterator","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-rechoir-0.6.2-85204b54dba82d5742e28c96756ef43af50e3384/node_modules/rechoir/", {"name":"rechoir","reference":"0.6.2"}],
  ["../../.cache/yarn/v4/npm-matchdep-2.0.0-c6f34834a0d8dbc3b37c27ee8bbcb27c7775582e/node_modules/matchdep/", {"name":"matchdep","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-stack-trace-0.0.10-547c70b347e8d32b4e108ea1a2a159e5fdde19c0/node_modules/stack-trace/", {"name":"stack-trace","reference":"0.0.10"}],
  ["../../.cache/yarn/v4/npm-mute-stdout-1.0.1-acb0300eb4de23a7ddeec014e3e96044b3472331/node_modules/mute-stdout/", {"name":"mute-stdout","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-pretty-hrtime-1.0.3-b7e3ea42435a4c9b2759d99e0f201eb195802ee1/node_modules/pretty-hrtime/", {"name":"pretty-hrtime","reference":"1.0.3"}],
  ["../../.cache/yarn/v4/npm-replace-homedir-1.0.0-e87f6d513b928dde808260c12be7fec6ff6e798c/node_modules/replace-homedir/", {"name":"replace-homedir","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-semver-greatest-satisfied-range-1.1.0-13e8c2658ab9691cb0cd71093240280d36f77a5b/node_modules/semver-greatest-satisfied-range/", {"name":"semver-greatest-satisfied-range","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-sver-compat-1.5.0-3cf87dfeb4d07b4a3f14827bc186b3fd0c645cd8/node_modules/sver-compat/", {"name":"sver-compat","reference":"1.5.0"}],
  ["../../.cache/yarn/v4/npm-v8flags-3.1.2-fc5cd0c227428181e6c29b2992e4f8f1da5e0c9f/node_modules/v8flags/", {"name":"v8flags","reference":"3.1.2"}],
  ["../../.cache/yarn/v4/npm-undertaker-1.2.0-339da4646252d082dc378e708067299750e11b49/node_modules/undertaker/", {"name":"undertaker","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-arr-map-2.0.2-3a77345ffc1cf35e2a91825601f9e58f2e24cac4/node_modules/arr-map/", {"name":"arr-map","reference":"2.0.2"}],
  ["../../.cache/yarn/v4/npm-bach-1.2.0-4b3ce96bf27134f79a1b414a51c14e34c3bd9880/node_modules/bach/", {"name":"bach","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-arr-filter-1.1.2-43fdddd091e8ef11aa4c45d9cdc18e2dff1711ee/node_modules/arr-filter/", {"name":"arr-filter","reference":"1.1.2"}],
  ["../../.cache/yarn/v4/npm-array-initial-1.1.0-2fa74b26739371c3947bd7a7adc73be334b3d795/node_modules/array-initial/", {"name":"array-initial","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-array-last-1.3.0-7aa77073fec565ddab2493f5f88185f404a9d336/node_modules/array-last/", {"name":"array-last","reference":"1.3.0"}],
  ["../../.cache/yarn/v4/npm-async-settle-1.0.0-1d0a914bb02575bec8a8f3a74e5080f72b2c0c6b/node_modules/async-settle/", {"name":"async-settle","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-now-and-later-2.0.0-bc61cbb456d79cb32207ce47ca05136ff2e7d6ee/node_modules/now-and-later/", {"name":"now-and-later","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-collection-map-1.0.0-aea0f06f8d26c780c2b75494385544b2255af18c/node_modules/collection-map/", {"name":"collection-map","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-last-run-1.1.1-45b96942c17b1c79c772198259ba943bebf8ca5b/node_modules/last-run/", {"name":"last-run","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-default-resolution-2.0.0-bcb82baa72ad79b426a76732f1a81ad6df26d684/node_modules/default-resolution/", {"name":"default-resolution","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-object-reduce-1.0.1-6fe348f2ac7fa0f95ca621226599096825bb03ad/node_modules/object.reduce/", {"name":"object.reduce","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-undertaker-registry-1.0.1-5e4bda308e4a8a2ae584f9b9a4359a499825cc50/node_modules/undertaker-registry/", {"name":"undertaker-registry","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-vinyl-fs-3.0.3-c85849405f67428feabbbd5c5dbdd64f47d31bc7/node_modules/vinyl-fs/", {"name":"vinyl-fs","reference":"3.0.3"}],
  ["../../.cache/yarn/v4/npm-fs-mkdirp-stream-1.0.0-0b7815fc3201c6a69e14db98ce098c16935259eb/node_modules/fs-mkdirp-stream/", {"name":"fs-mkdirp-stream","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-glob-stream-6.1.0-7045c99413b3eb94888d83ab46d0b404cc7bdde4/node_modules/glob-stream/", {"name":"glob-stream","reference":"6.1.0"}],
  ["../../.cache/yarn/v4/npm-ordered-read-streams-1.0.1-77c0cb37c41525d64166d990ffad7ec6a0e1363e/node_modules/ordered-read-streams/", {"name":"ordered-read-streams","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-pumpify-1.5.1-36513be246ab27570b1a374a5ce278bfd74370ce/node_modules/pumpify/", {"name":"pumpify","reference":"1.5.1"}],
  ["../../.cache/yarn/v4/npm-duplexify-3.7.1-2a4df5317f6ccfd91f86d6fd25d8d8a103b88309/node_modules/duplexify/", {"name":"duplexify","reference":"3.7.1"}],
  ["../../.cache/yarn/v4/npm-stream-shift-1.0.0-d5c752825e5367e786f78e18e445ea223a155952/node_modules/stream-shift/", {"name":"stream-shift","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-pump-2.0.1-12399add6e4cf7526d973cbc8b5ce2e2908b3909/node_modules/pump/", {"name":"pump","reference":"2.0.1"}],
  ["../../.cache/yarn/v4/npm-to-absolute-glob-2.0.2-1865f43d9e74b0822db9f145b78cff7d0f7c849b/node_modules/to-absolute-glob/", {"name":"to-absolute-glob","reference":"2.0.2"}],
  ["../../.cache/yarn/v4/npm-unique-stream-2.3.1-c65d110e9a4adf9a6c5948b28053d9a8d04cbeac/node_modules/unique-stream/", {"name":"unique-stream","reference":"2.3.1"}],
  ["../../.cache/yarn/v4/npm-json-stable-stringify-without-jsonify-1.0.1-9db7b59496ad3f3cfef30a75142d2d930ad72651/node_modules/json-stable-stringify-without-jsonify/", {"name":"json-stable-stringify-without-jsonify","reference":"1.0.1"}],
  ["../../.cache/yarn/v4/npm-through2-filter-3.0.0-700e786df2367c2c88cd8aa5be4cf9c1e7831254/node_modules/through2-filter/", {"name":"through2-filter","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-is-valid-glob-1.0.0-29bf3eff701be2d4d315dbacc39bc39fe8f601aa/node_modules/is-valid-glob/", {"name":"is-valid-glob","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-lazystream-1.0.0-f6995fe0f820392f61396be89462407bb77168e4/node_modules/lazystream/", {"name":"lazystream","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-lead-1.0.0-6f14f99a37be3a9dd784f5495690e5903466ee42/node_modules/lead/", {"name":"lead","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-flush-write-stream-1.1.1-8dd7d873a1babc207d94ead0c2e0e44276ebf2e8/node_modules/flush-write-stream/", {"name":"flush-write-stream","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-object-assign-4.1.0-968bf1100d7956bb3ca086f006f846b3bc4008da/node_modules/object.assign/", {"name":"object.assign","reference":"4.1.0"}],
  ["../../.cache/yarn/v4/npm-define-properties-1.1.3-cf88da6cbee26fe6db7094f61d870cbd84cee9f1/node_modules/define-properties/", {"name":"define-properties","reference":"1.1.3"}],
  ["../../.cache/yarn/v4/npm-object-keys-1.1.0-11bd22348dd2e096a045ab06f6c85bcc340fa032/node_modules/object-keys/", {"name":"object-keys","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-function-bind-1.1.1-a56899d3ea3c9bab874bb9773b7c5ede92f4895d/node_modules/function-bind/", {"name":"function-bind","reference":"1.1.1"}],
  ["../../.cache/yarn/v4/npm-has-symbols-1.0.0-ba1a8f1af2a0fc39650f5c850367704122063b44/node_modules/has-symbols/", {"name":"has-symbols","reference":"1.0.0"}],
  ["../../.cache/yarn/v4/npm-remove-bom-buffer-3.0.0-c2bf1e377520d324f623892e33c10cac2c252b53/node_modules/remove-bom-buffer/", {"name":"remove-bom-buffer","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-remove-bom-stream-1.2.0-05f1a593f16e42e1fb90ebf59de8e569525f9523/node_modules/remove-bom-stream/", {"name":"remove-bom-stream","reference":"1.2.0"}],
  ["../../.cache/yarn/v4/npm-resolve-options-1.1.0-32bb9e39c06d67338dc9378c0d6d6074566ad131/node_modules/resolve-options/", {"name":"resolve-options","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-value-or-function-3.0.0-1c243a50b595c1be54a754bfece8563b9ff8d813/node_modules/value-or-function/", {"name":"value-or-function","reference":"3.0.0"}],
  ["../../.cache/yarn/v4/npm-to-through-2.0.0-fc92adaba072647bc0b67d6b03664aa195093af6/node_modules/to-through/", {"name":"to-through","reference":"2.0.0"}],
  ["../../.cache/yarn/v4/npm-vinyl-sourcemap-1.1.0-92a800593a38703a8cdb11d8b300ad4be63b3e16/node_modules/vinyl-sourcemap/", {"name":"vinyl-sourcemap","reference":"1.1.0"}],
  ["../../.cache/yarn/v4/npm-append-buffer-1.0.2-d8220cf466081525efea50614f3de6514dfa58f1/node_modules/append-buffer/", {"name":"append-buffer","reference":"1.0.2"}],
  ["../../.cache/yarn/v4/npm-buffer-equal-1.0.0-59616b498304d556abd466966b22eeda3eca5fbe/node_modules/buffer-equal/", {"name":"buffer-equal","reference":"1.0.0"}],
  ["./", topLevelLocator],
]);
exports.findPackageLocator = function findPackageLocator(location) {
  let relativeLocation = normalizePath(path.relative(__dirname, location));

  if (!relativeLocation.match(isStrictRegExp))
    relativeLocation = `./${relativeLocation}`;

  if (location.match(isDirRegExp) && relativeLocation.charAt(relativeLocation.length - 1) !== '/')
    relativeLocation = `${relativeLocation}/`;

  let match;

  if (relativeLocation.length >= 161 && relativeLocation[160] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 161)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 149 && relativeLocation[148] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 149)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 145 && relativeLocation[144] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 145)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 143 && relativeLocation[142] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 143)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 139 && relativeLocation[138] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 139)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 137 && relativeLocation[136] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 137)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 135 && relativeLocation[134] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 135)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 133 && relativeLocation[132] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 133)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 131 && relativeLocation[130] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 131)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 129 && relativeLocation[128] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 129)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 127 && relativeLocation[126] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 127)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 126 && relativeLocation[125] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 126)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 125 && relativeLocation[124] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 125)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 124 && relativeLocation[123] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 124)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 123 && relativeLocation[122] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 123)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 122 && relativeLocation[121] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 122)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 121 && relativeLocation[120] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 121)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 119 && relativeLocation[118] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 119)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 118 && relativeLocation[117] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 118)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 117 && relativeLocation[116] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 117)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 115 && relativeLocation[114] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 115)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 114 && relativeLocation[113] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 114)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 113 && relativeLocation[112] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 113)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 112 && relativeLocation[111] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 112)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 111 && relativeLocation[110] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 111)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 110 && relativeLocation[109] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 110)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 109 && relativeLocation[108] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 109)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 108 && relativeLocation[107] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 108)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 107 && relativeLocation[106] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 107)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 106 && relativeLocation[105] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 106)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 105 && relativeLocation[104] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 105)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 104 && relativeLocation[103] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 104)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 103 && relativeLocation[102] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 103)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 102 && relativeLocation[101] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 102)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 101 && relativeLocation[100] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 101)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 100 && relativeLocation[99] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 100)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 99 && relativeLocation[98] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 99)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 98 && relativeLocation[97] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 98)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 97 && relativeLocation[96] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 97)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 96 && relativeLocation[95] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 96)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 95 && relativeLocation[94] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 95)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 94 && relativeLocation[93] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 94)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 93 && relativeLocation[92] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 93)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 91 && relativeLocation[90] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 91)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 89 && relativeLocation[88] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 89)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 2 && relativeLocation[1] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 2)))
      return blacklistCheck(match);

  return null;
};


/**
 * Returns the module that should be used to resolve require calls. It's usually the direct parent, except if we're
 * inside an eval expression.
 */

function getIssuerModule(parent) {
  let issuer = parent;

  while (issuer && (issuer.id === '[eval]' || issuer.id === '<repl>' || !issuer.filename)) {
    issuer = issuer.parent;
  }

  return issuer;
}

/**
 * Returns information about a package in a safe way (will throw if they cannot be retrieved)
 */

function getPackageInformationSafe(packageLocator) {
  const packageInformation = exports.getPackageInformation(packageLocator);

  if (!packageInformation) {
    throw makeError(
      `INTERNAL`,
      `Couldn't find a matching entry in the dependency tree for the specified parent (this is probably an internal error)`,
    );
  }

  return packageInformation;
}

/**
 * Implements the node resolution for folder access and extension selection
 */

function applyNodeExtensionResolution(unqualifiedPath, {extensions}) {
  // We use this "infinite while" so that we can restart the process as long as we hit package folders
  while (true) {
    let stat;

    try {
      stat = statSync(unqualifiedPath);
    } catch (error) {}

    // If the file exists and is a file, we can stop right there

    if (stat && !stat.isDirectory()) {
      // If the very last component of the resolved path is a symlink to a file, we then resolve it to a file. We only
      // do this first the last component, and not the rest of the path! This allows us to support the case of bin
      // symlinks, where a symlink in "/xyz/pkg-name/.bin/bin-name" will point somewhere else (like "/xyz/pkg-name/index.js").
      // In such a case, we want relative requires to be resolved relative to "/xyz/pkg-name/" rather than "/xyz/pkg-name/.bin/".
      //
      // Also note that the reason we must use readlink on the last component (instead of realpath on the whole path)
      // is that we must preserve the other symlinks, in particular those used by pnp to deambiguate packages using
      // peer dependencies. For example, "/xyz/.pnp/local/pnp-01234569/.bin/bin-name" should see its relative requires
      // be resolved relative to "/xyz/.pnp/local/pnp-0123456789/" rather than "/xyz/pkg-with-peers/", because otherwise
      // we would lose the information that would tell us what are the dependencies of pkg-with-peers relative to its
      // ancestors.

      if (lstatSync(unqualifiedPath).isSymbolicLink()) {
        unqualifiedPath = path.normalize(path.resolve(path.dirname(unqualifiedPath), readlinkSync(unqualifiedPath)));
      }

      return unqualifiedPath;
    }

    // If the file is a directory, we must check if it contains a package.json with a "main" entry

    if (stat && stat.isDirectory()) {
      let pkgJson;

      try {
        pkgJson = JSON.parse(readFileSync(`${unqualifiedPath}/package.json`, 'utf-8'));
      } catch (error) {}

      let nextUnqualifiedPath;

      if (pkgJson && pkgJson.main) {
        nextUnqualifiedPath = path.resolve(unqualifiedPath, pkgJson.main);
      }

      // If the "main" field changed the path, we start again from this new location

      if (nextUnqualifiedPath && nextUnqualifiedPath !== unqualifiedPath) {
        const resolution = applyNodeExtensionResolution(nextUnqualifiedPath, {extensions});

        if (resolution !== null) {
          return resolution;
        }
      }
    }

    // Otherwise we check if we find a file that match one of the supported extensions

    const qualifiedPath = extensions
      .map(extension => {
        return `${unqualifiedPath}${extension}`;
      })
      .find(candidateFile => {
        return existsSync(candidateFile);
      });

    if (qualifiedPath) {
      return qualifiedPath;
    }

    // Otherwise, we check if the path is a folder - in such a case, we try to use its index

    if (stat && stat.isDirectory()) {
      const indexPath = extensions
        .map(extension => {
          return `${unqualifiedPath}/index${extension}`;
        })
        .find(candidateFile => {
          return existsSync(candidateFile);
        });

      if (indexPath) {
        return indexPath;
      }
    }

    // Otherwise there's nothing else we can do :(

    return null;
  }
}

/**
 * This function creates fake modules that can be used with the _resolveFilename function.
 * Ideally it would be nice to be able to avoid this, since it causes useless allocations
 * and cannot be cached efficiently (we recompute the nodeModulePaths every time).
 *
 * Fortunately, this should only affect the fallback, and there hopefully shouldn't be a
 * lot of them.
 */

function makeFakeModule(path) {
  const fakeModule = new Module(path, false);
  fakeModule.filename = path;
  fakeModule.paths = Module._nodeModulePaths(path);
  return fakeModule;
}

/**
 * Normalize path to posix format.
 */

function normalizePath(fsPath) {
  fsPath = path.normalize(fsPath);

  if (process.platform === 'win32') {
    fsPath = fsPath.replace(backwardSlashRegExp, '/');
  }

  return fsPath;
}

/**
 * Forward the resolution to the next resolver (usually the native one)
 */

function callNativeResolution(request, issuer) {
  if (issuer.endsWith('/')) {
    issuer += 'internal.js';
  }

  try {
    enableNativeHooks = false;

    // Since we would need to create a fake module anyway (to call _resolveLookupPath that
    // would give us the paths to give to _resolveFilename), we can as well not use
    // the {paths} option at all, since it internally makes _resolveFilename create another
    // fake module anyway.
    return Module._resolveFilename(request, makeFakeModule(issuer), false);
  } finally {
    enableNativeHooks = true;
  }
}

/**
 * This key indicates which version of the standard is implemented by this resolver. The `std` key is the
 * Plug'n'Play standard, and any other key are third-party extensions. Third-party extensions are not allowed
 * to override the standard, and can only offer new methods.
 *
 * If an new version of the Plug'n'Play standard is released and some extensions conflict with newly added
 * functions, they'll just have to fix the conflicts and bump their own version number.
 */

exports.VERSIONS = {std: 1};

/**
 * Useful when used together with getPackageInformation to fetch information about the top-level package.
 */

exports.topLevel = {name: null, reference: null};

/**
 * Gets the package information for a given locator. Returns null if they cannot be retrieved.
 */

exports.getPackageInformation = function getPackageInformation({name, reference}) {
  const packageInformationStore = packageInformationStores.get(name);

  if (!packageInformationStore) {
    return null;
  }

  const packageInformation = packageInformationStore.get(reference);

  if (!packageInformation) {
    return null;
  }

  return packageInformation;
};

/**
 * Transforms a request (what's typically passed as argument to the require function) into an unqualified path.
 * This path is called "unqualified" because it only changes the package name to the package location on the disk,
 * which means that the end result still cannot be directly accessed (for example, it doesn't try to resolve the
 * file extension, or to resolve directories to their "index.js" content). Use the "resolveUnqualified" function
 * to convert them to fully-qualified paths, or just use "resolveRequest" that do both operations in one go.
 *
 * Note that it is extremely important that the `issuer` path ends with a forward slash if the issuer is to be
 * treated as a folder (ie. "/tmp/foo/" rather than "/tmp/foo" if "foo" is a directory). Otherwise relative
 * imports won't be computed correctly (they'll get resolved relative to "/tmp/" instead of "/tmp/foo/").
 */

exports.resolveToUnqualified = function resolveToUnqualified(request, issuer, {considerBuiltins = true} = {}) {
  // The 'pnpapi' request is reserved and will always return the path to the PnP file, from everywhere

  if (request === `pnpapi`) {
    return pnpFile;
  }

  // Bailout if the request is a native module

  if (considerBuiltins && builtinModules.has(request)) {
    return null;
  }

  // We allow disabling the pnp resolution for some subpaths. This is because some projects, often legacy,
  // contain multiple levels of dependencies (ie. a yarn.lock inside a subfolder of a yarn.lock). This is
  // typically solved using workspaces, but not all of them have been converted already.

  if (ignorePattern && ignorePattern.test(normalizePath(issuer))) {
    const result = callNativeResolution(request, issuer);

    if (result === false) {
      throw makeError(
        `BUILTIN_NODE_RESOLUTION_FAIL`,
        `The builtin node resolution algorithm was unable to resolve the module referenced by "${request}" and requested from "${issuer}" (it didn't go through the pnp resolver because the issuer was explicitely ignored by the regexp "null")`,
        {
          request,
          issuer,
        },
      );
    }

    return result;
  }

  let unqualifiedPath;

  // If the request is a relative or absolute path, we just return it normalized

  const dependencyNameMatch = request.match(pathRegExp);

  if (!dependencyNameMatch) {
    if (path.isAbsolute(request)) {
      unqualifiedPath = path.normalize(request);
    } else if (issuer.match(isDirRegExp)) {
      unqualifiedPath = path.normalize(path.resolve(issuer, request));
    } else {
      unqualifiedPath = path.normalize(path.resolve(path.dirname(issuer), request));
    }
  }

  // Things are more hairy if it's a package require - we then need to figure out which package is needed, and in
  // particular the exact version for the given location on the dependency tree

  if (dependencyNameMatch) {
    const [, dependencyName, subPath] = dependencyNameMatch;

    const issuerLocator = exports.findPackageLocator(issuer);

    // If the issuer file doesn't seem to be owned by a package managed through pnp, then we resort to using the next
    // resolution algorithm in the chain, usually the native Node resolution one

    if (!issuerLocator) {
      const result = callNativeResolution(request, issuer);

      if (result === false) {
        throw makeError(
          `BUILTIN_NODE_RESOLUTION_FAIL`,
          `The builtin node resolution algorithm was unable to resolve the module referenced by "${request}" and requested from "${issuer}" (it didn't go through the pnp resolver because the issuer doesn't seem to be part of the Yarn-managed dependency tree)`,
          {
            request,
            issuer,
          },
        );
      }

      return result;
    }

    const issuerInformation = getPackageInformationSafe(issuerLocator);

    // We obtain the dependency reference in regard to the package that request it

    let dependencyReference = issuerInformation.packageDependencies.get(dependencyName);

    // If we can't find it, we check if we can potentially load it from the packages that have been defined as potential fallbacks.
    // It's a bit of a hack, but it improves compatibility with the existing Node ecosystem. Hopefully we should eventually be able
    // to kill this logic and become stricter once pnp gets enough traction and the affected packages fix themselves.

    if (issuerLocator !== topLevelLocator) {
      for (let t = 0, T = fallbackLocators.length; dependencyReference === undefined && t < T; ++t) {
        const fallbackInformation = getPackageInformationSafe(fallbackLocators[t]);
        dependencyReference = fallbackInformation.packageDependencies.get(dependencyName);
      }
    }

    // If we can't find the path, and if the package making the request is the top-level, we can offer nicer error messages

    if (!dependencyReference) {
      if (dependencyReference === null) {
        if (issuerLocator === topLevelLocator) {
          throw makeError(
            `MISSING_PEER_DEPENDENCY`,
            `You seem to be requiring a peer dependency ("${dependencyName}"), but it is not installed (which might be because you're the top-level package)`,
            {request, issuer, dependencyName},
          );
        } else {
          throw makeError(
            `MISSING_PEER_DEPENDENCY`,
            `Package "${issuerLocator.name}@${issuerLocator.reference}" is trying to access a peer dependency ("${dependencyName}") that should be provided by its direct ancestor but isn't`,
            {request, issuer, issuerLocator: Object.assign({}, issuerLocator), dependencyName},
          );
        }
      } else {
        if (issuerLocator === topLevelLocator) {
          throw makeError(
            `UNDECLARED_DEPENDENCY`,
            `You cannot require a package ("${dependencyName}") that is not declared in your dependencies (via "${issuer}")`,
            {request, issuer, dependencyName},
          );
        } else {
          const candidates = Array.from(issuerInformation.packageDependencies.keys());
          throw makeError(
            `UNDECLARED_DEPENDENCY`,
            `Package "${issuerLocator.name}@${issuerLocator.reference}" (via "${issuer}") is trying to require the package "${dependencyName}" (via "${request}") without it being listed in its dependencies (${candidates.join(
              `, `,
            )})`,
            {request, issuer, issuerLocator: Object.assign({}, issuerLocator), dependencyName, candidates},
          );
        }
      }
    }

    // We need to check that the package exists on the filesystem, because it might not have been installed

    const dependencyLocator = {name: dependencyName, reference: dependencyReference};
    const dependencyInformation = exports.getPackageInformation(dependencyLocator);
    const dependencyLocation = path.resolve(__dirname, dependencyInformation.packageLocation);

    if (!dependencyLocation) {
      throw makeError(
        `MISSING_DEPENDENCY`,
        `Package "${dependencyLocator.name}@${dependencyLocator.reference}" is a valid dependency, but hasn't been installed and thus cannot be required (it might be caused if you install a partial tree, such as on production environments)`,
        {request, issuer, dependencyLocator: Object.assign({}, dependencyLocator)},
      );
    }

    // Now that we know which package we should resolve to, we only have to find out the file location

    if (subPath) {
      unqualifiedPath = path.resolve(dependencyLocation, subPath);
    } else {
      unqualifiedPath = dependencyLocation;
    }
  }

  return path.normalize(unqualifiedPath);
};

/**
 * Transforms an unqualified path into a qualified path by using the Node resolution algorithm (which automatically
 * appends ".js" / ".json", and transforms directory accesses into "index.js").
 */

exports.resolveUnqualified = function resolveUnqualified(
  unqualifiedPath,
  {extensions = Object.keys(Module._extensions)} = {},
) {
  const qualifiedPath = applyNodeExtensionResolution(unqualifiedPath, {extensions});

  if (qualifiedPath) {
    return path.normalize(qualifiedPath);
  } else {
    throw makeError(
      `QUALIFIED_PATH_RESOLUTION_FAILED`,
      `Couldn't find a suitable Node resolution for unqualified path "${unqualifiedPath}"`,
      {unqualifiedPath},
    );
  }
};

/**
 * Transforms a request into a fully qualified path.
 *
 * Note that it is extremely important that the `issuer` path ends with a forward slash if the issuer is to be
 * treated as a folder (ie. "/tmp/foo/" rather than "/tmp/foo" if "foo" is a directory). Otherwise relative
 * imports won't be computed correctly (they'll get resolved relative to "/tmp/" instead of "/tmp/foo/").
 */

exports.resolveRequest = function resolveRequest(request, issuer, {considerBuiltins, extensions} = {}) {
  let unqualifiedPath;

  try {
    unqualifiedPath = exports.resolveToUnqualified(request, issuer, {considerBuiltins});
  } catch (originalError) {
    // If we get a BUILTIN_NODE_RESOLUTION_FAIL error there, it means that we've had to use the builtin node
    // resolution, which usually shouldn't happen. It might be because the user is trying to require something
    // from a path loaded through a symlink (which is not possible, because we need something normalized to
    // figure out which package is making the require call), so we try to make the same request using a fully
    // resolved issuer and throws a better and more actionable error if it works.
    if (originalError.code === `BUILTIN_NODE_RESOLUTION_FAIL`) {
      let realIssuer;

      try {
        realIssuer = realpathSync(issuer);
      } catch (error) {}

      if (realIssuer) {
        if (issuer.endsWith(`/`)) {
          realIssuer = realIssuer.replace(/\/?$/, `/`);
        }

        try {
          exports.resolveToUnqualified(request, realIssuer, {considerBuiltins});
        } catch (error) {
          // If an error was thrown, the problem doesn't seem to come from a path not being normalized, so we
          // can just throw the original error which was legit.
          throw originalError;
        }

        // If we reach this stage, it means that resolveToUnqualified didn't fail when using the fully resolved
        // file path, which is very likely caused by a module being invoked through Node with a path not being
        // correctly normalized (ie you should use "node $(realpath script.js)" instead of "node script.js").
        throw makeError(
          `SYMLINKED_PATH_DETECTED`,
          `A pnp module ("${request}") has been required from what seems to be a symlinked path ("${issuer}"). This is not possible, you must ensure that your modules are invoked through their fully resolved path on the filesystem (in this case "${realIssuer}").`,
          {
            request,
            issuer,
            realIssuer,
          },
        );
      }
    }
    throw originalError;
  }

  if (unqualifiedPath === null) {
    return null;
  }

  try {
    return exports.resolveUnqualified(unqualifiedPath, {extensions});
  } catch (resolutionError) {
    if (resolutionError.code === 'QUALIFIED_PATH_RESOLUTION_FAILED') {
      Object.assign(resolutionError.data, {request, issuer});
    }
    throw resolutionError;
  }
};

/**
 * Setups the hook into the Node environment.
 *
 * From this point on, any call to `require()` will go through the "resolveRequest" function, and the result will
 * be used as path of the file to load.
 */

exports.setup = function setup() {
  // A small note: we don't replace the cache here (and instead use the native one). This is an effort to not
  // break code similar to "delete require.cache[require.resolve(FOO)]", where FOO is a package located outside
  // of the Yarn dependency tree. In this case, we defer the load to the native loader. If we were to replace the
  // cache by our own, the native loader would populate its own cache, which wouldn't be exposed anymore, so the
  // delete call would be broken.

  const originalModuleLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    if (!enableNativeHooks) {
      return originalModuleLoad.call(Module, request, parent, isMain);
    }

    // Builtins are managed by the regular Node loader

    if (builtinModules.has(request)) {
      try {
        enableNativeHooks = false;
        return originalModuleLoad.call(Module, request, parent, isMain);
      } finally {
        enableNativeHooks = true;
      }
    }

    // The 'pnpapi' name is reserved to return the PnP api currently in use by the program

    if (request === `pnpapi`) {
      return pnpModule.exports;
    }

    // Request `Module._resolveFilename` (ie. `resolveRequest`) to tell us which file we should load

    const modulePath = Module._resolveFilename(request, parent, isMain);

    // Check if the module has already been created for the given file

    const cacheEntry = Module._cache[modulePath];

    if (cacheEntry) {
      return cacheEntry.exports;
    }

    // Create a new module and store it into the cache

    const module = new Module(modulePath, parent);
    Module._cache[modulePath] = module;

    // The main module is exposed as global variable

    if (isMain) {
      process.mainModule = module;
      module.id = '.';
    }

    // Try to load the module, and remove it from the cache if it fails

    let hasThrown = true;

    try {
      module.load(modulePath);
      hasThrown = false;
    } finally {
      if (hasThrown) {
        delete Module._cache[modulePath];
      }
    }

    // Some modules might have to be patched for compatibility purposes

    for (const [filter, patchFn] of patchedModules) {
      if (filter.test(request)) {
        module.exports = patchFn(exports.findPackageLocator(parent.filename), module.exports);
      }
    }

    return module.exports;
  };

  const originalModuleResolveFilename = Module._resolveFilename;

  Module._resolveFilename = function(request, parent, isMain, options) {
    if (!enableNativeHooks) {
      return originalModuleResolveFilename.call(Module, request, parent, isMain, options);
    }

    let issuers;

    if (options) {
      const optionNames = new Set(Object.keys(options));
      optionNames.delete('paths');

      if (optionNames.size > 0) {
        throw makeError(
          `UNSUPPORTED`,
          `Some options passed to require() aren't supported by PnP yet (${Array.from(optionNames).join(', ')})`,
        );
      }

      if (options.paths) {
        issuers = options.paths.map(entry => `${path.normalize(entry)}/`);
      }
    }

    if (!issuers) {
      const issuerModule = getIssuerModule(parent);
      const issuer = issuerModule ? issuerModule.filename : `${process.cwd()}/`;

      issuers = [issuer];
    }

    let firstError;

    for (const issuer of issuers) {
      let resolution;

      try {
        resolution = exports.resolveRequest(request, issuer);
      } catch (error) {
        firstError = firstError || error;
        continue;
      }

      return resolution !== null ? resolution : request;
    }

    throw firstError;
  };

  const originalFindPath = Module._findPath;

  Module._findPath = function(request, paths, isMain) {
    if (!enableNativeHooks) {
      return originalFindPath.call(Module, request, paths, isMain);
    }

    for (const path of paths) {
      let resolution;

      try {
        resolution = exports.resolveRequest(request, path);
      } catch (error) {
        continue;
      }

      if (resolution) {
        return resolution;
      }
    }

    return false;
  };

  process.versions.pnp = String(exports.VERSIONS.std);
};

exports.setupCompatibilityLayer = () => {
  // ESLint currently doesn't have any portable way for shared configs to specify their own
  // plugins that should be used (https://github.com/eslint/eslint/issues/10125). This will
  // likely get fixed at some point, but it'll take time and in the meantime we'll just add
  // additional fallback entries for common shared configs.

  for (const name of [`react-scripts`]) {
    const packageInformationStore = packageInformationStores.get(name);
    if (packageInformationStore) {
      for (const reference of packageInformationStore.keys()) {
        fallbackLocators.push({name, reference});
      }
    }
  }

  // Modern versions of `resolve` support a specific entry point that custom resolvers can use
  // to inject a specific resolution logic without having to patch the whole package.
  //
  // Cf: https://github.com/browserify/resolve/pull/174

  patchedModules.push([
    /^\.\/normalize-options\.js$/,
    (issuer, normalizeOptions) => {
      if (!issuer || issuer.name !== 'resolve') {
        return normalizeOptions;
      }

      return (request, opts) => {
        opts = opts || {};

        if (opts.forceNodeResolution) {
          return opts;
        }

        opts.preserveSymlinks = true;
        opts.paths = function(request, basedir, getNodeModulesDir, opts) {
          // Extract the name of the package being requested (1=full name, 2=scope name, 3=local name)
          const parts = request.match(/^((?:(@[^\/]+)\/)?([^\/]+))/);

          // This is guaranteed to return the path to the "package.json" file from the given package
          const manifestPath = exports.resolveToUnqualified(`${parts[1]}/package.json`, basedir);

          // The first dirname strips the package.json, the second strips the local named folder
          let nodeModules = path.dirname(path.dirname(manifestPath));

          // Strips the scope named folder if needed
          if (parts[2]) {
            nodeModules = path.dirname(nodeModules);
          }

          return [nodeModules];
        };

        return opts;
      };
    },
  ]);
};

if (module.parent && module.parent.id === 'internal/preload') {
  exports.setupCompatibilityLayer();

  exports.setup();
}

if (process.mainModule === module) {
  exports.setupCompatibilityLayer();

  const reportError = (code, message, data) => {
    process.stdout.write(`${JSON.stringify([{code, message, data}, null])}\n`);
  };

  const reportSuccess = resolution => {
    process.stdout.write(`${JSON.stringify([null, resolution])}\n`);
  };

  const processResolution = (request, issuer) => {
    try {
      reportSuccess(exports.resolveRequest(request, issuer));
    } catch (error) {
      reportError(error.code, error.message, error.data);
    }
  };

  const processRequest = data => {
    try {
      const [request, issuer] = JSON.parse(data);
      processResolution(request, issuer);
    } catch (error) {
      reportError(`INVALID_JSON`, error.message, error.data);
    }
  };

  if (process.argv.length > 2) {
    if (process.argv.length !== 4) {
      process.stderr.write(`Usage: ${process.argv[0]} ${process.argv[1]} <request> <issuer>\n`);
      process.exitCode = 64; /* EX_USAGE */
    } else {
      processResolution(process.argv[2], process.argv[3]);
    }
  } else {
    let buffer = '';
    const decoder = new StringDecoder.StringDecoder();

    process.stdin.on('data', chunk => {
      buffer += decoder.write(chunk);

      do {
        const index = buffer.indexOf('\n');
        if (index === -1) {
          break;
        }

        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);

        processRequest(line);
      } while (true);
    });
  }
}
