import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/drizzle.ts", "src/postgres-js.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node22",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // drizzle-orm is an optional peer: importing pgrls must not pull it in.
  external: ["drizzle-orm", "postgres", "pg"],
});
