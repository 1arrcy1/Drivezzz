// The small things that move on the website. Everything still reads without this file.
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Blue, red or yellow, as in the app. It stays on this device only.
function colours() {
  const buttons = all('.colours button');
  const show = (accent) => {
    if (accent === 'blue') delete document.documentElement.dataset.accent; else document.documentElement.dataset.accent = accent;
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.colour === accent)));
  };
  show(document.documentElement.dataset.accent || 'blue');
  buttons.forEach((b) => b.addEventListener('click', () => {
    show(b.dataset.colour);
    try { localStorage.setItem('accent', b.dataset.colour); } catch {}
  }));
}

// The example in the phone: a driver picked on the map or in the list.
// The page's own language: the server sends the Dutch pages to visitors from the Netherlands (http.js, siteLanguage).
const dutch = document.documentElement.lang === 'nl';
const say = (en, nl) => (dutch ? nl : en);

function phone() {
  const choices = all('[data-driver]');
  const book = document.getElementById('book');
  choices.forEach((c) => c.addEventListener('click', () => {
    choices.forEach((other) => {
      const on = other.dataset.driver === c.dataset.driver;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', String(on));
    });
    if (book) book.textContent = say(`Book for ${c.dataset.price}`, `Boek voor ${c.dataset.price}`);
  }));
}

// Name your price: the needle, and how it compares with the cheapest driver.
function ruler() {
  const input = document.getElementById('ruler');
  if (!input) return;
  const value = document.getElementById('ruler-value');
  const text = document.getElementById('ruler-text');
  const cheapest = Number(input.dataset.cheapest);
  const show = () => {
    const cents = Number(input.value);
    value.textContent = `€${say((cents / 100).toFixed(2), (cents / 100).toFixed(2).replace('.', ','))}`;
    input.setAttribute('aria-valuetext', value.textContent);
    text.textContent = cents < cheapest
      ? say('Less than the cheapest driver asks. Drivers nearby can still claim it, if it’s worth it to them.', 'Minder dan de goedkoopste chauffeur vraagt. Chauffeurs in de buurt kunnen hem nog steeds aannemen, als het ze dat waard is.')
      : say('Drivers nearby see your order on their map and can claim it at this price.', 'Chauffeurs in de buurt zien je rit op hun kaart en kunnen hem voor deze prijs aannemen.');
  };
  const mark = document.getElementById('cheapest');
  if (mark) mark.style.left = `${((cheapest - input.min) / (input.max - input.min)) * 100}%`;
  input.addEventListener('input', show);
  show();
}

// How a ride goes: the car drives along the road by itself, until someone picks a step.
function road() {
  const box = document.getElementById('road');
  if (!box) return;
  const steps = all('.step', box.parentElement);
  let at = 0, timer = null;
  const go = (i) => {
    at = i;
    box.style.setProperty('--p', `${((i + 0.5) / steps.length) * 100}%`);
    steps.forEach((s, n) => s.classList.toggle('on', n === i));
  };
  const stop = () => { clearInterval(timer); timer = null; };
  steps.forEach((s, i) => s.addEventListener('click', () => { stop(); go(i); }));
  go(0);
  if (calm || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([seen], watcher) => {
    if (!seen.isIntersecting) return;
    watcher.disconnect();
    timer = setInterval(() => go((at + 1) % steps.length), 3200);
  }, { threshold: 0.5 }).observe(box);
}

// Things come in as they're scrolled to.
function reveal() {
  const items = all('.reveal, .lockring');
  if (calm || !('IntersectionObserver' in window)) { items.forEach((e) => e.classList.add('in')); return; }
  const watcher = new IntersectionObserver((seen) => seen.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); watcher.unobserve(e.target); }
  }), { threshold: 0.15 });
  items.forEach((e) => watcher.observe(e));
}

// Where you are in a long page.
function contents() {
  // On a phone the list would push the page down: there it's closed until you open it.
  if (window.matchMedia('(max-width: 860px)').matches) document.querySelector('.toc')?.removeAttribute('open');
  const links = all('.toc a');
  if (!links.length || !('IntersectionObserver' in window)) return;
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const watcher = new IntersectionObserver((seen) => seen.forEach((e) => {
    if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); byId.get(e.target.id)?.classList.add('on'); }
  }), { rootMargin: '-15% 0px -75% 0px' });
  byId.forEach((_, id) => { const s = document.getElementById(id); if (s) watcher.observe(s); });
}

// Support: finding a question, and opening the one a link points to.
function questions() {
  const input = document.getElementById('faq-search');
  if (!input) return;
  const groups = all('.faq > section');
  const none = document.getElementById('faq-none');
  input.addEventListener('input', () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    groups.forEach((group) => {
      let here = 0;
      all('details', group).forEach((d) => {
        const hit = words.every((w) => d.textContent.toLowerCase().includes(w));
        d.hidden = !hit;
        d.open = hit && words.length > 0 && input.value.trim().length > 2;
        if (hit) here++;
      });
      group.hidden = here === 0;
      shown += here;
    });
    none.style.display = shown ? 'none' : 'block';
  });
  const open = () => {
    const target = location.hash && document.querySelector(location.hash);
    if (target?.tagName === 'DETAILS') target.open = true;
  };
  window.addEventListener('hashchange', open);
  open();
}

function contactForm() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const status = form.querySelector('.status');
  const topic = new URLSearchParams(location.search).get('topic');
  if (topic) form.elements.topic.value = topic;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = say('Sending…', 'Versturen…');
    try {
      const res = await fetch('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': say('en', 'nl') }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || say('That didn’t work. Try again.', 'Dat lukte niet. Probeer het nog eens.'));
      form.reset();
      status.textContent = say('Thanks! We got your message and will answer by email.', 'Bedankt! We hebben je bericht en antwoorden per e-mail.');
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

colours();
phone();
ruler();
road();
reveal();
contents();
questions();
contactForm();
