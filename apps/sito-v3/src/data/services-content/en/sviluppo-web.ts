// EN translation of sviluppo-web.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const SVILUPPO_WEB_SERVICE_EN: ServiceDetail = {
  slug: 'sviluppo-web',
  title: 'Web Development',
  icon: 'ph-code',
  description:
    'Web apps, dashboards and automations to take processes out of Excel, email and WhatsApp.\nPeriod.',
  longDescription:
    "When a process lives between Excel, email, WhatsApp and three SaaS tools that don't talk to each other, every growth becomes friction.\nThe customer calls to know the status, the team copies data by hand, somebody chases passwords, exports and lost notifications.\n\nSerious web development starts there: map the real flow, cut useless steps, build a web app with login, roles, dashboards, APIs and automations.\nOn an internal procedure that went from 7 manual steps to 3, the gain wasn't aesthetic: it was operational.\n\nClean code, sensible database, modern SaaS performance, no plugins glued in because \"it was faster\".\nThe result is an operating system for daily work: less chasing, fewer errors, more control.\nEnd of story.",
  features: [
    {
      title: 'Custom web app',
      description:
        'Web applications built on the real process, not on a re-themed template.\nOperational area, data management, internal flows, notifications, roles and permissions: all designed to reduce manual steps and blind spots.'
    },
    {
      title: 'APIs and integrations',
      description:
        "I connect CRM, ERP, management systems, gateways, email providers and external platforms with REST or GraphQL APIs.\nNo copy-paste between different panels: data goes in, goes out, and stays consistent."
    },
    {
      title: 'Private client areas',
      description:
        'Login, roles, permissions, documents, cases, orders and progress status in a single reserved area.\nThe customer sees what they need to see, the team stops answering the same questions repeatedly.'
    },
    {
      title: 'Live operational dashboards',
      description:
        "Dashboards with metrics, activities, queues, statuses and real-time data where they actually matter: production, sales, support, administration.\nNot 14 decorative charts, but panels for deciding what to do now."
    },
    {
      title: 'Automations and AI',
      description:
        "Automations for notifications, follow-ups, document generation, request routing and AI chatbots connected to company data.\nThe goal is to remove repetitive work, not add another toy to maintain."
    },
    {
      title: 'Scalable architecture',
      description:
        "Modern stack with Next.js, Node, Postgres and services chosen with judgment.\nReadable code, modular structure, controlled deployment, logs and technical foundations that don't collapse as users and data grow."
    }
  ],
  benefits: [
    'Less manual work between scattered sheets, emails and chats.',
    'Customers updated without constant calls to operational staff.',
    'Consistent data between CRM, ERP, dashboards and external tools.',
    'Internal processes faster, measurable and easier to correct.',
    'Maintainable code without depending on random plugins.'
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'When do I need a custom web app instead of an off-the-shelf SaaS?',
      answer:
        "When real work no longer fits inside generic tools.\nIf you use Calendly, sheets, CRM, email, WhatsApp and a separate management system to complete a single process, the problem isn't a desire for order: it's architecture.\nA custom web app makes sense when you want a single, controllable flow connected to your data."
    },
    {
      question: 'Can we integrate tools we already use?',
      answer:
        "Yes, if they expose APIs, webhooks, reliable exports or a decent technical way to communicate.\nCRM, ERP, payments, email, calendars, logistics platforms and external databases can be connected.\nBut first we verify what each system actually allows, because many tools promise integrations and then leave only half-doors open."
    },
    {
      question: 'Can we build a client area with case status or orders?',
      answer:
        "Yes. It's one of the most sensible cases: the customer logs in, sees documents, progress, deadlines, orders, open requests and notifications.\nThe internal team updates once and the information becomes visible where needed.\nFewer calls, fewer duplicate emails, fewer \"can you let me know where we stand?\"."
    },
    {
      question: "What's the difference vs a WordPress site with plugins?",
      answer:
        "A site with plugins can be fine for simple content.\nBut when you need roles, permissions, structured data, automations, APIs and operational dashboards, plugins become a fragile stack.\nEvery update can break something, every extension adds dependencies, every workaround becomes technical debt.\nHere we build the system, we don't pile up stuff."
    },
    {
      question: 'How do you handle security, login and permissions?',
      answer:
        "They get designed before visible code.\nRoles, permissions, sessions, validations, logs, endpoint protection and data separation have to be in the architecture, not in a check added at the end.\nA private area isn't just a screen with a password: it's a clear technical boundary between users, data and allowed actions."
    },
    {
      question: 'What happens after launch?',
      answer:
        "After launch we look at the system as it works: logs, errors, response times, blocked steps, internal user requests, dirty data.\nThen we correct by priority.\nA business web app isn't a showcase to deliver and wave goodbye: it's an operational tool that has to be kept sharp."
    }
  ],
  awareness: {
    title: "The problem isn't digital, it's operational",
    subtitle:
      "If every piece of data passes through three people and four tools, the bottleneck doesn't disappear by itself.",
    problems: [
      {
        icon: 'ph-warning-circle',
        title: 'Scattered processes',
        desc: "Excel, email and WhatsApp hold up while volume is low.\nThen come duplicates, different versions, lost attachments and decisions made on old data. Period."
      },
      {
        icon: 'ph-credit-card',
        title: "SaaS that don't talk",
        desc: 'You pay multiple platforms to do pieces of the same work.\nOne books, one sends emails, one archives, one measures.\nThe team becomes the human connector between disconnected tools.'
      },
      {
        icon: 'ph-clock',
        title: 'Customers waiting',
        desc: "When the customer has to call to know case status, orders or documents, the system is already showing its limits.\nThe information exists, but stays locked in the wrong place."
      }
    ]
  },
  expandedScope: {
    eyebrow: 'AFTER LAUNCH',
    title: 'The code has to handle real work',
    body:
      "A custom web app doesn't end when it goes online.\nIt ends when the team uses it without going back to Excel after two weeks.\nThat's why post-launch matters: clear logs, monitoring, backups, flow corrections, new integrations when the process changes.\n\nThe enemy is the chain of providers: whoever did the design, whoever installed the plugin, whoever manages shared hosting, whoever only replies by opening tickets.\nToo many hand-offs, too many hands, nobody really owning the system.\n\nHere the technical perimeter stays readable: code, APIs, database, automations, deployment and maintenance speak the same language.\nIf you need to add a dashboard, connect a CRM, automate a document or expose an endpoint, you don't start from scratch.\nYou extend a base designed to grow. You decide."
  }
};
