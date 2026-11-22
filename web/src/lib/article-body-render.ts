import MarkdownIt from 'markdown-it';

// Strapi richtext content is Markdown, while imported articles also contain
// legacy HTML. Keep raw HTML enabled for compatibility; callers must send the
// result through cleanBodyHtml before it reaches the page.
const articleMarkdown = new MarkdownIt({ html: true, linkify: true });

// Article pages already render their title as the page H1, and the existing
// sanitizer removes body H1 elements. Keep Markdown's top-level body heading
// visible as an H2 instead of losing its text at that boundary.
articleMarkdown.core.ruler.after('block', 'article-body-h1-as-h2', (state) => {
  for (const token of state.tokens) {
    if ((token.type === 'heading_open' || token.type === 'heading_close') && token.tag === 'h1') {
      token.tag = 'h2';
    }
  }
});

/** Render article Markdown and mixed legacy HTML for the existing sanitizer. */
export function renderArticleBody(body: string): string {
  // Markdown-it's HTML blocks preserve the scraper's outer article wrapper and
  // allow Markdown added after that wrapper to render as its own blocks. Keep
  // CommonMark code-block indentation untouched.
  return articleMarkdown.render(body);
}
