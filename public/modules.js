// Module launcher: a collapsible sidebar on the left of every page, with only the modules this person may open.
// Collapsed it shows the icons (name on hover); expanded, icons and names. The choice is remembered in this browser.
// renderModules(navElement, { role, ptLinked, extraRoles, current: 'tracker' | 'priorities' | 'payouts' | 'projects' | 'receivables' | 'revenue' })
// navElement is the page header's old launcher slot; it is left empty.
function renderModules(el, { role, ptLinked, extraRoles = [], current }) {
  const staff = role === 'admin' || role === 'management';
  const mods = [
    { key: 'tracker', label: 'Expense Dashboard', href: '/', icon: 'fa-chart-pie', show: staff },
    { key: 'priorities', label: 'IY Strategy', href: '/priorities.html', icon: 'fa-bullseye', show: staff },
    { key: 'payouts', label: 'Invoicing', href: '/payouts.html', icon: 'fa-file-invoice', show: true },
    { key: 'projects', label: 'Project Tracker', href: '/projects.html', icon: 'fa-diagram-project', show: staff || ptLinked },
    { key: 'receivables', label: 'Receivables', href: '/receivables.html', icon: 'fa-hand-holding-dollar', show: staff || extraRoles.includes('finance_admin') },
    { key: 'revenue', label: 'Revenue Planner', href: '/revenue.html', icon: 'fa-chart-line', show: staff || extraRoles.includes('finance_admin') },
  ].filter((m) => m.show);
  if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  document.getElementById('iySide')?.remove();
  if (mods.length < 2) { document.body.classList.remove('iy-side-on', 'iy-side-open'); return; }

  if (!document.getElementById('iySideStyle')) {
    const css = document.createElement('style');
    css.id = 'iySideStyle';
    css.textContent = `
      body.iy-side-on { padding-left: 56px; transition: padding-left .2s ease; }
      body.iy-side-on.iy-side-open { padding-left: 212px; }
      #iySide { position: fixed; top: 0; left: 0; bottom: 0; width: 56px; z-index: 1040; background: #fff; border-right: 1px solid #e5e7eb;
        display: flex; flex-direction: column; gap: 4px; padding: 10px 8px; transition: width .2s ease; overflow: hidden; font-family: inherit; }
      body.iy-side-open #iySide { width: 212px; box-shadow: 4px 0 16px rgba(0,0,0,.04); }
      #iySide a, #iySide button { display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 12px; border-radius: 10px; color: #484848;
        text-decoration: none; font-size: 13px; font-weight: 600; white-space: nowrap; border: 0; background: none; cursor: pointer; width: 100%; text-align: left; }
      #iySide a i, #iySide button i { width: 16px; text-align: center; flex-shrink: 0; font-size: 15px; }
      #iySide a:hover, #iySide button:hover { background: #f3f4f6; color: #1a1a1a; }
      #iySide a[aria-current="page"] { background: #680087; color: #fff; }
      #iySide .iy-side-label { opacity: 0; transition: opacity .15s ease; }
      body.iy-side-open #iySide .iy-side-label { opacity: 1; }
      #iySide .iy-side-toggle { color: #8a8a8a; margin-bottom: 6px; }
      #iySide .iy-side-sep { height: 1px; background: #e5e7eb; margin: 2px 4px 6px; flex-shrink: 0; }
      @media (max-width: 640px) { body.iy-side-on.iy-side-open { padding-left: 56px; } }  /* phones: the open sidebar slides over the page */
      @media print { #iySide { display: none; } body.iy-side-on { padding-left: 0 !important; } }`;
    document.head.appendChild(css);
  }
  let open = false;
  try { open = localStorage.getItem('iySideOpen') === '1'; } catch { /* private window */ }
  const side = document.createElement('nav');
  side.id = 'iySide';
  side.setAttribute('aria-label', 'Modules');
  side.innerHTML = `<button type="button" class="iy-side-toggle" aria-expanded="${open}" aria-controls="iySide" title="${open ? 'Collapse' : 'Expand'} the menu">
      <i class="fa-solid fa-bars"></i><span class="iy-side-label">Modules</span></button><div class="iy-side-sep"></div>`
    + mods.map((m) => `<a href="${m.href}" data-module="${m.key}" title="${m.label}" ${m.key === current ? 'aria-current="page"' : ''}>
      <i class="fa-solid ${m.icon}" aria-hidden="true"></i><span class="iy-side-label">${m.label}</span></a>`).join('');
  document.body.prepend(side);
  document.body.classList.add('iy-side-on');
  document.body.classList.toggle('iy-side-open', open);
  side.querySelector('.iy-side-toggle').addEventListener('click', (e) => {
    open = !document.body.classList.contains('iy-side-open');
    document.body.classList.toggle('iy-side-open', open);
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.title = `${open ? 'Collapse' : 'Expand'} the menu`;
    try { localStorage.setItem('iySideOpen', open ? '1' : '0'); } catch { /* private window */ }
  });
}
