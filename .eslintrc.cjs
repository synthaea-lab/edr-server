// Lint gate for the server (run in CI as `npm run lint`, with `npm run typecheck`).
//
// Errors are the rules the code already meets: a new violation fails the build.
// Warnings are size and branching limits the code does not meet yet; `--max-warnings` in
// package.json holds their count at today's baseline so it can only go down.
module.exports = {
  root: true,
  extends: ["next/core-web-vitals"],
  parser: "@typescript-eslint/parser",
  // Type information is what lets `no-floating-promises` see a promise.
  parserOptions: { project: "./tsconfig.json", tsconfigRootDir: __dirname },
  plugins: ["@typescript-eslint"],
  ignorePatterns: ["node_modules/", ".next/", "next-env.d.ts"],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    // An object literal cast to a type skips the excess and missing property checks that an
    // annotation (`const x: T = { ... }`) would make.
    "@typescript-eslint/consistent-type-assertions": [
      "error",
      { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
    ],
    "@typescript-eslint/no-floating-promises": "error",
    "max-lines-per-function": ["warn", { max: 60, skipBlankLines: true, skipComments: true }],
    complexity: ["warn", 10],
  },
  overrides: [
    {
      // The JavaScript files (Next, PostCSS and start-up config) are outside tsconfig.json, so
      // they get the syntax rules only.
      files: ["*.js", "*.cjs", "*.mjs"],
      parserOptions: { project: null },
      rules: { "@typescript-eslint/no-floating-promises": "off" },
    },
    {
      files: ["tests/**/*.ts", "tests/**/*.tsx"],
      rules: {
        // A test double stands in for a slice of a large client type (`{ ... } as never`), and
        // a test feeds deliberately ill-typed input to check it is refused.
        "@typescript-eslint/consistent-type-assertions": [
          "error",
          { assertionStyle: "as", objectLiteralTypeAssertions: "allow" },
        ],
        // A `describe` callback holds its cases, so its length is the suite's, not a function's.
        "max-lines-per-function": "off",
      },
    },
  ],
};
