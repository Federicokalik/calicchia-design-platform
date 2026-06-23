import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const GEO_SERVICE_EN: ServiceDetail = {
  slug: 'geo',
  title: 'GEO & AI Visibility',
  icon: 'ph-sparkle',
  description:
    'Want to appear in ChatGPT, Perplexity and AI search results?\nFirst make the site readable, citable and measurable for generative engines.',
  longDescription:
    'Appearing in ChatGPT, Perplexity, Gemini, Claude or AI search results does not depend on one magic checkbox.\nGenerative engines retrieve pieces of content, rerank them, synthesize an answer and cite a few sources.\n\nNo shortcuts here: no llms.txt sold as a magic factor, no schema markup as a trick, no promise of guaranteed citations.\nWe start from the "From SEO to GEO" white paper and the GEO Audit: retrieval bot access, server-side HTML, answer-first structure, citability, freshness, snippet directives and repeated measurement.\n\nThe result is not an invented ranking.\nIt is a concrete plan to increase the probability that your site is read, selected and cited in AI answers.',
  features: [
    {
      title: 'Technical GEO audit',
      description:
        'Analysis of robots.txt, sitemap, server-side rendering, headings, snippet directives, text visible in raw HTML and signals that may block citation.',
    },
    {
      title: 'Answer-first structure',
      description:
        'Key pages are reorganized with direct answers, self-contained sections and clear headings.\nNot to trick the model: to make each block genuinely extractable.',
    },
    {
      title: 'Verifiable citability',
      description:
        'Statistics, external sources, references, examples and non-generic content are added where they matter.\nThe levers are the ones with evidence, not the ones that are easy to sell.',
    },
    {
      title: 'Bot access and directives',
      description:
        'Separation between retrieval/citation bots and training bots.\nWe avoid blocking the agents that need to read the site, without giving up opt-outs where they make sense.',
    },
    {
      title: 'Measurement without self-deception',
      description:
        'AI visibility is volatile: one test means nothing.\nWe define prompts, repeated runs, engines to monitor and useful metrics such as citation share and stability.',
    },
    {
      title: 'Anti-hype triage',
      description:
        'llms.txt, parallel Markdown, schema and manual chunking are treated for what they are: marginal or contextual tools, not primary citation levers.',
    },
  ],
  benefits: [
    'Understand what AI engines can actually see on your site.',
    'Stop chasing GEO tactics sold without evidence.',
    'Make pages clearer for users, crawlers and RAG systems.',
    'Connect white paper, audit and implementation in a measurable path.',
    'Build a stronger base for classic SEO and generative visibility.',
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'How do I appear in ChatGPT with my website?',
      answer:
        'To appear in ChatGPT, publishing a page and hoping is not enough.\nThe site must be accessible to retrieval bots, the content must be present in server-side HTML, answers must be direct, and the page needs sources, data and authority signals.\nGEO works on these elements.\nIt does not guarantee citation, but it removes obstacles that make the site invisible or weak as a source.',
    },
    {
      question: 'How do I appear in AI search results?',
      answer:
        'AI search results do not work like a list of blue links.\nChatGPT, Perplexity, Gemini and Claude retrieve content blocks, not just whole pages.\nTo appear in AI search results you need clear pages, answers in the first paragraphs, citations to external sources, current data, readable HTML and no directives blocking snippets or retrieval.',
    },
    {
      question: 'How do I get cited by ChatGPT, Perplexity or Gemini?',
      answer:
        'Make the content citable.\nThat means answering a question directly, using verifiable data and references, keeping important pages fresh and building brand signals outside the site.\nKeyword stuffing makes the result worse: you do not need to repeat "appear in ChatGPT" a hundred times, you need to give the engine a useful block to use as a source.',
    },
    {
      question: 'Do you guarantee ChatGPT will cite my site?',
      answer:
        'No.\nAnyone promising guaranteed citation is selling control they do not have.\nWe can make the site more readable, accessible to retrieval bots, structured and citable.\nWe can measure visibility with repeated runs.\nBut nobody controls which source ChatGPT, Perplexity, Gemini or Claude will choose in every answer.',
    },
    {
      question: 'Does GEO replace SEO?',
      answer:
        'No.\nGEO extends SEO; it does not replace it.\nGoogle itself says AEO and GEO are still SEO.\nThe foundations remain: technical quality, content, authority, performance, data and consistency.\nWhat changes is the level of competition: often the winning unit is not the whole page, but the clearest and most citable content block.',
    },
    {
      question: 'Do I need llms.txt?',
      answer:
        'Not as a priority.\nllms.txt may make sense as optional infrastructure for agents and development tools, but it is not a proven citation factor in AI engines.\nLighthouse treats it as experimental readiness, not as a ranking factor.\nFirst fix content, bot access, SSR, citability and measurement.',
    },
    {
      question: 'Where do we start?',
      answer:
        'With the GEO Audit.\nWe check what the site exposes in raw HTML, which bots are blocked, whether directives cut snippets and whether pages have enough structure and sources.\nThen we decide which pages are worth rewriting or consolidating.',
    },
    {
      question: 'How often should visibility be measured?',
      answer:
        'It depends on the sector and on the engines that matter to you, but one test is never enough.\nAI visibility is a distribution: the same prompt can produce different sources.\nYou need prompt sets, repeated runs and comparison over time, otherwise you confuse a one-off with a trend.',
    },
    {
      question: 'Does the service include content work?',
      answer:
        'Yes, if the audit shows content is the bottleneck.\nGEO is not only technical: an accessible but generic site remains hard to cite.\nWe work on answers, sources, data, structure, freshness and the pages that actually matter to the business.',
    },
  ],
  awareness: {
    title: 'AI engines do not reward shortcuts',
    subtitle:
      'They reward content that is readable, accessible, current and solid enough to be used as a source.',
    problems: [
      {
        icon: 'ph-robot',
        title: 'Blocked bots',
        desc:
          'The site wants citations, but robots.txt or meta directives prevent engines from reading content and snippets.\nBefore strategy, remove the technical obstacles.',
      },
      {
        icon: 'ph-text-align-left',
        title: 'Uncitable content',
        desc:
          'Pages full of generic claims, without data, sources or direct answers.\nAn AI engine has no reason to use that block as a source if better answers exist elsewhere.',
      },
      {
        icon: 'ph-chart-line-down',
        title: 'Random measurement',
        desc:
          'A prompt tested once is not a metric.\nWithout repeated runs and clear criteria, every GEO report becomes a random snapshot sold as strategy.',
      },
    ],
  },
  expandedScope: {
    eyebrow: 'METHOD',
    title: 'From the paper to the site, without selling magic',
    body:
      'The white paper explains the mechanism: retrieval, chunks, fan-out, citations, the limits of llms.txt and measurement.\nThe GEO Audit applies those criteria to a real page.\nThe service turns the result into implementation: fix bot access, remove directives that block snippets, rewrite sections that are too generic, add sources and keep important pages current.\n\nThe promise is more modest, therefore more serious: increase the probability that the site is read and used correctly by AI engines.\nNot control their answers.',
  },
};
