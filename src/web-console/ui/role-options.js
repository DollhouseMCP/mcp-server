import { escapeHtml } from './ui-utils.js';

export function roleDisplayName(catalog, role) {
  return catalog.descriptions?.[role]?.name || String(role).replaceAll('_', ' ');
}

/** The same visible, keyboard-readable explanation is used in both account flows. */
export function renderRoleOptions(catalog, { mode, selectedRoles = [], actorCapabilities = [], routeAvailable = () => true }) {
  return catalog.roles.map(role => {
    const selected = selectedRoles.includes(role);
    const capabilities = catalog.grants[role] || [];
    const hasAuthority = Object.hasOwn(catalog.grants, role)
      && actorCapabilities.includes('console:admin:accounts')
      && capabilities.every(capability => actorCapabilities.includes(capability));
    const available = routeAvailable(role, selected);
    const manageable = hasAuthority && available;
    const description = catalog.descriptions?.[role];
    const id = `ua-${mode}-role-${role}`;
    const reason = !available ? 'Role changes are unavailable in this deployment or for this account.'
      : !hasAuthority ? `Requires account administration and these powers: ${capabilities.join(', ')}.` : '';
    return `<label class="ua-role-opt${manageable ? '' : ' ua-role-opt--locked'}" ${manageable ? '' : 'tabindex="0"'}>
      <input type="checkbox" ${mode === 'invite' ? 'data-invite-role' : 'data-role-toggle'}="${escapeHtml(role)}"
        aria-describedby="${escapeHtml(id)}" ${selected ? 'checked' : ''} ${manageable ? '' : 'disabled'}>
      <span class="ua-role-opt-label">${escapeHtml(roleDisplayName(catalog, role))}</span>
      <span class="ua-role-opt-description" id="${escapeHtml(id)}">
        ${description ? `<span>${escapeHtml(description.summary)}</span><span>${escapeHtml(description.sensitivePowers)}</span>` : '<span>Role description unavailable.</span>'}
        <span class="ua-role-opt-caps">Effective capabilities: ${capabilities.map(escapeHtml).join(' · ')}</span>
        ${reason ? `<span class="ua-role-opt-reason">${escapeHtml(reason)}</span>` : ''}
      </span>
    </label>`;
  }).join('');
}

export function renderRoleGuidance(catalog) {
  return Object.values(catalog.guidance || {}).map(text => `<p class="ua-role-guidance">${escapeHtml(text)}</p>`).join('');
}
