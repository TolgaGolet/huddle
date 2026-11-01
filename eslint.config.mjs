import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "uploads/**", "server/uploads/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    // Set directly: the plugin's presets also enable the React Compiler rules.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["client/src/**/*.tsx"],
    ...jsxA11y.flatConfigs.recommended,
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Off in the preset, but it's what catches placeholder-only inputs.
      "jsx-a11y/control-has-associated-label": ["error", { depth: 5 }],
      // Every autoFocus here is on an input that appears because the user just
      // asked for it (picker, poll, form step), which is the accepted use.
      "jsx-a11y/no-autofocus": "off",
    },
  },
);
