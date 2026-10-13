import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AnalysisError,
  Session,
  detectProviders,
  runProvider,
  type ProviderName,
  type ProviderOperation,
} from "@hexvero/core";
import { GUIDED_PROMPTS } from "./prompts.js";
import { createHandlers, toolSchemas, type ProviderBridge, type ToolName } from "./tools.js";

export { toolSchemas, type ToolName, type ProviderBridge } from "./tools.js";
export { GUIDED_PROMPTS, type GuidedPrompt } from "./prompts.js";

export const SERVER_NAME = "hexvero";
export const SERVER_VERSION = "0.2.1";

const defaultProviders: ProviderBridge = {
  detect: async () => ({ providers: await detectProviders() }),
  run: (args) =>
    runProvider({
      targetPath: args.targetPath,
      provider: args.provider as ProviderName,
      operation: args.operation as ProviderOperation,
      address: args.address,
      timeoutMs: args.timeoutMs,
    }),
};

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** Builds the MCP server over a session. Results are returned once, as JSON text, never duplicated. */
export function createHexveroServer(
  session = new Session(),
  providers: ProviderBridge = defaultProviders,
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
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        try {
          const result = await handlers[name](args ?? {}, extra.signal);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, replacer) }],
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
                    message: error instanceof Error ? error.message : String(error),
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
  for (const prompt of GUIDED_PROMPTS) {
    const argsShape: Record<string, z.ZodTypeAny> = {};
    for (const [name, a] of Object.entries(prompt.arguments)) {
      argsShape[name] = a.required
        ? z.string().describe(a.description)
        : z.string().optional().describe(a.description);
    }
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: argsShape },
      (args: Record<string, unknown>) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: prompt.render(
                Object.fromEntries(
                  Object.entries(args).filter(([, v]) => typeof v === "string"),
                ) as Record<string, string>,
              ),
            },
          },
        ],
      }),
    );
  }
  return server;
}

export async function serveStdio(session?: Session, providers?: ProviderBridge): Promise<void> {
  const server = createHexveroServer(session, providers);
  await server.connect(new StdioServerTransport());
}
