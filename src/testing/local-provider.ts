import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
/** Explicitly scripted local fixture, never installed unless LOCAL_TEST=true. Not an AI demo. */
export function localProvider() {
  const faux = fauxProvider({ provider: 'local-test', tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 100 }, () => async (transcript, options) => {
    if (JSON.stringify(transcript.messages.at(-1)).includes('slow bridge cancellation')) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return fauxAssistantMessage('Local test response (scripted provider; no LLM inference).');
  }));
  return faux;
}
