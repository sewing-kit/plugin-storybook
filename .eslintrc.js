module.exports = {
  extends: [
    'plugin:@sewing-kit/typescript',
    'plugin:@sewing-kit/node',
    'plugin:@sewing-kit/prettier',
  ],
  ignorePatterns: [
    '/build/',
    '/node_modules/',
    '/*.js',
    '/*.d.ts',
    '!.eslintrc.js',
  ],
  overrides: [
    {
      files: ['sewing-kit.config.ts'],
      rules: {
        'import/no-extraneous-dependencies': 'off',
      },
    },
  ],
};
