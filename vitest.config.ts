import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/**/generated/**", "src/**/*.generated.*"],
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
    },
  },
});
