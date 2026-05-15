// EN translation of accessibility-wcag.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const ACCESSIBILITY_WCAG_SERVICE_EN: ServiceDetail = {
  slug: 'accessibility-wcag',
  title: 'WCAG Accessibility',
  icon: 'ph-wheelchair',
  description:
    "From June 28, 2025 the European Accessibility Act is in force.\nIf you sell online, the site has to be accessible or you pay fines.\nAudit WCAG 2.1 AA + remediation.",
  longDescription:
    "The European Accessibility Act (EAA, EU directive 2019/882, transposed in Italy by Italian Legislative Decree 82/2022) is mandatory from June 28, 2025 for anyone selling online to European consumers: e-commerce, banks, telecoms, transport, e-books, digital services.\nItalian fines reach €40,000 per violation and include possible site removal orders.\n\nThe problem isn't \"adding an accessibility widget\" — those plugins are cosmetic and don't fix anything.\nYou need a serious audit: keyboard navigation, screen reader (NVDA + VoiceOver), color contrast, HTML semantics, ARIA where necessary, focus management, text alternatives, declared form errors.\n\nI measure with automatic tools (axe DevTools, Lighthouse) and manually with NVDA on Chrome/Firefox and VoiceOver on Safari.\nI identify real violations, order them by priority (Level A blocking, Level AA mandatory, Level AAA optional), apply fixes, deliver the publishable accessibility statement.\n\nNo \"100% compliant\" — that's a lie.\nMeasurable, declared WCAG 2.1 AA conformance.",
  features: [
    {
      title: 'Real screen reader audit',
      description:
        'I navigate the site with NVDA on Chrome/Firefox and VoiceOver on Safari/macOS.\nI identify missing landmarks, non-hierarchical headings, \"read more\" links without context, forms without associated labels.\nAutomatic tools catch 30% of violations. The rest is found only by actually using the screen reader.'
    },
    {
      title: 'Complete keyboard navigation',
      description:
        "I verify that every interaction is reachable from keyboard: menu, modals, dropdowns, carousel, accordion.\nCoherent tab order, visible focus, escape that closes modal, arrows that scroll tabs.\nNo traps that block the user in an overlay without an exit."
    },
    {
      title: 'Contrast + color check',
      description:
        "I measure the contrast ratio of every text/background combination.\nWCAG AA threshold: 4.5:1 for normal text, 3:1 for large text.\nI identify gray text on light backgrounds that fails the check. I also verify hover, disabled, error, focus states."
    },
    {
      title: 'Semantic HTML + ARIA',
      description:
        "I replace generic divs with semantic tags (nav, main, article, aside, section, button vs link).\nI add ARIA only where semantic HTML isn't enough (e.g. tab list, listbox, dialog).\nNo \"preventive\" ARIA: every attribute has a reason tested with screen reader."
    },
    {
      title: 'Declared form errors',
      description:
        "Validation errors linked to the field via aria-describedby, announced by screen reader, visible without depending only on color (icon + text).\nSubmit launches a summary with focus management, required fields marked in error messages."
    },
    {
      title: 'Publishable accessibility statement',
      description:
        "Document compliant with art. 32 of Italian Legislative Decree 82/2022 and AGID Codex: conformance level reached, possible non-accessible content, motivation, alternatives offered, contacts for reports, publication date.\nReady to be linked from the footer."
    }
  ],
  benefits: [
    'The site complies with the European Accessibility Act, no surprise fines.',
    'Users with disabilities (15% of the population) can actually use the site.',
    'Google improves SEO ranking: accessibility and crawlability reinforce each other.',
    'The accessibility statement is linkable from the footer and demonstrates compliance.',
    'The site is auditable by third parties without fear.'
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'Is my site really required to be accessible?',
      answer:
        "If you sell products or services online to European consumers (e-commerce, banks, telecom, transport, e-books), yes, from June 28, 2025.\nThe EAA directive also includes digital services and audiovisual content.\nMicro-enterprises (under 10 employees and revenue under €2M) have some exemptions, but the safe move is to ask a specific consultant or do the audit to be calm."
    },
    {
      question: "Don't \"accessibility widget\" plugins suffice?",
      answer:
        'No, and in many cases they make the situation worse.\nThose widgets overlay a JS layer that changes colors, fonts, contrast on the fly, but don\'t fix HTML structure, semantics, forms without labels, images without alt.\nThe screen reader doesn\'t understand them. The US Federal Trade Commission and several European cases consider them \"compliance-washing\".\nReal audits and code fixes are needed.'
    },
    {
      question: 'How long does it take to reach WCAG 2.1 AA?',
      answer:
        "Depends on site size and how badly it's set up.\nA clean showcase site gets sorted in 2-3 weeks.\nA complex e-commerce with checkout, filters, account area can require 6-10 weeks because every flow has to be tested.\nThe first audit clarifies the real size."
    },
    {
      question: "What happens if I don't comply with EAA?",
      answer:
        "In Italy (Italian Legislative Decree 82/2022 and amendments) administrative fines reach €40,000 per single violation, with possible service removal orders.\nAGID and consumer organizations can receive reports and open proceedings.\nMore than fines, the real risk is losing trust: a public report for inaccessibility is reverse marketing."
    },
    {
      question: 'Does accessibility slow down or complicate the site?',
      answer:
        "No, usually it improves it.\nClean HTML semantics, images with alt, forms with associated labels are also SEO best practices.\nGoogle indexes accessible sites better.\nPerformance doesn't change: no accessibility fix introduces heavy JavaScript.\nOn the contrary, \"creative\" code that was both inaccessible and inefficient often gets removed."
    },
    {
      question: 'Can I keep the current design?',
      answer:
        "Almost always yes.\n90% of fixes are in code (semantics, ARIA, focus, alt) and invisible to users without disabilities.\nThe only visible changes can be: increased contrast on gray text, more marked visible focus, alternatives to color as the only state signal.\nNothing dramatic."
    }
  ],
  awareness: {
    title: 'Accessibility-washing is already illegal',
    subtitle:
      "Accessibility widgets don't fix anything. WCAG 2.1 AA is reached in code, not with a script added to the footer.",
    problems: [
      {
        icon: 'ph-prohibit',
        title: 'Cosmetic widget',
        desc: "Plugin that adds an \"accessibility\" icon with font/contrast/cursor toggle.\nIt doesn't fix anything substantial, and several courts consider it compliance-washing.\nThe screen reader still doesn't understand the page."
      },
      {
        icon: 'ph-warning-circle',
        title: 'Non-navigable form',
        desc: "Fields without associated labels, validation errors shown only in red, submit that doesn't announce success or failure.\nWhoever uses NVDA doesn't understand what went wrong and gives up."
      },
      {
        icon: 'ph-eye-slash',
        title: 'Contrast out of threshold',
        desc: 'Gray text 999 on white background, \"soft pastel\" badges with 2.5:1 contrast ratio, light blue links indistinguishable from black text.\nWhoever has low vision abandons, and WCAG AA requires 4.5:1 minimum.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'POST-AUDIT',
    title: 'Accessibility isn\'t \"maintained\", it\'s overseen',
    body:
      "The site is WCAG 2.1 AA today. The next blog article gets published with an image without alt, a new landing arrives with a form without labels, a third-party component breaks keyboard navigation.\nWithout continuous monitoring, the level of compliance decreases in months.\n\nThat's why after the audit I deliver an operational checklist for whoever publishes content (what to check before putting an article or page online) and, where needed, I activate a quarterly re-audit retainer to catch regressions.\n\nThe accessibility statement isn't a document to archive: it has to be updated when the site changes.\nNo \"compliance once and done\": continuous, light, measurable oversight."
  }
};
