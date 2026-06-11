'use strict';

/**
 * Add or bump a package constraint in a parsed composer.json object.
 * Returns a new object (input is not mutated).
 * @param {object} composer parsed composer.json
 * @param {string} pkg
 * @param {string} constraint
 * @returns {{composer:object, changed:boolean}}
 */
function upsertRequire(composer, pkg, constraint) {
  const next = JSON.parse(JSON.stringify(composer || {}));
  next.require = next.require || {};
  const changed = next.require[pkg] !== constraint;
  next.require[pkg] = constraint;
  return { composer: next, changed };
}

module.exports = { upsertRequire };
