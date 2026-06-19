/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        target: 'ES2022',
        esModuleInterop: true,
      },
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^(\\.\\.?/.+)\\.js$': '$1',
  },
};