import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

const getCurrentTimeTool = defineTool({
  name: "get_current_time",
  description: "Get the current system date and time, including ISO string and local time.",
  parameters: Type.Object({}),
  async execute() {
    const now = new Date();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            iso: now.toISOString(),
            local: now.toLocaleString(),
            timestamp: now.getTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }, null, 2),
        },
      ],
    };
  },
});

export const DatetimeTools = defineExtension({
  name: "datetime",
  tools: [getCurrentTimeTool],
});
