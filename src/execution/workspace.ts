import { Workspace, type DurableObjectStorageLike } from '@cloudflare/computer';
import { WorkerJavaScriptBackend } from '@cloudflare/computer/backends/worker-javascript';
import { createPiTools } from '@cloudflare/computer/tools/pi-ai';
import type { BillingClient } from '../billing/control';
import type { Extension } from '@earendil-works/pi-durable';

export const EXEC_DESCRIPTION = 'Run JavaScript ES module source in a fresh isolated Cloudflare Worker. command is JavaScript, NOT a shell command. Default-export a function to receive input and return a JSON result. console.log/error are captured. Import node:fs/promises for async reads/writes within /workspace, or relative .js modules from the workspace. No shell, npm, Python, host filesystem, host environment, or network access. Prefer read/write/edit for file changes.';
export function createWorkspace(storage: DurableObjectStorage, loader?: WorkerLoader): Workspace {
  return new Workspace({
    storage: storage as unknown as DurableObjectStorageLike,
    backends: loader ? [new WorkerJavaScriptBackend({
      id: 'javascript', loader, root: '/workspace', access: 'read-write',
      globalOutbound: null, allowGitNetwork: false, allowArtifactNetwork: false,
      defaultTimeoutMs: 3000, maxTimeoutMs: 10000,
      maxSourceBytes: 32768, maxInputBytes: 32768, maxStdinBytes: 16384,
      maxEnvBytes: 4096, maxResultBytes: 8192, maxStdioBytes: 4096,
      maxCapabilityCalls: 100, maxCapabilityRequestBytes: 65536,
      maxCapabilityResponseBytes: 65536, maxCapabilityBytes: 131072,
      maxDirectoryEntries: 256, maxConcurrentExecutions: 1,
      maxRetainedExecutions: 10, retentionMs: 60000,
    })] : [],
  });
}
export function workspaceExtension(workspace: Workspace, executionEnabled = true, billing?: BillingClient): Extension {
  const { tools, execute } = createPiTools({
    workspace, assets: false,
    read: { maxBytes: 8192, maxModelBytes: 8192, maxLines: 500 },
    write: { maxBytes: 65536 }, edit: { maxBytes: 65536 },
    ...(executionEnabled ? { shell: { defaultBackend: 'javascript', backends: { javascript: { description: EXEC_DESCRIPTION } }, maxBytes: 8192, streamMaxBytes: 4096 } } : {}),
  });
  return {
    name: 'durable-workspace-v1',
    sections: [{ key: 'workspace-capabilities', tag: false, render: () => executionEnabled ? 'You have a private persistent /workspace in this conversation. Use the workspace file tools and exec for calculations, data analysis and JavaScript programs. Files survive restart. This workspace is remote, not the user’s local repository. exec runs ES modules, not shell commands. Use tools when they help answer the request and report their actual results.' : 'You have private persistent remote workspace files in this conversation, normally under /workspace. Use read/write/edit/delete/ls/find/grep for file tasks. This deployment has no code execution or shell tool because Worker Loader is not enabled. Do not claim to execute code. Files survive restart; they are separate from the user’s local repository.' }],
    tools: tools.map(tool => ({
      name: tool.name, description: tool.name === 'exec' ? EXEC_DESCRIPTION : tool.description,
      parameters: tool.name === 'exec' ? {
        ...tool.parameters,
        properties: { ...tool.parameters.properties, command: { type: 'string', description: 'JavaScript ES module source. Default-export a function to receive input and return a result.' } },
      } : tool.parameters,
      ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
      replay: ['read', 'ls', 'find', 'grep'].includes(tool.name) ? 'safe' : 'unsafe',
      async execute(args, api, context) {
        await billing?.reserve({ tools: 1, ...(tool.name === 'exec' ? { executions: 1, storageBytes: 4 * 131072 } : ['write', 'edit'].includes(tool.name) ? { storageBytes: 4 * 65536 } : { storageBytes: 32768 }) });
        return execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal });
      },
    })),
  };
}
