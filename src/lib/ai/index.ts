import { DocumentAI } from './types';
import { MockProvider } from './mock';
import { AnthropicProvider } from './anthropic';

let provider: DocumentAI | null = null;

export function getAI(): DocumentAI {
  if (provider) return provider;
  const which = process.env.AI_PROVIDER || 'mock';
  provider = which === 'anthropic' ? new AnthropicProvider() : new MockProvider();
  return provider;
}

export function resetAI() { provider = null; }
export * from './types';
