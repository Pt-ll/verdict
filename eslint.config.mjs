import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const TS_FILES = ['src/**/*.ts', 'test/**/*.ts'];

export default [
  { ignores: ['dist/**', 'node_modules/**', 'testdata/**', '.verdict-out/**'] },

  // 仓库里的脚本（esbuild.js、test/runTest.js）是 CommonJS，单独一套 globals。
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },

  // TypeScript 用 tseslint 的推荐集；js.configs.recommended 里的 no-undef
  // 对 TS 是误报源，所以这里不叠加它。
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: TS_FILES })),
  {
    files: TS_FILES,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'all' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
