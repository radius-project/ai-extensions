import eslint from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import globals from "globals";

const sourceFiles = ["radius-core/**/*.ts", "adapters/**/*.{ts,mjs}"];
const restrictedCoreImports = [
  {
    selector:
      "ImportExpression[source.value=/^(?:@github\\/copilot-sdk|@radius-project\\/(?:canvas|shared))(?:\\/|$)/]",
    message: "Core must not dynamically import adapters or the Copilot SDK."
  },
  {
    selector:
      "ImportExpression[source.value=/^(?:(?:node:)?https?|undici|node-fetch)$/]",
    message: "Core must not dynamically import HTTP implementations."
  },
  {
    selector: "ImportExpression[source.value=/adapters/]",
    message: "Core must not dynamically import adapter implementations."
  }
];

export default [
  {
    ignores: ["plugins/radius/extension.mjs"]
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
    files: ["adapters/**/*.mjs"],
    rules: {
      "no-inner-declarations": "off",
      "no-unused-vars": "off"
    }
  },
  {
    files: ["radius-core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@github/copilot-sdk",
            "@github/copilot-sdk/extension",
            "@radius-project/canvas",
            "@radius-project/shared",
            "http",
            "https",
            "node:http",
            "node:https",
            "undici",
            "node-fetch"
          ],
          patterns: [
            {
              group: ["adapters", "adapters/**", "**/adapters", "**/adapters/**"],
              message: "Core must not depend on adapter implementations."
            },
            {
              group: ["@github/copilot-sdk/**"],
              message: "Core must not depend on the Copilot SDK."
            },
            {
              group: ["@radius-project/canvas/**", "@radius-project/shared/**"],
              message: "Core must not depend on adapter packages."
            }
          ]
        }
      ],
      "no-restricted-syntax": ["error", ...restrictedCoreImports]
    }
  },
  {
    files: ["radius-core/src/**/*.ts"],
    ignores: [
      "radius-core/src/**/*_test.ts",
      "radius-core/src/**/*.live_test.ts"
    ],
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
          message: "Core must not access HTTP or DOM implementations through the global object."
        },
        {
          selector:
            "MemberExpression[object.name=/^(?:global|globalThis)$/][computed=true][property.value=/^(?:fetch|XMLHttpRequest|document|window)$/]",
          message: "Core must not access HTTP or DOM implementations through the global object."
        }
      ]
    }
  }
];
