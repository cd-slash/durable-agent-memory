import type { ToolExecutionResult } from '@earendil-works/pi-durable';
export const EXEC_RECOVERY_GUIDANCE = "Execution failed; no successful file write is established by this result. Do not repeat unchanged failing source or claim success. command must be an ES module with a default-exported FUNCTION, not an object with run(). Use named imports from node:fs/promises (do not import promises from it). Example: import {writeFile} from 'node:fs/promises'; export default async function(input) { await writeFile('/workspace/example.json', JSON.stringify(input)); return {saved:true}; } Verify file effects with read when needed.";
/** computer reports process exit status as data. Pi also needs isError for the model/UI. */
export function executionResult(result: ToolExecutionResult): ToolExecutionResult {
  const failed = result.isError || result.content?.some(block => {
    if (block.type !== 'text') return false;
    try {
      const data = JSON.parse(block.text);
      return data && typeof data === 'object' && ((typeof data.exitCode === 'number' && data.exitCode !== 0) || typeof data.error === 'string');
    } catch { return false; }
  });
  return failed ? { ...result, isError: true, content: [...(result.content ?? []), { type: 'text', text: EXEC_RECOVERY_GUIDANCE }] } : result;
}
