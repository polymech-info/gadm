import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        root: '.',
        include: ['src/**/*.test.ts'],
        testTimeout: 30_000,
    },
});
