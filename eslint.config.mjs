import js from '@eslint/js'
import vuePlugin from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/reports/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vuePlugin.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
      },
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  eslintConfigPrettier,
)
