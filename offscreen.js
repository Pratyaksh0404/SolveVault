// offscreen.js
//
// Runs inside a hidden offscreen document, which — unlike the background
// service worker — has real DOM APIs (DOMParser). background.js sends raw
// HTML here to be converted to Markdown by actually walking the parsed DOM
// tree, instead of the old approach of pattern-matching HTML with regex.
// A real parser knows the difference between "this dash is a bullet" and
// "this dash is inside a code example" because it sees the actual tag
// structure — regex never reliably can.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.type !== 'CONVERT_HTML') return; // not for us
  sendResponse({ markdown: htmlToMarkdown(msg.html) });
});

function htmlToMarkdown(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return walkChildren(doc.body).trim().replace(/\n{3,}/g, '\n\n');
}

function walkChildren(node) {
  let out = '';
  for (const child of node.childNodes) out += convertNode(child);
  return out;
}

function convertNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();

  switch (tag) {
    case 'p':
      return walkChildren(node).trim() + '\n\n';

    case 'br':
      return '\n';

    case 'strong':
    case 'b':
      return `**${walkChildren(node).trim()}**`;

    case 'em':
    case 'i':
      return `*${walkChildren(node).trim()}*`;

    case 'sup':
      return `^${walkChildren(node).trim()}`;

    case 'sub':
      return `_${walkChildren(node).trim()}`;

    case 'code':
      // Inline code — <pre><code> is handled entirely by the 'pre' case
      // below, so only bare inline <code> reaches here.
      if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
        return walkChildren(node);
      }
      return `\`${walkChildren(node).trim()}\``;

    case 'pre': {
      const text = node.textContent.trim();
      // Some legacy problem content stores markdown-style TEXT (bold
      // markers, dash-bullets) literally inside a <pre> block rather than
      // real HTML. Fencing that as code would show the markdown syntax
      // literally instead of letting it render. Detect and pass through
      // unwrapped instead.
      const looksLikeMarkdownAlready = /\*\*[^*]+\*\*/.test(text) || /^-\s/m.test(text);
      if (looksLikeMarkdownAlready) return `\n${text}\n`;
      return `\n\`\`\`\n${text}\n\`\`\`\n`;
    }

    case 'ul':
    case 'ol': {
      let items = '';
      let i = 1;
      for (const child of node.children) {
        if (child.tagName.toLowerCase() !== 'li') continue;
        const marker = tag === 'ol' ? `${i}. ` : '- ';
        items += `${marker}${walkChildren(child).trim()}\n`;
        i++;
      }
      return `\n${items}\n`;
    }

    case 'li':
      // Normally consumed by the ul/ol case above; this only fires for a
      // stray <li> with no list-tag parent, which shouldn't happen in
      // practice but is handled gracefully rather than dropped.
      return `- ${walkChildren(node).trim()}\n`;

    case 'img': {
      const alt = node.getAttribute('alt');
      return alt ? `[image: ${alt}]` : '';
    }

    case 'blockquote':
      return `\n> ${walkChildren(node).trim()}\n`;

    case 'script':
    case 'style':
      return '';

    // Structural wrappers with no markdown meaning of their own — but
    // <div> is block-level, so a line break is added after its content.
    // Without this, sibling <div>s that GFG uses to visually separate
    // constraint clauses (no comma, space, or <br> between them in the
    // underlying text) collapse into one run-on line, e.g.
    // "1 ≤ n ≤ 10^61 ≤ a.size()..." instead of separate lines.
    case 'div':
      return walkChildren(node).trim() + '\n';

    case 'span':
    case 'table':
    case 'tbody':
    case 'tr':
    case 'td':
    case 'th':
    default:
      return walkChildren(node);
  }
}