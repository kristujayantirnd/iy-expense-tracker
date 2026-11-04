// Module switcher in every page header: only the modules this person may open.
// renderModules(navElement, { role, ptLinked, current: 'tracker' | 'payouts' | 'projects' | 'receivables' })
function renderModules(el, { role, ptLinked, current }) {
  const staff = role === 'admin' || role === 'management';
  const mods = [
    { key: 'tracker', label: 'Expense Tracker', href: '/', icon: 'fa-chart-pie', show: staff },
    { key: 'payouts', label: 'Invoicing', href: '/payouts.html', icon: 'fa-file-invoice', show: true },
    { key: 'projects', label: 'Project Tracker', href: '/projects.html', icon: 'fa-diagram-project', show: staff || ptLinked },
    { key: 'receivables', label: 'Receivables', href: '/receivables.html', icon: 'fa-hand-holding-dollar', show: staff },
  ].filter((m) => m.show);
  el.setAttribute('aria-label', 'Modules');
  el.innerHTML = mods.length < 2 ? '' : mods.map((m) => {
    const on = m.key === current;
    return `<a href="${m.href}" data-module="${m.key}" title="${m.label}" ${on ? 'aria-current="page"' : ''}
      class="px-2.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition ${on ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}">
      <i class="fa-solid ${m.icon}"></i><span class="hidden md:inline">${m.label}</span></a>`;
  }).join('');
  el.classList.toggle('hidden', mods.length < 2);
}
