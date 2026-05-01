import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";

export const SessionMaintenanceSchema = z
  .object({
    mode: z.enum(["enforce", "warn"]).optional(),
    pruneAfter: z.union([z.string(), z.number()]).optional(),
    /** @deprecated Use pruneAfter instead. */
    pruneDays: z.number().int().positive().optional(),
    maxEntries: z.number().int().positive().optional(),
    rotateBytes: z.union([z.string(), z.number()]).optional(),
    resetArchiveRetention: z.union([z.string(), z.number(), z.literal(false)]).optional(),
    artifactArchiveRetention: z.union([z.string(), z.number(), z.literal(false)]).optional(),
    maxDiskBytes: z.union([z.string(), z.number()]).optional(),
    highWaterBytes: z.union([z.string(), z.number()]).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.pruneAfter !== undefined) {
      try {
        parseDurationMs(normalizeStringifiedOptionalString(val.pruneAfter) ?? "", {
          defaultUnit: "d",
        });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pruneAfter"],
          message: "invalid duration (use ms, s, m, h, d)",
        });
      }
    }
    if (val.resetArchiveRetention !== undefined && val.resetArchiveRetention !== false) {
      try {
        parseDurationMs(normalizeStringifiedOptionalString(val.resetArchiveRetention) ?? "", {
          defaultUnit: "d",
        });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resetArchiveRetention"],
          message: "invalid duration (use ms, s, m, h, d)",
        });
      }
    }
    if (val.artifactArchiveRetention !== undefined && val.artifactArchiveRetention !== false) {
      try {
        parseDurationMs(normalizeStringifiedOptionalString(val.artifactArchiveRetention) ?? "", {
          defaultUnit: "d",
        });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifactArchiveRetention"],
          message: "invalid duration (use ms, s, m, h, d)",
        });
      }
    }
    if (val.maxDiskBytes !== undefined) {
      try {
        parseByteSize(normalizeStringifiedOptionalString(val.maxDiskBytes) ?? "", {
          defaultUnit: "b",
        });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxDiskBytes"],
          message: "invalid size (use b, kb, mb, gb, tb)",
        });
      }
    }
    if (val.highWaterBytes !== undefined) {
      try {
        parseByteSize(normalizeStringifiedOptionalString(val.highWaterBytes) ?? "", {
          defaultUnit: "b",
        });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["highWaterBytes"],
          message: "invalid size (use b, kb, mb, gb, tb)",
        });
      }
    }
  });
