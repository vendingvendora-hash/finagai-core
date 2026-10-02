/** J3 tools: on-demand operating review and the latest review. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type pg from "pg";
import { BudgetBlockedError } from "../llm/types.js";
import { runReview, type J3Deps } from "../pipelines/j3/review.js";
import type { ToolHelpers } from "./server.js";

export function registerJ3Tools(pool: pg.Pool, j3: J3Deps) {
  return (server: McpServer, { ok, fail }: ToolHelpers) => {
    server.registerTool("operating_review", {
      description: "Run Julian's operating review now (J3). Returns the rendered review and its ID. Facts come from Finagai's records; Claude only prioritizes.",
      inputSchema: z.object({}),
    }, async () => {
      try {
        const r = await runReview(j3, { kind: "on_demand" });
        return ok("operating_review", { review_id: r.reviewId, degraded: r.degraded, review: r.rendered });
      } catch (err) {
        if (err instanceof BudgetBlockedError) return fail("operating_review", `Not run: ${err.message}. The weekly review still runs on schedule.`);
        return fail("operating_review", "The review could not be generated.");
      }
    });
    server.registerTool("get_latest_review", {
      description: "The most recent operating review (weekly, on-demand, or baseline).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    }, async () => {
      const r = (await pool.query(`SELECT id, kind, created_at, degraded, delivered_at, rendered FROM review
                                    WHERE kind <> 'shadow' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      return r ? ok("get_latest_review", r) : fail("get_latest_review", "No review has been generated yet.");
    });
  };
}
