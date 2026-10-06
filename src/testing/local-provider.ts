import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
/** Explicitly scripted local fixture, never installed unless LOCAL_TEST=true. Not an AI demo. */
export function localProvider() {
  const faux = fauxProvider({ provider: 'local-test', tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 100 }, () => async (transcript, options) => {
    if (JSON.stringify(transcript.messages.at(-1)).includes('slow bridge cancellation')) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const last = transcript.messages.filter(m => m.role !== 'system').at(-1);
    if (last?.role === 'user') {
      const text = typeof last.content === 'string' ? last.content : last.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const marker = text.indexOf('workspace-fixture:');
      if (marker >= 0) {
        const fixture = JSON.parse(text.slice(marker + 'workspace-fixture:'.length)) as { tool: string; args: Parameters<typeof fauxToolCall>[1] };
        return fauxAssistantMessage(fauxToolCall(fixture.tool, fixture.args), { stopReason: 'toolUse' });
      }
    }
    return fauxAssistantMessage('Local test response (scripted provider; no LLM inference).');
  }));
  return faux;
}
