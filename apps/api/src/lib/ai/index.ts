/**
 * AI Module Index
 * Exports all AI providers and utilities
 */

// OpenAI exports
export {
  isOpenAIConfigured,
  fetchModels,
  createChatCompletion,
  generateSEOSuggestions,
  generateTags,
  type OpenAIModel,
  type ChatCompletionOptions,
} from './openai';

// Perplexity exports
export {
  isPerplexityConfigured,
  createCompletion,
  generateArticle,
  PERPLEXITY_MODELS,
  type PerplexityModel,
  type PerplexityCompletionOptions,
  type ArticleGenerationOptions,
  type GeneratedArticle,
} from './perplexity';

// Cover generator exports
export {
  getConfiguredProviders,
  generateCover,
  DALLE_MODELS,
  ZIMAGE_MODELS,
  type CoverProvider,
  type CoverResult,
  type CoverGenerationOptions,
  type DalleModel,
  type ZImageModel,
} from './cover-generator';

// Re-export ChatMessage from openai (both have it, use openai's version)
export type { ChatMessage } from './openai';

import { isOpenAIConfigured } from './openai';
import { isPerplexityConfigured } from './perplexity';
import { getConfiguredProviders } from './cover-generator';

/**
 * Get status of all AI providers
 */
export function getAIProvidersStatus() {
  const imageProviders = getConfiguredProviders();

  return {
    text: {
      openai: isOpenAIConfigured(),
      perplexity: isPerplexityConfigured(),
    },
    image: imageProviders,
  };
}
