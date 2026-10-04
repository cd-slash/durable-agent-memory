import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
/** Explicitly scripted local fixture, never installed unless LOCAL_TEST=true. Not an AI demo. */
export function localProvider() {
  const faux = fauxProvider({ provider: 'local-test', tokensPerSecond: 100000 });
  faux.setResponses(Array.from({ length: 100 }, () => () => fauxAssistantMessage('Local test response (scripted provider; no LLM inference).')));
  return faux;
}
