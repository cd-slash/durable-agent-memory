import type { Extension } from "@earendil-works/pi-durable";
import type { MemoryAgent } from "../agent";
import { teamCall } from "./routes";
interface Snapshot {
  agent: { id: string; project: string; label: string; purpose: string };
  text: string;
}
async function snapshot(agent: MemoryAgent): Promise<Snapshot | undefined> {
  // Named object identity is resolved centrally; clients cannot supply a different project.
  const response = await teamCall(agent.projectControl, "context", {
    agent: agent.projectName(),
  });
  if (!response.ok) throw new Error("Project context unavailable");
  return (await response.json()) as Snapshot | undefined;
}
export async function projectSnapshot(agent: MemoryAgent) {
  return (await snapshot(agent))?.text ?? "";
}
export function projectExtension(agent: MemoryAgent): Extension {
  return {
    name: "project-collaboration-v1",
    tools: [
      {
        name: "team_board",
        description:
          "Read your shared project task board and notes. Each agent has its own transcript and private workspace. Project task dispatch is explicit; no recursive delegation.",
        parameters: { type: "object", properties: {} },
        replay: "safe",
        async execute() {
          await agent.billing.reserve({ tools: 1 });
          const state = await snapshot(agent);
          if (!state)
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "This session is not assigned to a shared project.",
                },
              ],
            };
          const response = await teamCall(agent.projectControl, "board", {
            project: state.agent.project,
            internalAgent: state.agent.id,
          });
          const board = (await response.json()) as any;
          return {
            isError: !response.ok,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  agents: board.agents,
                  tasks: board.tasks?.slice(0, 8),
                  notes: board.notes?.slice(0, 8),
                }).slice(0, 16000),
              },
            ],
          };
        },
      },
      {
        name: "team_note",
        description:
          "Publish a concise finding, artifact reference or handoff to your shared project. This writes append-only shared evidence, never another agent transcript. Do not publish secrets or unsupported claims.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable note id for replay" },
            content: { type: "string", maxLength: 2000 },
          },
          required: ["id", "content"],
        },
        replay: "unsafe",
        async execute(input) {
          const args = input as { id: string; content: string };
          await agent.billing.reserve({ tools: 1 });
          const state = await snapshot(agent);
          if (!state)
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "This session is not assigned to a shared project.",
                },
              ],
            };
          const response = await teamCall(agent.projectControl, "note", {
            project: state.agent.project,
            internalAgent: state.agent.id,
            id: args.id,
            content: args.content,
          });
          return {
            isError: !response.ok,
            content: [
              { type: "text", text: JSON.stringify(await response.json()) },
            ],
          };
        },
      },
    ],
  };
}

/** Execution policies are immutable assignments; tool declarations remain stable for cache locality. */
export function guardProjectTools(
  extension: Extension,
  agent: MemoryAgent,
): Extension {
  return {
    ...extension,
    tools: extension.tools?.map((tool) => ({
      ...tool,
      async execute(...args: Parameters<typeof tool.execute>) {
        const response = await teamCall(agent.projectControl, "tool-auth", {
          agent: agent.projectName(),
          tool: tool.name,
        });
        const permission = response.ok
          ? ((await response.json()) as { allowed: boolean })
          : undefined;
        if (!permission?.allowed) {
          await agent.billing.reserve({ tools: 1 });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "This tool is denied by the agent owner’s project policy. Use the allowed tools in your project snapshot.",
              },
            ],
          };
        }
        return tool.execute(...args);
      },
    })),
  };
}
