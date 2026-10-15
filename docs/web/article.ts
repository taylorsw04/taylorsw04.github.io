import { mountPlayground } from './playground';
import { exampleOptions } from './examples';
import './article.css';
import './playground.css';

const playgrounds = document.querySelectorAll<HTMLElement>('[data-btree-example]');
playgrounds.forEach(playground => {
  try {
    mountPlayground(playground, exampleOptions(playground.dataset.btreeExample!));
  } catch (error) {
    console.error('The B+ tree playground could not start:', error);
    const message = document.createElement('p');
    message.className = 'playground-error';
    message.setAttribute('role', 'alert');
    message.textContent = `This tree diagram could not start: ${
      error instanceof Error ? error.message : String(error)}. The rest of the article remains available.`;
    playground.replaceChildren(message);
  }
});

const disclosure = document.querySelector<HTMLDetailsElement>('.toc-disclosure');
const desktop = window.matchMedia('(min-width: 700px)');
if (disclosure) {
  // Track whether the reader has manually opened/closed the disclosure (via tap or keyboard)
  // so a later orientation/viewport change never silently overrides their choice. Without this,
  // rotating a phone whose landscape width crosses the desktop breakpoint re-forces the panel
  // back to the width-based default, which looks like it is "stuck" relative to orientation.
  let userOverride = false;
  let settingProgrammatically = false;
  const setOpen = (value: boolean) => {
    settingProgrammatically = true;
    disclosure.open = value;
    settingProgrammatically = false;
  };
  disclosure.addEventListener('toggle', () => {
    if (!settingProgrammatically) userOverride = true;
  });
  const adaptContents = () => {
    if (userOverride) return;
    setOpen(desktop.matches);
  };
  adaptContents();
  desktop.addEventListener('change', adaptContents);
  disclosure.addEventListener('click', event => {
    if (!desktop.matches && event.target instanceof Element && event.target.closest('a')) {
      setOpen(false);
      userOverride = false;
    }
  });
}

const navigation = Array.from(document.querySelectorAll<HTMLAnchorElement>('.toc-list a')).map(link => {
  const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  if (!target || !/^H[2-6]$/.test(target.tagName))
    throw new Error(`Contents link must target a Markdown section heading: ${link.hash}`);
  return { link, target };
});
const currentLabel = document.querySelector<HTMLElement>('.toc-current');
const article = document.querySelector<HTMLElement>('.article-body');
let activeSection: string | undefined;
let pendingSectionUpdate = false;

function updateCurrentSection(): void {
  pendingSectionUpdate = false;
  if (!navigation.length) return;
  const scrollPadding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  let current = navigation[0];
  for (const section of navigation) {
    const margin = parseFloat(getComputedStyle(section.target).scrollMarginTop) || 0;
    if (section.target.getBoundingClientRect().top <= scrollPadding + margin + 2) current = section;
    else break;
  }
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)
    current = navigation[navigation.length - 1];
  if (activeSection === current.target.id) return;
  activeSection = current.target.id;
  for (const section of navigation) {
    if (section === current) section.link.setAttribute('aria-current', 'location');
    else section.link.removeAttribute('aria-current');
  }
  if (currentLabel) currentLabel.textContent = `Reading: ${current.link.textContent}`;
}

function scheduleSectionUpdate(): void {
  if (pendingSectionUpdate) return;
  pendingSectionUpdate = true;
  requestAnimationFrame(updateCurrentSection);
}

window.addEventListener('scroll', scheduleSectionUpdate, { passive: true });
window.addEventListener('resize', scheduleSectionUpdate);
window.addEventListener('hashchange', scheduleSectionUpdate);
window.addEventListener('pageshow', scheduleSectionUpdate);
disclosure?.addEventListener('toggle', scheduleSectionUpdate);
// Lazy diagram rendering changes section positions even without a user scroll.
if (article) new ResizeObserver(scheduleSectionUpdate).observe(article);
scheduleSectionUpdate();

const figures = Array.from(document.querySelectorAll<HTMLElement>('[data-diagram]'));
let renderer: Promise<typeof import('mermaid')['default']> | undefined;

function getRenderer(): Promise<typeof import('mermaid')['default']> {
  if (!renderer) {
    renderer = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        themeVariables: {
          primaryColor: '#edf3f1',
          primaryTextColor: '#242b2b',
          primaryBorderColor: '#6b827b',
          lineColor: '#60716d',
          secondaryColor: '#f5f1e8',
          tertiaryColor: '#faf9f6',
          fontSize: '15px',
        },
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'linear' },
      });
      return mermaid;
    });
  }
  return renderer;
}

async function renderDiagram(figure: HTMLElement): Promise<void> {
  const source = figure.querySelector<HTMLElement>('pre.mermaid');
  const output = figure.querySelector<HTMLElement>('.diagram-output');
  const details = figure.querySelector<HTMLDetailsElement>('.diagram-source');
  const status = figure.querySelector<HTMLElement>('.diagram-status');
  const number = figure.dataset.diagram || '';
  if (!source || !output || !details || !status) {
    console.error(`Diagram ${number} is missing its source or rendering container.`);
    return;
  }
  status.textContent = 'Rendering diagram…';
  const staging = document.createElement('div');
  staging.className = 'diagram-render-buffer';
  staging.setAttribute('aria-hidden', 'true');
  document.body.append(staging);
  try {
    const mermaid = await getRenderer();
    const result = await mermaid.render(`mermaid-diagram-${number}`, source.textContent || '', staging);
    output.innerHTML = result.svg;
    const svg = output.querySelector('svg');
    if (!svg) throw new Error('Mermaid did not produce an SVG.');
    const viewBox = svg.viewBox.baseVal;
    if (viewBox.width > 0) svg.style.width = `${Math.ceil(viewBox.width)}px`;
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    output.hidden = false;
    result.bindFunctions?.(output);
    details.open = false;
    status.textContent = 'Scroll to explore · source below';
    figure.dataset.rendered = 'true';
  } catch (error) {
    console.error(`Mermaid diagram ${number} could not be rendered:`, error);
    output.hidden = true;
    output.replaceChildren();
    details.open = true;
    figure.dataset.rendered = 'failed';
    status.textContent = 'Diagram unavailable';
    const message = document.createElement('p');
    message.className = 'diagram-error';
    message.setAttribute('role', 'alert');
    message.textContent = `Diagram ${number} could not be rendered. Its complete Mermaid source is available below.`;
    figure.insertBefore(message, details);
  } finally {
    staging.remove();
  }
}

// Mermaid shares rendering state. Serialize work while isolating failures per figure.
let queue = Promise.resolve();
function enqueue(figure: HTMLElement): void {
  if (figure.dataset.queued) return;
  figure.dataset.queued = 'true';
  queue = queue.then(() => renderDiagram(figure));
}

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        enqueue(entry.target as HTMLElement);
      }
    }
  }, { rootMargin: '600px 0px' });
  figures.forEach(figure => observer.observe(figure));
} else {
  figures.forEach(enqueue);
}

window.addEventListener('beforeprint', () => figures.forEach(enqueue));
