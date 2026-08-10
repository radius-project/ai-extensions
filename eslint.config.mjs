import eslint from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import globals from "globals";

const sourceFiles = [
  "eslint.config.mjs",
  "packages/**/*.{ts,mjs}",
  "vitest.config.ts"
];
const restrictedCoreImports = [
  {
    selector:
      "ImportExpression[source.value=/^(?:@github\\/copilot-sdk|@radius-project\\/adapter-(?:canvas|shared))(?:\\/|$)/]",
    message: "Core must not dynamically import adapters or the Copilot SDK."
  },
  {
    selector:
      "ImportExpression[source.value=/^(?:(?:node:)?https?|undici|node-fetch)$/]",
    message: "Core must not dynamically import HTTP implementations."
  },
  {
    selector:
      "ImportExpression[source.value=/(?:^|\\/)adapter-(?:canvas|shared)(?:\\/|$)/]",
    message: "Core must not dynamically import adapter implementations."
  }
];

export default [
  {
    ignores: ["plugins/radius/dist/**"]
  },
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-regex-spaces": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          varsIgnorePattern: "^_"
        }
      ],
      "no-useless-escape": "off"
    }
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: ["@babel/plugin-syntax-typescript"]
        }
      }
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off"
    }
  },
  {
    files: ["packages/**/*.mjs"],
    rules: {
      "no-inner-declarations": "off"
    }
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@github/copilot-sdk",
            "@github/copilot-sdk/extension",
            "@radius-project/adapter-canvas",
            "@radius-project/adapter-shared",
            "http",
            "https",
            "node:http",
            "node:https",
            "undici",
            "node-fetch"
          ],
          patterns: [
            {
              group: [
                "packages/adapter-*",
                "packages/adapter-*/**",
                "**/packages/adapter-*",
                "**/packages/adapter-*/**",
                "adapter-*",
                "adapter-*/**",
                "**/adapter-*",
                "**/adapter-*/**"
              ],
              message: "Core must not depend on adapter implementations."
            },
            {
              group: ["@github/copilot-sdk/**"],
              message: "Core must not depend on the Copilot SDK."
            },
            {
              group: [
                "@radius-project/adapter-canvas/**",
                "@radius-project/adapter-shared/**"
              ],
              message: "Core must not depend on adapter packages."
            }
          ]
        }
      ],
      "no-restricted-syntax": ["error", ...restrictedCoreImports]
    }
  },
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Core must use a port rather than an HTTP implementation."
        },
        {
          name: "XMLHttpRequest",
          message: "Core must not depend on HTTP or DOM implementations."
        },
        {
          name: "document",
          message: "Core must not depend on DOM globals."
        },
        {
          name: "window",
          message: "Core must not depend on DOM globals."
        }
      ],
      "no-restricted-syntax": [
        "error",
        ...restrictedCoreImports,
        {
          selector:
            "MemberExpression[object.name=/^(?:global|globalThis)$/][property.name=/^(?:fetch|XMLHttpRequest|document|window)$/]",
          message:
            "Core must not access HTTP or DOM implementations through the global object."
        },
        {
          selector:
            "MemberExpression[object.name=/^(?:global|globalThis)$/][computed=true][property.value=/^(?:fetch|XMLHttpRequest|document|window)$/]",
          message:
            "Core must not access HTTP or DOM implementations through the global object."
        }
      ]
    }
  }
];
