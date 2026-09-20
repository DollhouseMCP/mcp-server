import { describe, expect, it } from '@jest/globals';
import { JSDOM } from 'jsdom';

import { projectRoleCatalog } from '../../../../src/web-console/modules/console-meta/ConsoleMetaModule.js';
import { renderRoleOptions, renderRoleGuidance } from '../../../../src/web-console/ui/role-options';

const catalog = projectRoleCatalog({});

describe('account role explanations', () => {
  it.each(['invite', 'edit'])('renders every server description in the %s flow before selection', mode => {
    const document = new JSDOM(renderRoleOptions(catalog, {
      mode, selectedRoles: [], actorCapabilities: catalog.grants.admin,
    }) + renderRoleGuidance(catalog)).window.document;
    expect(document.querySelectorAll('input')).toHaveLength(catalog.roles.length);
    for (const role of catalog.roles) {
      const input = document.querySelector(`input[${mode === 'invite' ? 'data-invite-role' : 'data-role-toggle'}="${role}"]`) as HTMLInputElement;
      expect(input.checked).toBe(false);
      expect(input.disabled).toBe(false);
      const description = document.getElementById(input.getAttribute('aria-describedby') ?? '');
      expect(description?.textContent).toContain(catalog.descriptions[role].summary);
      expect(description?.textContent).toContain(catalog.descriptions[role].sensitivePowers);
      for (const capability of catalog.grants[role]) expect(description?.textContent).toContain(capability);
    }
    expect(document.body.textContent).toContain(catalog.guidance.noAdministrativeRoles);
    expect(document.body.textContent).toContain(catalog.guidance.elevation);
    expect(document.body.textContent).toContain(catalog.guidance.management);
  });

  it('keeps unavailable roles visible and makes their authority explanation keyboard-readable', () => {
    const document = new JSDOM(renderRoleOptions(catalog, {
      mode: 'invite', actorCapabilities: catalog.grants.account_admin,
    })).window.document;
    const input = document.querySelector('[data-invite-role="security_admin"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.closest('label')?.getAttribute('tabindex')).toBe('0');
    expect(input.closest('label')?.textContent).toContain('Requires account administration');
    expect(input.closest('label')?.textContent).toContain('console:admin:security');
    expect(document.querySelector('[data-invite-role="account_admin"]')?.hasAttribute('disabled')).toBe(false);
  });

  it('preserves selected roles and explains missing mutation routes', () => {
    const document = new JSDOM(renderRoleOptions(catalog, {
      mode: 'edit', selectedRoles: ['auditor'], actorCapabilities: catalog.grants.admin,
      routeAvailable: () => false,
    })).window.document;
    const input = document.querySelector('[data-role-toggle="auditor"]') as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.closest('label')?.textContent).toContain('unavailable in this deployment');
  });

  it('escapes role copy and capability content', () => {
    const hostile = {
      roles: ['operator'], grants: { operator: ['<script>bad()</script>'] },
      descriptions: { operator: { name: '<img src=x>', summary: '<script>bad()</script>', sensitivePowers: 'A & B' } },
    };
    const document = new JSDOM(renderRoleOptions(hostile, { mode: 'invite' })).window.document;
    expect(document.querySelector('script, img')).toBeNull();
    expect(document.body.textContent).toContain('<script>bad()</script>');
    expect(document.body.textContent).toContain('A & B');
  });
});
