// <vault-legend> — the fleet legend. One entries table; the `view` attribute
// (glance, repos, packages, project) selects the entries shown, so every view
// and page explains its marks from the same place, table marks included
// (topics/at-a-glance-dashboard-conventions § Drill down and discoverability).
//
// Light DOM on purpose, same rationale as <vault-nav>: the marks are samples of
// the host page's own markup — chips from fleet-popover.js, cells and words
// from the tables — styled by the page's CSS; the panel look is in theme.css.

export const VIEWS = ['glance', 'repos', 'packages', 'project'];

const chip = (text, kind = '') => `<span class="chip${kind ? ` ${kind}` : ''}">${text}</span>`;
const cell = (text, kind = '') => `<span class="cell${kind ? ` ${kind}` : ''}">${text}</span>`;
const svg = body =>
  `<svg width="56" height="16" viewBox="0 0 56 16" aria-hidden="true">${body}</svg>`;
const dot = (cx, cy) =>
  `<circle cx="${cx}" cy="${cy}" r="3" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>`;
const columns = [8, 12, 6, 10, 14]
  .map(
    (h, i) => `<rect x="${2 + i * 11}" y="${13 - h}" width="7" height="${h}" fill="var(--accent)"/>`
  )
  .join('');
const SPARK = svg(
  '<path d="M2 12 L12 9 L22 11 L32 5 L42 8 L52 4" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    dot(52, 4)
);
const BARS = svg(columns);
const TICK = svg(
  columns +
    '<line x1="38.5" x2="38.5" y1="14" y2="16" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/>'
);
const MAJORS = svg(
  '<rect x="0" y="2" width="56" height="5" rx="2.5" fill="var(--line)"/><rect x="0" y="2" width="38" height="5" rx="2.5" fill="var(--accent)"/>' +
    '<rect x="0" y="10" width="56" height="5" rx="2.5" fill="var(--line)"/><rect x="0" y="10" width="14" height="5" rx="2.5" fill="var(--muted)"/>'
);
const STEPS = svg(
  '<path d="M2 13 H14 V9 H30 V6 H44 V3 H52" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    dot(52, 3)
);

const STALE = 'The stored data is more than 7 days old.';

const ENTRIES = [
  // At a glance
  {
    views: ['glance'],
    mark: '<span class="legend-line">repository</span>',
    text: 'Has a new item from a person that you have not answered yet; these come first.'
  },
  {
    views: ['glance'],
    mark: chip('#12', 'new'),
    text: 'Opened by a person in the last 10 days, with no reaction, comment, or assignee from you.'
  },
  {
    views: ['glance'],
    mark: chip('#12'),
    text: 'An open issue, PR, or discussion. Hover or tap it for details; click it to keep them open.'
  },
  {
    views: ['glance'],
    mark: chip('#12', 'active'),
    text: 'Updated within the activity window: a comment, an edit, a label, or a state change.'
  },
  {views: ['glance'], mark: chip('#12', 'bot'), text: 'Opened by a bot, such as Dependabot.'},
  {views: ['glance'], mark: chip('#12', 'draft'), text: 'A draft PR.'},
  {
    views: ['glance'],
    mark: chip('+4'),
    text: 'More of the same kind; hover or tap it for the list.'
  },
  {
    views: ['glance'],
    mark: chip('GHSA-1234', 'warn'),
    text: 'A security advisory without a CVE, or not yet published.'
  },
  {
    views: ['glance'],
    mark: chip('Dependabot 3', 'warn'),
    text: 'Open alerts. A ≥ before the number means the collector stopped counting there, so the repository has at least that many.'
  },
  {
    views: ['glance'],
    mark: chip('failure', 'bad'),
    text: 'The last CI run on the default branch did not succeed.'
  },
  {
    views: ['glance'],
    mark: chip('1.8.1'),
    text: 'An npm version published within the activity window.'
  },
  {
    views: ['glance'],
    mark: chip('dependents +3'),
    text: 'A change in deps.dev direct dependents within the activity window.'
  },
  {views: ['glance'], mark: '<span class="fmw-warn">stale</span>', text: STALE},
  // The tables
  {
    views: ['repos', 'packages'],
    mark: cell('&nbsp;'),
    text: 'Nothing to count: a zero, or a share that is 100% by construction, such as a lone major carrying every download. Hover the cell for the reason.'
  },
  {
    views: ['repos', 'packages'],
    mark: cell('-', 'fmw-quiet'),
    text: 'Not available, as opposed to zero: discussions turned off, no version split read, no reading stored, or a package outside the fleet graph.'
  },
  {
    views: ['repos'],
    mark: cell('off', 'fmw-quiet'),
    text: 'Alerts are turned off for the repository.'
  },
  {
    views: ['repos'],
    mark: cell('3 (2 no CVE)', 'fmw-warn'),
    text: 'Published advisories, and how many of them have no CVE yet.'
  },
  {
    views: ['repos'],
    mark: cell('≥100', 'fmw-warn'),
    text: 'Open alerts; hover for the count by severity. A ≥ before the number means the collector stopped counting there, so the repository has at least that many.'
  },
  {
    views: ['repos'],
    mark: `${cell('success', 'fmw-ok')} ${cell('failure', 'fmw-bad')} ${cell('cancelled', 'fmw-warn')} ${cell('none', 'fmw-quiet')}`,
    text: 'The last CI run on the default branch, linked to the run; none when no run is recorded.'
  },
  {views: ['packages'], mark: '<a class="fmw-pill">npm</a>', text: 'Opens the package on npm.'},
  {
    views: ['packages', 'project'],
    mark: '<span class="fmw-warn">deprecated</span>',
    text: 'The package is deprecated on npm.'
  },
  {
    views: ['packages'],
    mark: '4.2.5 <span class="fmw-quiet">3 mo</span>',
    text: 'The latest version and how long ago it was published.'
  },
  {
    views: ['packages'],
    mark: SPARK,
    text: 'Weekly downloads over the last 26 weeks; the dot is the latest week.'
  },
  {
    views: ['packages'],
    mark: cell('−18%', 'fmw-quiet'),
    text: 'The change of the last 4 weeks against the 4 before, muted when the earlier 4 weeks had under 5,000 downloads, where the ratio is mostly noise.'
  },
  {
    views: ['packages'],
    mark: cell('≤4.7%'),
    text: 'The latest version is not among the five most downloaded, so its share is at most this.'
  },
  {
    views: ['packages'],
    mark: cell('335 <span class="fmw-quiet">+1</span>'),
    text: 'Direct dependents on deps.dev, and their change within the activity window.'
  },
  {
    views: ['repos', 'packages'],
    mark: '<span class="sort">Stars ▲</span>',
    text: 'Click a column header to sort by it; the arrow shows the direction, remembered per table.'
  },
  {views: ['repos', 'packages'], mark: cell('Sep 2', 'fmw-warn'), text: STALE},
  // The project page
  {views: ['project'], mark: '<span class="fmw-warn">collected Sep 2 18:41</span>', text: STALE},
  {
    views: ['project'],
    mark: BARS,
    text: 'Weekly downloads; hover a column for the count and the versions published that week.'
  },
  {
    views: ['project'],
    mark: TICK,
    text: 'A tick under a week marks a publish in that week. Mirrors download each new version, so a spike after a publish is not adoption.'
  },
  {
    views: ['project'],
    mark: MAJORS,
    text: "Shares of the week's downloads by major; the latest major in the accent color."
  },
  {
    views: ['project'],
    mark: STEPS,
    text: 'Direct dependents over time; the dot is the latest reading. Hover for the value on a day.'
  }
];

// Exported for tests: the entries a view shows, in order.
export const legendEntries = view => ENTRIES.filter(e => e.views.includes(view));

class VaultLegend extends HTMLElement {
  static observedAttributes = ['view'];

  connectedCallback() {
    if (!this._ready) {
      this._details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Legend';
      this._panel = document.createElement('div');
      this._panel.className = 'panel';
      this._details.append(summary, this._panel);
      this.appendChild(this._details);
      this._close = e => {
        if (this._details.open && !this.contains(e.target)) this._details.open = false;
      };
      this._escape = e => {
        if (e.key === 'Escape') this._details.open = false;
      };
      // A `view` set before the element upgraded is an own property shadowing the accessor;
      // the panel exists by now, and _ready is still unset so the attribute callback stays quiet.
      if (Object.hasOwn(this, 'view')) {
        const v = this.view;
        delete this.view;
        this.view = v;
      }
      this._ready = true;
      this.render();
    }
    document.addEventListener('click', this._close);
    document.addEventListener('keydown', this._escape);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._close);
    document.removeEventListener('keydown', this._escape);
  }

  attributeChangedCallback() {
    if (this._ready) this.render();
  }

  get view() {
    return this.getAttribute('view') ?? '';
  }

  set view(v) {
    this.setAttribute('view', v);
  }

  render() {
    const entries = legendEntries(this.view);
    this._panel.replaceChildren(
      ...entries.flatMap(({mark, text}) => {
        const m = document.createElement('span');
        m.className = 'mark';
        m.innerHTML = mark;
        const t = document.createElement('span');
        t.textContent = text;
        return [m, t];
      })
    );
    this.hidden = entries.length === 0;
  }
}

customElements.define('vault-legend', VaultLegend);
