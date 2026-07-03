// Flat-config ESLint for video-studio. Adapted from kerf, trimmed to what this
// toolkit needs: typed linting for the TypeScript analyzer in src/, plus a
// lighter Node-ESM pass for the .mjs launcher (bin/) and tools (tools/).
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";

const tsRules = {
  ...tsPlugin.configs.recommended.rules,
  // TypeScript's own checker resolves identifiers (and the analyzer references
  // ambient Node types like `NodeJS.ErrnoException`), so the JS-only no-undef
  // rule is both redundant and wrong here.
  "no-undef": "off",
  "simple-import-sort/exports": "error",
  "@typescript-eslint/consistent-type-imports": "error",
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "@typescript-eslint/no-explicit-any": "warn",
  "no-console": "off", // the analyzer is a CLI — console is its UI
};

export default [
  js.configs.recommended,

  // TypeScript source (the scene analyzer) — type-aware lint via tsconfig.
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
      globals: { ...globals.node },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: tsRules,
  },

  // TypeScript tests — same TS rules but no `project` (tests live outside the
  // build tsconfig); type-aware rules aren't needed to catch test bugs.
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.node },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...tsRules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Node ESM scripts: the launcher, the caption tools, the shipped worked-example
  // scripts, and any .mjs tests.
  {
    files: ["bin/**/*.mjs", "tools/**/*.mjs", "promo-assets/**/*.mjs", "tests/**/*.mjs", "desktop/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },

  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "analysis-data/**",
      "frames/**",
      // The worked-example .mjs sources ARE linted (see the Node-ESM block); only
      // the example's own installed deps are skipped.
      "promo-assets/node_modules/**",
    ],
  },
];
