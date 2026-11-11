// The End User Licence Agreement has one text: public/eula.html, the page on the website. The app shows the same words, from here, when
// someone taps Continue, and an account keeps which version was accepted. A change that needs a new yes raises <meta name="eula-version">.
import fs from 'node:fs';
import { config } from './config.js';
import { route } from './http.js';

const page = fs.readFileSync(new URL('../public/eula.html', import.meta.url), 'utf8');

// Text with Markdown for bold and links, which is what the app's Text shows. A link within the page has nowhere to go there.
const inline = (html) => html
  .replace(/<a href="([^"]+)">(.*?)<\/a>/g, (_, href, label) => (href.startsWith('#') ? label : `[${label}](${href.startsWith('/') ? config.baseUrl + href : href})`))
  .replace(/<b>(.*?)<\/b>/g, '**$1**')
  .replace(/\s+/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/'/g, '’')
  .replace(/"([^"]*)"/g, '“$1”')
  .trim();

const blocks = (html) => [...html.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, text]) => ({ text: inline(text), bullet: tag === 'li' }));

export const eula = {
  version: Number(/<meta name="eula-version" content="(\d+)">/.exec(page)[1]),
  updated: /Last updated ([^.]+)\./.exec(page)[1],
  short: blocks(/<div class="short">([\s\S]*?)<\/div>/.exec(page)[1]),
  sections: [...page.matchAll(/<section id="([\w-]+)">\s*<h2>(.*?)<\/h2>([\s\S]*?)<\/section>/g)]
    .map(([, id, title, body]) => ({ id, title: inline(title), blocks: blocks(body) })),
};

route('GET', '/api/eula', () => eula);
