import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    ctx.scopes.provide("tools", {
      list: () => [
        {
          name: "echo",
          description: "Echoes its input",
          inputSchema: { type: "object" },
          invoke: async (input) => ({ content: [{ type: "text", text: `echo:${JSON.stringify(input)}` }] }),
        },
      ],
    });
  },
});
