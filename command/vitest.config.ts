import { defineConfig } from "vitest/config";

// Unit tests for the Command Center's pure model and stream code (the BFF and the full UI are tested against a real
// Core in the root repo's integration suite: test/integration/command-center-*.test.ts).
export default defineConfig({ test: { include: ["test/unit/**/*.test.ts"], environment: "node" } });
