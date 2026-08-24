// eslint.config.js — AirPrompt lint config (ESLint flat config).
'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'public/vendor/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // public/ is non-modular browser code that shares globals across files
      // (escHtml, sessions, selectSession, …) — no-undef/no-unused-vars are noise
      // until that code is modularized.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // no-useless-assignment (new in ESLint 10) is noisy on deliberate
      // reassignment patterns; no-empty permits the intentional empty catch
      // blocks used throughout. Revisit both when tightening.
      'no-useless-assignment': 'off',
      'no-empty': 'off',
    },
  },
];
