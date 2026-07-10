import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  { ignores: ['src/connectors/jira/scripts/**'] }, // Node build tooling, not plugin source
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' }
    }
  },
  {
    files: ['src/views/table/**/*.ts'],
    rules: {
      'obsidianmd/no-static-styles-assignment': 'off'
    }
  }
])
