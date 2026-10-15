import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Lexer, Marked } from 'marked';

const presets = JSON.parse(readFileSync(new URL('../docs/web/presets.json', import.meta.url), 'utf8'));
const repository = 'https://github.com/qwertie/btree-typescript/blob/master/';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function inlineCode(text) {
  const tags = [...text.matchAll(/<(\/?)(sub|sup)>/gi)];
  const stack = [];
  for (const tag of tags) {
    const name = tag[2].toLowerCase();
    if (!tag[1]) stack.push(name);
    else if (stack.pop() !== name) return { html: escapeHtml(text), text };
  }
  // Incomplete tag examples are still valid literal code, not broken article markup.
  if (stack.length) return { html: escapeHtml(text), text };
  let html = '', plain = '', offset = 0;
  for (const tag of tags) {
    const literal = text.slice(offset, tag.index);
    html += escapeHtml(literal) + `<${tag[1]}${tag[2].toLowerCase()}>`;
    plain += literal;
    offset = tag.index + tag[0].length;
  }
  return { html: html + escapeHtml(text.slice(offset)), text: plain + text.slice(offset) };
}

function plainText(tokens) {
  return tokens.map(token => {
    if (token.tokens) return plainText(token.tokens);
    if (token.type === 'codespan') return inlineCode(token.text).text;
    if (token.type === 'html') return '';
    return token.text ?? token.raw ?? '';
  }).join('');
}

function hrefFor(href) {
  if (!href || href.startsWith('#')) return href;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))
    throw new Error(`Unsupported link URL: ${href}`);
  const url = new URL(href, `${repository}docs/union-algorithm.md`);
  if (url.pathname.endsWith('/docs/union-algorithm.md')) return `./index.html${url.search}${url.hash}`;
  return url.href;
}

function scriptSpan(source) {
  const opening = /^<(sub|sup)>/i.exec(source);
  if (!opening) return;
  const stack = [];
  let length = 0;
  // Use the ordinary inline lexer so literal tags inside code spans are not delimiters.
  for (const token of Lexer.lexInline(source)) {
    length += token.raw.length;
    const tag = token.type === 'html' && /^<(\/?)(sub|sup)>$/i.exec(token.raw);
    if (!tag) continue;
    const name = tag[2].toLowerCase();
    if (!tag[1]) stack.push(name);
    else if (stack.pop() !== name) throw new Error('Subscript/superscript tags must be properly nested and matched.');
    if (!stack.length) return {
      tag: opening[1].toLowerCase(), raw: source.slice(0, length),
      text: source.slice(opening[0].length, length - token.raw.length)
    };
  }
  throw new Error(`Missing closing </${opening[1].toLowerCase()}> tag.`);
}

/** Project author-owned Markdown into the same HTML structure used by the article runtime. */
export function renderMarkdown(source) {
  const usedIds = new Set(['article-start', 'article', 'contents']);
  const claimed = new Set();
  const headings = [], diagrams = [], embeds = [];
  const markdown = new Marked({ gfm: true, async: false });
  markdown.use({
    extensions: [{
      name: 'scriptSpan',
      level: 'inline',
      start(source) { return source.match(/<(?:sub|sup)>/i)?.index; },
      tokenizer(source) {
        const span = scriptSpan(source);
        if (span) return { type: 'scriptSpan', ...span, tokens: this.lexer.inlineTokens(span.text) };
      },
      renderer(token) {
        return `<${token.tag}>${this.parser.parseInline(token.tokens)}</${token.tag}>`;
      }
    }, {
      name: 'scriptBlock',
      level: 'block',
      start(source) { return source.match(/^ {0,3}<(?:sub|sup)>[ \t]*\r?\n/im)?.index; },
      tokenizer(source) {
        const opening = /^ {0,3}<(sub|sup)>[ \t]*\r?\n/i.exec(source);
        if (!opening) return;
        const indent = source.indexOf('<');
        const span = scriptSpan(source.slice(indent));
        return {
          type: 'scriptBlock', ...span, raw: source.slice(0, indent + span.raw.length),
          tokens: this.lexer.inlineTokens(span.text.trim())
        };
      },
      renderer(token) {
        return `<p><${token.tag}>${this.parser.parseInline(token.tokens)}</${token.tag}></p>\n`;
      }
    }, {
      name: 'btree',
      level: 'block',
      start(source) { return source.match(/^ {0,3}:::btree\b/m)?.index; },
      tokenizer(source) {
        if (!/^ {0,3}:::btree\b/.test(source)) return;
        const match = /^ {0,3}:::btree[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+#([a-zA-Z0-9][\w-]*))?[ \t]*\r?\n {0,3}:::[ \t]*(?:\r?\n|$)/.exec(source);
        if (!match) throw new Error('Invalid BTree embed. Use ":::btree preset" and a closing ":::" on the next line.');
        if (!Object.hasOwn(presets, match[1])) throw new Error(`Unknown BTree preset "${match[1]}". Choose ${Object.keys(presets).join(', ')}.`);
        return { type: 'btree', raw: match[0], preset: match[1], explicitId: match[2] };
      },
      renderer(token) {
        const preset = presets[token.preset];
        const id = allocate(token.explicitId || preset.id, !!token.explicitId);
        const sectionId = allocate(`interactive-${id}`);
        embeds.push({ id, sectionId, preset: token.preset, label: preset.label });
        return `<section id="${sectionId}" class="${token.preset === 'playground' ? 'playground-section' : 'tree-example'}" aria-label="${escapeHtml(preset.label)}">
<div id="${id}" data-btree-example="${token.preset}"><p class="playground-placeholder">JavaScript is required to display this B+ tree.</p></div>
</section>\n`;
      }
    }]
  });
  const tokens = markdown.lexer(source);
  // Reserve explicit IDs first so automatic slugs cannot steal stable author-specified anchors.
  markdown.walkTokens(tokens, token => {
    if (token.type === 'heading') {
      const explicit = /\s+\{#([a-zA-Z0-9][\w-]*)\}\s*$/.exec(token.text);
      if (explicit) {
        token.explicitId = explicit[1];
        token.text = token.text.slice(0, explicit.index);
        token.tokens = Lexer.lexInline(token.text, markdown.defaults);
      }
    }
    if (token.explicitId) {
      assert.ok(!usedIds.has(token.explicitId), `Duplicate or reserved anchor: ${token.explicitId}`);
      usedIds.add(token.explicitId);
    }
  });

  function allocate(base, explicit = false) {
    if (explicit) {
      assert.ok(!claimed.has(base), `Duplicate anchor: ${base}`);
      claimed.add(base);
      return base;
    }
    let id = base;
    for (let suffix = 1; usedIds.has(id); suffix++) id = `${base}-${suffix}`;
    usedIds.add(id);
    claimed.add(id);
    return id;
  }

  markdown.use({
    renderer: {
      heading(token) {
        const label = plainText(token.tokens);
        const slug = label.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
          .replace(/\s+/g, '-') || 'section';
        const id = allocate(token.explicitId || slug, !!token.explicitId);
        headings.push({ depth: token.depth, id, label });
        return `<h${token.depth} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      codespan(token) {
        return `<code>${inlineCode(token.text).html}</code>`;
      },
      code(token) {
        const language = token.lang?.trim().split(/\s+/)[0] || '';
        const centered = token.lang?.trim() === 'text centered';
        if (language !== 'mermaid')
          return `<pre class="code-block${centered ? ' code-block-centered' : ''}"><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(token.text)}\n</code></pre>\n`;
        const number = diagrams.push(token.text);
        return `<figure class="diagram" data-diagram="${number}">
<figcaption><span>Diagram ${String(number).padStart(2, '0')}</span><span class="diagram-status" role="status">Source available below</span></figcaption>
<div class="diagram-output" hidden tabindex="0" role="region" aria-label="Diagram ${number}; scroll horizontally to explore"></div>
<details class="diagram-source" open><summary>Mermaid source</summary>
<pre class="mermaid"><code>${escapeHtml(token.text)}</code></pre>
</details>
</figure>\n`;
      },
      link(token) {
        return `<a href="${escapeHtml(hrefFor(token.href))}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}>${this.parser.parseInline(token.tokens)}</a>`;
      },
      table(token) {
        const cell = (value, index, tag) => `<${tag}${tag === 'th' ? ' scope="col"' : ''}${
          token.align[index] ? ` style="text-align:${token.align[index]}"` : ''}>${this.parser.parseInline(value.tokens)}</${tag}>`;
        return `<div class="table-scroll" tabindex="0" role="region" aria-label="Article table"><table>
<thead><tr>${token.header.map((value, index) => cell(value, index, 'th')).join('')}</tr></thead>
<tbody>${token.rows.map(row => `<tr>${row.map((value, index) => cell(value, index, 'td')).join('')}</tr>`).join('\n')}</tbody>
</table></div>\n`;
      },
      html(token) {
        // Keep Markdown previewable without permitting raw HTML to interfere with embed IDs or scripts.
        if (/^<!--[\s\S]*-->[\r\n]*$/.test(token.text)) return token.text;
        throw new Error('Raw HTML is restricted to matched <sub> and <sup> spans without attributes. Use Markdown, fenced code, or :::btree for other content.');
      }
    }
  });
  const html = markdown.parser(tokens);
  assert.equal(headings.filter(heading => heading.depth === 1).length, 1, 'The article needs exactly one # title.');
  return { html, headings, diagrams, embeds };
}
