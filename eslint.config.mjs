// Reglas de calidad del proyecto. El formato lo decide Prettier (ver .prettierrc),
// por eso al final se apagan las reglas de estilo que chocarían con él.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Cliente generado por prisma generate.
      'src/generated/**',
      // Módulos de los otros equipos: vienen de la plantilla y no se tocan aquí.
      'src/modules/alojamientos/**',
      'src/modules/atracciones/**',
      'src/modules/autos/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // El código de ejemplo de la plantilla usa `any`; se avisa sin bloquear
      // hasta reemplazarlo por tipos reales en las fases de cada módulo.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
);
