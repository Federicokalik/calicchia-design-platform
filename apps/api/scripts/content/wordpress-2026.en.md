Until mid-2025 most of my work was WordPress and WooCommerce sites and stores. Then I started using Astro systematically, and today I mostly work with Next.js, React and Laravel. When a middle ground is needed I use the Roots stack: WordPress, but built like an application.

This is not an article against WordPress. I still use it and recommend it, and a good part of what follows explains why. It's an attempt to answer, with numbers, a question both clients and other developers ask me often: in 2026, with AI in the picture, does it still make sense to start from WordPress?

The short answer is yes, for a specific range of projects. The long answer is the rest of this article.

<div class="blog-island" data-island="wp2026-share"></div>

## The decline is real, but it isn't where you think

According to W3Techs, WordPress fell from its mid-2025 peak of 43.6% to 41.9% at the end of May 2026. It's the first sustained contraction since the project was born: six consecutive quarterly surveys going down.

Two things need saying right away, though, because they change how the figure reads.

First: among sites that use a recognisable CMS, WordPress still sits around 59-60%. More than all competitors combined. No single rival is taking the market away from it.

Second: the fastest-growing category on W3Techs isn't Shopify or Wix, it's sites with no detectable CMS, up 1.3 points in the first half of 2026 alone. That bucket holds hand-coded sites, sites built with vibe-coding tools and sites coming out of AI site builders. In other words, the segment WordPress is losing is mostly micro-sites, where AI has pushed the cost of getting started down to zero.

<div class="bl-stats"><div><strong>41.9%</strong><span>of websites on WordPress, May 2026</span></div><div><strong>~60%</strong><span>share among sites with a detectable CMS only</span></div><div><strong>+1.3</strong><span>points for sites with no CMS, first half of 2026</span></div></div>

<p class="bl-note">Sources don't agree to the decimal: depending on the month and the method, figures between 40.7% and 43.4% are going around. I use W3Techs because it's the most cited and longest-running series, knowing it measures the "relevant" web rather than every parked domain.</p>

<p class="bl-src">Sources: W3Techs via <a href="https://www.searchenginejournal.com/wordpress-market-share-in-decline/576042/">Search Engine Journal</a>; <a href="https://robertorussotto.com/guide/wordpress-quota-di-mercato/">Roberto Russotto</a>.</p>

## E-commerce: WooCommerce holds the numbers, Shopify takes the growth

This is where the data is messiest in the whole article, because every source counts something different. StoreLeads counts about 4 million active WooCommerce stores, down 8% year on year in Q2 2026. BuiltWith, which looks at installed code, reaches 6.4 million. WordPress.org, which counts plugin installs, exceeds 7 million. They're all real numbers, but they measure different things.

What the sources agree on is the direction. In the May 2026 HTTP Archive sample, Shopify is the only major platform that's growing.

<div class="blog-island" data-island="wp2026-ecommerce"></div>

In practice: WooCommerce remains a sensible choice for an SME store with a manageable catalogue and a strong content side. When the catalogue grows, marketplaces come in or traffic gets serious, the market is moving to Shopify or to headless architectures such as Shopify Hydrogen or Medusa. It's the same path I've taken on larger e-commerce projects.

<p class="bl-src">Sources: <a href="https://storeleads.app/reports/woocommerce">StoreLeads</a>; HTTP Archive via <a href="https://www.gravitykit.com/ecommerce-platform-market-share-2026/">GravityKit</a>; W3Techs via <a href="https://diviflash.com/woocommerce-statistics/">DiviFlash</a>.</p>

## Governance has cracked

For anyone selling WordPress to clients, the technical side matters less than the project's stability. And the last two years have been the most turbulent in its history.

<ol class="bl-timeline"><li><time>September 2024</time>Matt Mullenweg publicly attacks WP Engine at WordCamp US and demands a trademark licence.</li><li><time>October 2024</time>WP Engine sues Automattic and Mullenweg. WordPress.org blocks its access to plugins and updates.</li><li><time>December 2024</time>A preliminary injunction orders access to be restored.</li><li><time>January 2025</time>Automattic cuts almost all the hours it dedicated to core development.</li><li><time>May 2025</time>Automattic resumes contributing, without saying with how many people.</li><li><time>June 2025</time>The Linux Foundation launches FAIR, a federated system to distribute plugins and themes without depending on WordPress.org.</li><li><time>December 2025</time>The court orders full access to be restored within 72 hours. The lawsuit continues, with no settlement.</li></ol>

<div class="blog-island" data-island="wp2026-core-hours"></div>

The project hasn't stopped: 6.9 shipped in December 2025 and 2026 is back to three major releases. But the message for anyone building a business on WordPress is clear: governance risk exists and it's concentrated in a single company. FAIR is the first real safety net, which is why it's worth following.

<p class="bl-src">Sources: <a href="https://en.wikipedia.org/wiki/WP_Engine">Wikipedia, WP Engine</a>; <a href="https://www.365i.co.uk/news/2025/12/11/wordpress-court-ruling-automattic-wp-engine/">365i</a>; <a href="https://www.therepository.email/automattic-scales-back-wordpress-contributions-to-match-wp-engine-amid-legal-battle">The Repository</a>; <a href="https://www.therepository.email/automattic-resumes-wordpress-contributions-in-surprise-move-after-five-month-pause">The Repository</a>.</p>

## WordPress is getting ready for AI agents

This is the least told part, and in my view the most interesting. In 2025 an official AI team was formed inside the project, and the work is already landing in core.

- **Abilities API**, in core since 6.9: a central registry where plugins and themes declare what they can do, with input and output schemas and permission checks.
- **MCP Adapter**: exposes those abilities as Model Context Protocol tools, the format assistants such as Claude or ChatGPT use to discover and call external tools.
- **PHP AI Client**: a single client for calling models from different providers from WordPress code, expected in core with 7.0.

Concretely, a WordPress site can stop being just a page to read and become a set of actions an agent can perform. Here's a minimal example: the client's shop exposes its opening hours as a queryable ability.

<p class="bl-file">wp-content/mu-plugins/orari-abilities.php</p>

```php
<?php

add_action( 'wp_abilities_api_categories_init', function () {
	wp_register_ability_category( 'negozio', array(
		'label'       => __( 'Negozio', 'calicchia' ),
		'description' => __( 'Informazioni pratiche sul punto vendita.', 'calicchia' ),
	) );
} );

add_action( 'wp_abilities_api_init', function () {
	wp_register_ability( 'calicchia/orari-apertura', array(
		'label'               => __( 'Orari di apertura', 'calicchia' ),
		'description'         => __( 'Restituisce gli orari di apertura del negozio per un giorno della settimana.', 'calicchia' ),
		'category'            => 'negozio',
		'input_schema'        => array(
			'type'       => 'object',
			'properties' => array(
				'giorno' => array(
					'type' => 'string',
					'enum' => array( 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica' ),
				),
			),
			'required'   => array( 'giorno' ),
		),
		'output_schema'       => array(
			'type'       => 'object',
			'properties' => array(
				'aperto' => array( 'type' => 'boolean' ),
				'orario' => array( 'type' => 'string' ),
			),
		),
		'execute_callback'    => function ( array $input ) {
			$orari  = get_option( 'calicchia_orari', array() );
			$orario = $orari[ $input['giorno'] ] ?? '';

			return array(
				'aperto' => '' !== $orario,
				'orario' => $orario,
			);
		},
		'permission_callback' => '__return_true',
		'meta'                => array(
			'annotations'  => array( 'readonly' => true ),
			'show_in_rest' => true,
			'mcp'          => array( 'public' => true ),
		),
	) );
} );
```

With the MCP Adapter plugin active, this ability becomes a tool that an AI assistant connected to the site can call. It's a piece of infrastructure no AI site builder offers an SME today, and a concrete argument in WordPress's favour. The APIs are young: the `mcp` key in the metadata depends on the adapter version, so check it before going to production.

<p class="bl-src">Sources: <a href="https://developer.wordpress.org/news/2026/02/from-abilities-to-ai-agents-introducing-the-wordpress-mcp-adapter/">WordPress Developer Blog</a>; <a href="https://make.wordpress.org/ai/2025/11/24/release-announcement-mcp-adapter-v0-3-0/">Make WordPress AI</a>; <a href="https://instawp.com/wordpress-6-9/">InstaWP, WordPress 6.9</a>.</p>

## Security and performance: the problem is plugins and hosting

Patchstack counted 7,966 new vulnerabilities in the WordPress ecosystem in 2024, 34% more than the year before: about 22 a day. Wordfence, with a different database, counts 8,223. On the point that matters, the two sources agree.

<div class="blog-island" data-island="wp2026-vuln-waffle"></div>

Core is solid: Wordfence counted just 5 in the whole year. The risk lies in choosing and maintaining plugins. 43% of the vulnerabilities reported by Patchstack were exploitable without authentication, and in a third of cases no fix was available at disclosure time. For a client, this means maintenance isn't an extra: it's part of the product.

### Core Web Vitals

Performance tells a similar story. According to the HTTP Archive technology report, about 46% of WordPress sites pass Core Web Vitals on mobile. The weak spot is loading (LCP), not responsiveness: on INP WordPress sits around 86%, in line with Wix. So the culprit is almost always hosting, theme and images, not the CMS itself.

<div class="blog-island" data-island="wp2026-cwv"></div>

JavaScript frameworks do have an edge, but it's smaller than vendor marketing suggests. And there's a detail usually left out: a React app rendered client-side only scores worse than a traditional WordPress site. Migrating to React without server-side rendering improves nothing, quite the opposite.

<p class="bl-src">Sources: <a href="https://patchstack.com/whitepaper/state-of-wordpress-security-in-2025/">Patchstack, State of WordPress Security 2025</a>; <a href="https://www.wordfence.com/wp-content/uploads/2025/04/2024-Annual-WordPress-Security-Report-by-Wordfence.pdf">Wordfence, 2024 Annual Report</a>; HTTP Archive Core Web Vitals Technology Report.</p>

## TypeScript took the lead, and AI sped it up

In August 2025 TypeScript became the most used language on GitHub, overtaking Python and JavaScript for the first time. GitHub called it the most significant language shift of the last decade.

<div class="bl-stats"><div><strong>2.6M</strong><span>monthly TypeScript contributors on GitHub, August 2025</span></div><div><strong>+66.6%</strong><span>year-on-year growth</span></div><div><strong>66%</strong><span>of developers use JavaScript, 11th year at number one</span></div></div>

GitHub's own explanation is tied to AI. Static types make generated code verifiable: a 2025 academic study cited in the report found that 94% of compilation errors in code produced by language models are type errors. With TypeScript, the compiler catches them before they reach production.

### AI tools all build the same app

Then there's a pull effect. Ask v0, Lovable or Bolt for an interface and you almost always get the same stack: React, often Next.js or Vite, TypeScript, Tailwind and shadcn/ui. v0 doesn't even offer alternatives. There are three causes: how much that stack weighs in the training data, how much it costs in tokens to generate, and how coding agents are trained. The result is that every AI-generated project reinforces the stack AI knows best.

### PHP isn't dying

It would be wrong, though, to read all this as the end of PHP. It remains the most widespread server-side language on the web, largely thanks to WordPress. In the State of PHP 2025 survey, 89% of developers are on PHP 8, Laravel is the most used framework at 64%, and 58% have no plans to switch language. Laravel 12 and Laravel Cloud, both released in February 2025, show an ecosystem that's investing, not retreating.

### Among the meta-frameworks

State of JS 2025 paints a curious picture. Next.js is the most used, reported by 59% of respondents, but it's also the most debated and the one with the steepest drop in satisfaction. Astro leads on satisfaction, 39 points ahead of Next.js. In January 2026 Cloudflare acquired the company behind Astro, which stays open source.

On Next.js, a note from someone who uses it every day: in December 2025 a vulnerability with a CVSS score of 10 was disclosed and actively exploited a few days later. The "modern" stack needs maintenance too, exactly like WordPress.

<p class="bl-src">Sources: <a href="https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/">GitHub Octoverse 2025</a>; <a href="https://visualstudiomagazine.com/articles/2025/10/31/typescript-tops-github-octoverse-as-ai-era-reshapes-language-choices.aspx">Visual Studio Magazine</a>; <a href="https://2025.stateofjs.com/en-US/libraries/meta-frameworks/">State of JS 2025</a>; <a href="https://saschb2b.com/blog/llm-default-react-stack">Sascha Becker</a>; <a href="https://www.cloudflare.com/press/press-releases/2026/cloudflare-acquires-astro-to-accelerate-the-future-of-high-performance-web-development/">Cloudflare</a>; <a href="https://cloud.google.com/blog/topics/threat-intelligence/threat-actors-exploit-react2shell-cve-2025-55182">Google Threat Intelligence</a>.</p>

## Roots.io: WordPress built like an application

When a project needs the WordPress admin but also tidy, versionable, testable code, I use the Roots stack. It's actively maintained: 2025 brought Sage 11 and Acorn 5, with Vite replacing the old bundler, Tailwind 4, and Acorn based on Laravel 12.

- **Bedrock** organises the project: WordPress and plugins become Composer dependencies, configuration lives in environment variables.
- **Sage** is the starter theme, with Blade templates and a modern build.
- **Acorn** brings pieces of Laravel into WordPress: container, view composers, commands, cache.

An example of how the code changes. Instead of mixing queries and markup in a PHP template, the data is prepared in a view composer:

<p class="bl-file">app/View/Composers/Servizi.php</p>

```php
<?php

namespace App\View\Composers;

use Roots\Acorn\View\Composer;

class Servizi extends Composer
{
    protected static $views = ['partials.servizi'];

    public function with(): array
    {
        return [
            'servizi' => collect(get_posts([
                'post_type' => 'servizio',
                'posts_per_page' => 6,
                'orderby' => 'menu_order',
                'order' => 'ASC',
            ]))->map(fn ($post) => [
                'titolo' => get_the_title($post),
                'estratto' => get_the_excerpt($post),
                'url' => get_permalink($post),
            ]),
        ];
    }
}
```

And the template stays clean, readable even by someone who doesn't know WordPress:

<p class="bl-file">resources/views/partials/servizi.blade.php</p>

```blade
<section class="grid gap-6 md:grid-cols-3">
  @foreach ($servizi as $servizio)
    <article class="border-t border-black pt-4">
      <h3 class="text-xl font-semibold">
        <a href="{{ $servizio['url'] }}">{{ $servizio['titolo'] }}</a>
      </h3>
      <p class="mt-2 text-neutral-600">{{ $servizio['estratto'] }}</p>
    </article>
  @endforeach
</section>
```

### When it's worth it and when it isn't

It's worth it when the client must manage content on their own, but the project has enough logic to justify a serious structure. Compared with a headless WordPress with Next.js or Astro in front, you avoid the double deploy, the APIs to maintain and the content preview to rebuild.

It isn't worth it on cheap shared hosting, because you need SSH access and Composer. And it has a hidden cost: an agency that doesn't know the stack will struggle to work on the site. For the client, that's a constraint to state up front, not to discover later.

<p class="bl-src">Sources: <a href="https://roots.io/sage-v11-and-acorn-v5-released/">Roots, Sage 11 and Acorn 5</a>; <a href="https://roots.io/sage/">Sage documentation</a>.</p>

## Three projects, three different choices

The most honest way to close the technical discussion is to show how I reason on real projects. These are three typical profiles of the requests I get.

<div class="bl-cases"><div><h3>The bakery with ten pages</h3><p>Opening hours, products, contacts. Content changes twice a year and I update it.</p><p><strong>Choice: Astro</strong></p><p>A static site, fast out of the box, no plugins to update. Maintenance cost for the client drops to almost zero.</p></div><div><h3>The practice that publishes every week</h3><p>Blog, service pages, campaign landing pages. The front office wants to publish on its own.</p><p><strong>Choice: WordPress, with Roots if there's logic</strong></p><p>The editor is what the client is paying for. With a few integrations or a members area, Bedrock and Sage keep the code under control.</p></div><div><h3>The booking management system</h3><p>Calendars, roles, payments, notifications, integrations with external services.</p><p><strong>Choice: Laravel or Next.js</strong></p><p>It's an application, not a site. Forcing it into WordPress means fighting the CMS instead of using it.</p></div></div>

## Which stack for your project?

I turned the reasoning into four questions. It doesn't replace a consultation, but it gives an idea of where to start.

<div class="blog-island" data-island="wp2026-stack-picker"></div>

## So, does WordPress still make sense?

Yes, but it's no longer the default answer. In 2020 you started from WordPress and looked for a reason not to use it. In 2026 it pays to do the opposite: start from the project and choose WordPress when its strengths are actually needed.

| Topic | For WordPress | Against WordPress |
| --- | --- | --- |
| **Market** | About 60% of CMS-based sites, ecosystem and skills everywhere | First structural decline, micro-sites moving to AI builders and static sites |
| **Content** | Mature editor, the client publishes on their own, great base for SEO | For sites that rarely change it's an unnecessary maintenance cost |
| **E-commerce** | WooCommerce is still the most widespread by number of stores | Growth goes to Shopify and headless, especially beyond a certain scale |
| **AI** | Abilities API and MCP Adapter make the site usable by agents | Generation tools output React and TypeScript, not PHP |
| **Security** | Solid core, very few direct vulnerabilities | 96% of vulnerabilities in plugins, ongoing maintenance required |
| **Performance** | Responsiveness (INP) in line with competitors | Only 46% pass Core Web Vitals on mobile, because of hosting and themes |
| **Governance** | Open source, portable, no lock-in to closed platforms | Dependence on a single company, lawsuit still open |

For me the split today is this. Astro for sites that need to be fast and rarely change. WordPress, well built and maintained, for those who live on content and want to manage it themselves. Roots when WordPress is needed but the project deserves application-grade code. Laravel and Next.js when the site is really software.

And one thing holds for all four: no stack is maintenance-free. Both the WordPress plugin vulnerabilities and the CVSS 10 CVE in Next.js prove it. What makes the difference is who looks after the site after handover.

> **Choosing the stack for a new project?**
>
> Tell me what the site needs to do and who will manage it: I'll tell you where I'd start, WordPress included or not.
>
> [Let's talk](/en/contact/)

## Sources

1. W3Techs, via [Search Engine Journal](https://www.searchenginejournal.com/wordpress-market-share-in-decline/576042/), 2026
2. [Roberto Russotto, WordPress: quota di mercato in calo nel 2026](https://robertorussotto.com/guide/wordpress-quota-di-mercato/) (Italian)
3. [StoreLeads, The State of WooCommerce in 2026](https://storeleads.app/reports/woocommerce)
4. [GravityKit, Ecommerce platform market share 2026](https://www.gravitykit.com/ecommerce-platform-market-share-2026/) (HTTP Archive data)
5. [DiviFlash, WooCommerce Statistics 2026](https://diviflash.com/woocommerce-statistics/)
6. [Wikipedia, WP Engine](https://en.wikipedia.org/wiki/WP_Engine)
7. [365i, Court orders Automattic to restore WP Engine access](https://www.365i.co.uk/news/2025/12/11/wordpress-court-ruling-automattic-wp-engine/), December 2025
8. [The Repository, Automattic scales back contributions](https://www.therepository.email/automattic-scales-back-wordpress-contributions-to-match-wp-engine-amid-legal-battle), January 2025
9. [The Repository, Automattic resumes contributions](https://www.therepository.email/automattic-resumes-wordpress-contributions-in-surprise-move-after-five-month-pause), May 2025
10. [WordPress Developer Blog, Introducing the MCP Adapter](https://developer.wordpress.org/news/2026/02/from-abilities-to-ai-agents-introducing-the-wordpress-mcp-adapter/), February 2026
11. [Make WordPress AI, MCP Adapter v0.3.0](https://make.wordpress.org/ai/2025/11/24/release-announcement-mcp-adapter-v0-3-0/), November 2025
12. [Patchstack, State of WordPress Security 2025](https://patchstack.com/whitepaper/state-of-wordpress-security-in-2025/)
13. [Wordfence, 2024 Annual WordPress Security Report](https://www.wordfence.com/wp-content/uploads/2025/04/2024-Annual-WordPress-Security-Report-by-Wordfence.pdf)
14. [GitHub, Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)
15. [State of JavaScript 2025, Meta-frameworks](https://2025.stateofjs.com/en-US/libraries/meta-frameworks/)
16. [Sascha Becker, Why every LLM builds the same app](https://saschb2b.com/blog/llm-default-react-stack)
17. [Cloudflare acquires Astro](https://www.cloudflare.com/press/press-releases/2026/cloudflare-acquires-astro-to-accelerate-the-future-of-high-performance-web-development/), January 2026
18. [Google Threat Intelligence, React2Shell](https://cloud.google.com/blog/topics/threat-intelligence/threat-actors-exploit-react2shell-cve-2025-55182)
19. [Roots, Sage 11 and Acorn 5](https://roots.io/sage-v11-and-acorn-v5-released/)

<p class="bl-src">Data updated to May 2026.</p>
