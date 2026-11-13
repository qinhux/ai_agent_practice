import { tool } from "ai";
import { z } from "zod";

export const getCurrentTime = tool({
  description: "Look up the current time in an IANA time zone such as Asia/Shanghai.",
  inputSchema: z.object({
    timeZone: z.string().min(1).max(100).describe("IANA time zone"),
  }),
  execute: async ({ timeZone }) => {
    try {
      const now = new Date();
      const localTime = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now);

      return { timeZone, localTime, utcTime: now.toISOString() };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { error: "Invalid IANA time zone.", timeZone };
    }
  },
});
