import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The integration tests share one Postgres database and create their own
    // schemas; running files in parallel would have them dropping each other's.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
