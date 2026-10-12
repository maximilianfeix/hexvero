import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnalysisError, Session } from "@hexvero/core";
import {
  createHandlers,
  toolSchemas,
  type ProviderBridge,
  type ToolName,
} from "./tools.js";

export { toolSchemas, type ToolName, type ProviderBridge } from "./tools.js";

export const SERVER_NAME = "hexvero";
export const SERVER_VERSION = "0.1.0";

const noProviders: ProviderBridge = {
  detect: async () => ({
    providers: [],
    note: "provider adapters are not wired in this build",
  }),
  run: async () => {
    throw new AnalysisError(
      "provider_unavailable",
      "No provider adapters are available in this build",
    );
  },
};

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** Builds the MCP server over a session. Results are returned once, as JSON text, never duplicated. */
export function createHexveroServer(
  session = new Session(),
  providers: ProviderBridge = noProviders,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "hexvero inspects local software without running it. Start with hexvero_open, then hexvero_analyze; page big lists with hexvero_collection or hexvero_strings; use hexvero_export when you need the complete result on disk. Findings carry a confidence of confirmed or inferred; limitations say what could not be established.",
    },
  );
  const handlers = createHandlers(session, providers);
  for (const [name, schema] of Object.entries(toolSchemas) as Array<
    [ToolName, (typeof toolSchemas)[ToolName]]
  >) {
    server.registerTool(
      name,
      {
        title: schema.title,
        description: schema.description,
        inputSchema: schema.input,
        annotations: {
          readOnlyHint: name !== "hexvero_export",
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await handlers[name](args ?? {});
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, replacer) },
            ],
          };
        } catch (error) {
          const payload =
            error instanceof AnalysisError
              ? {
                  error: {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                  },
                }
              : {
                  error: {
                    code: "internal",
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          };
        }
      },
    );
  }
  return server;
}

export async function serveStdio(
  session?: Session,
  providers?: ProviderBridge,
): Promise<void> {
  const server = createHexveroServer(session, providers);
  await server.connect(new StdioServerTransport());
}
