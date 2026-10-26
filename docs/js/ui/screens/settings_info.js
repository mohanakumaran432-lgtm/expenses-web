// Pages that only explain: Privacy, and Known limitations.

import { h } from '../dom.js';
import { page } from '../components.js';
import { LIMITATION_SECTIONS, PRIVACY_SECTIONS } from './info_text.js';

function textPage(app, { title, intro, sections }) {
  const screen = page(app, { title, back: true, backLabel: 'Settings' });
  screen.body.append(h('div', { class: 'stack-l prose' },
    intro ? h('p', { class: 'prose-lead' }, intro) : null,
    ...sections.map((section) => h('section', { class: 'stack-s' },
      h('h2', { class: 'section-title' }, section.title),
      section.lead ? h('p', null, section.lead) : null,
      section.items ? h('ul', null, ...section.items.map((text) => h('li', null, text))) : null))));
  return { el: screen.el };
}

export function openPrivacy(app) {
  app.shell.push(createPrivacy);
}

export function createPrivacy(app) {
  return textPage(app, {
    title: 'Privacy',
    intro: 'What this app keeps, where it keeps it, and what it cannot promise. No app is completely secure, so the limits are listed too.',
    sections: PRIVACY_SECTIONS,
  });
}

export function openLimitations(app) {
  app.shell.push(createLimitations);
}

export function createLimitations(app) {
  return textPage(app, {
    title: 'Known limitations',
    intro: 'Things this app does not do, or cannot promise. Read this before you rely on it.',
    sections: LIMITATION_SECTIONS,
  });
}
