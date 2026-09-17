import test from 'tape-six';

import '/static/ui/components/vault-markdown.js';

const mount = (attrs = '') => {
  const host = document.createElement('div');
  host.innerHTML = `<vault-markdown ${attrs}></vault-markdown>`;
  document.body.appendChild(host);
  return [host.firstElementChild, host];
};

test('vault-markdown renders markdown and captures wikilink targets', t => {
  const [el, host] = mount();
  try {
    el.value = '# Title\n\nSee [[topics/alpha]] and [[topics/beta|Beta]].';
    t.equal(el.querySelector('h1').textContent, 'Title', 'heading rendered');
    const links = [...el.querySelectorAll('a.wikilink')];
    t.deepEqual(
      links.map(a => a.dataset.wikilink),
      ['topics/alpha', 'topics/beta'],
      'targets captured'
    );
    t.deepEqual(
      links.map(a => a.textContent),
      ['topics/alpha', 'Beta'],
      'the alias is what shows'
    );
    t.equal(links[0].hasAttribute('href'), false, 'an unresolved link carries no href');
  } finally {
    host.remove();
  }
});

test('show-frontmatter decides whether the frontmatter block renders', t => {
  const doc = '---\ntitle: T\n---\nBody text.';
  const [shown, host1] = mount('show-frontmatter');
  const [hidden, host2] = mount();
  try {
    shown.value = doc;
    hidden.value = doc;
    t.ok(shown.querySelector('pre.frontmatter'), 'shown when the attribute is present');
    t.equal(hidden.querySelector('pre.frontmatter'), null, 'omitted when it is absent');
    t.ok(hidden.textContent.includes('Body text.'), 'the body renders either way');
  } finally {
    host1.remove();
    host2.remove();
  }
});

test('re-setting the same value does not re-parse the document', t => {
  const [el, host] = mount();
  try {
    el.value = '# Title\n\nBody.';
    const sentinel = document.createElement('span');
    sentinel.id = 'sentinel';
    el.append(sentinel);

    el.value = '# Title\n\nBody.';
    t.ok(el.querySelector('#sentinel'), 'the same value leaves the rendered DOM in place');

    el.value = '# Other\n\nBody.';
    t.equal(el.querySelector('#sentinel'), null, 'a different value re-renders');
    t.equal(el.querySelector('h1').textContent, 'Other', 'and shows the new content');
  } finally {
    host.remove();
  }
});
