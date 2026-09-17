import test from 'tape-six';

import {sortable} from '/static/ui/fmw-sortable.js';

const STORAGE = 'test.fmw-sortable.t';
const TABLES = {
  t: {
    columns: [
      {key: 'name', label: 'Name', value: r => r.name, text: true},
      {key: 'n', label: 'N\nsub', value: r => r.n, n: true},
      {key: 'x', label: 'X'}
    ],
    storage: STORAGE,
    fallback: {key: 'name', dir: 'asc'},
    tie: r => r.name
  }
};
const data = () => [
  {name: 'b', n: 2},
  {name: 'a', n: 3},
  {name: 'c', n: 1},
  {name: 'd', n: 2}
];
const names = list => list.map(r => r.name).join('');

test('sortable state reads a valid remembered sort and falls back otherwise', t => {
  const {state} = sortable(TABLES);
  try {
    localStorage.removeItem(STORAGE);
    t.deepEqual(state('t'), {key: 'name', dir: 'asc'}, 'nothing remembered: the fallback');
    localStorage.setItem(STORAGE, JSON.stringify({key: 'n', dir: 'desc'}));
    t.deepEqual(state('t'), {key: 'n', dir: 'desc'}, 'a remembered sortable column');
    localStorage.setItem(STORAGE, JSON.stringify({key: 'x', dir: 'asc'}));
    t.deepEqual(state('t'), {key: 'name', dir: 'asc'}, 'a column without a value falls back');
    localStorage.setItem(STORAGE, JSON.stringify({key: 'gone', dir: 'asc'}));
    t.deepEqual(state('t'), {key: 'name', dir: 'asc'}, 'an unknown column falls back');
    localStorage.setItem(STORAGE, 'not json');
    t.deepEqual(state('t'), {key: 'name', dir: 'asc'}, 'unreadable storage falls back');
  } finally {
    localStorage.removeItem(STORAGE);
  }
});

test('sortable rows orders text and numbers both ways with the tie breaker', t => {
  const {rows} = sortable(TABLES);
  try {
    localStorage.removeItem(STORAGE);
    let list = data();
    t.deepEqual(rows('t', list), {key: 'name', dir: 'asc'}, 'returns the sort used');
    t.equal(names(list), 'abcd', 'text ascending');
    localStorage.setItem(STORAGE, JSON.stringify({key: 'name', dir: 'desc'}));
    list = data();
    rows('t', list);
    t.equal(names(list), 'dcba', 'text descending');
    localStorage.setItem(STORAGE, JSON.stringify({key: 'n', dir: 'desc'}));
    list = data();
    rows('t', list);
    t.equal(names(list), 'abdc', 'numbers descending, equal numbers by the tie');
    localStorage.setItem(STORAGE, JSON.stringify({key: 'n', dir: 'asc'}));
    list = data();
    rows('t', list);
    t.equal(names(list), 'cbda', 'numbers ascending, equal numbers by the tie');
  } finally {
    localStorage.removeItem(STORAGE);
  }
});

test('sortable head renders the header cells with their sort marks', t => {
  const {head} = sortable(TABLES);
  const tr = document.createElement('tr');
  tr.innerHTML = head('t', {key: 'n', dir: 'desc'}, c =>
    c.key === 'n' ? '<span class="sub">w</span>' : ''
  );
  const ths = [...tr.children];
  t.equal(ths.length, 3, 'one cell per column');
  t.deepEqual(
    ths.map(th => th.classList.contains('sortable')),
    [true, true, false],
    'a column without a value is not sortable'
  );
  t.deepEqual(
    ths.map(th => th.getAttribute('aria-sort')),
    ['none', 'descending', null],
    'the current column carries its direction'
  );
  t.equal(ths[1].dataset.table, 't');
  t.equal(ths[1].dataset.sort, 'n');
  t.equal(ths[1].getAttribute('tabindex'), '0', 'sortable cells take focus');
  t.ok(ths[1].classList.contains('n'), 'a numeric column is marked');
  t.equal(
    ths[1].innerHTML,
    'N<br>sub<span class="sub">w</span>',
    'labels break lines and take the extra'
  );
  t.equal(ths[2].innerHTML, 'X');
});

test('sortable bind remembers a clicked column, toggles it, and answers Enter and Space', t => {
  const {bind, head} = sortable(TABLES);
  const box = document.createElement('div');
  document.body.appendChild(box);
  const rendered = [];
  const draw = sort => {
    box.innerHTML = `<table><thead><tr>${head('t', sort)}</tr></thead></table>`;
  };
  try {
    localStorage.removeItem(STORAGE);
    bind(box, table => rendered.push(table));
    draw({key: 'name', dir: 'asc'});
    box.querySelector('[data-sort="n"]').click();
    t.deepEqual(
      JSON.parse(localStorage.getItem(STORAGE)),
      {key: 'n', dir: 'desc'},
      'a number column starts descending'
    );
    t.deepEqual(rendered, ['t'], 'the table is redrawn');
    draw({key: 'n', dir: 'desc'});
    box.querySelector('[data-sort="n"]').click();
    t.deepEqual(
      JSON.parse(localStorage.getItem(STORAGE)),
      {key: 'n', dir: 'asc'},
      'a second click toggles'
    );
    box.querySelector('[data-sort="name"]').click();
    t.deepEqual(
      JSON.parse(localStorage.getItem(STORAGE)),
      {key: 'name', dir: 'asc'},
      'a text column starts ascending'
    );
    box.querySelector('th:last-child').click();
    t.equal(rendered.length, 3, 'a cell without a sort does nothing');
    const th = box.querySelector('[data-sort="n"]');
    th.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    th.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}));
    th.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));
    t.equal(rendered.length, 5, 'Enter and Space sort, another key does not');
  } finally {
    box.remove();
    localStorage.removeItem(STORAGE);
  }
});
