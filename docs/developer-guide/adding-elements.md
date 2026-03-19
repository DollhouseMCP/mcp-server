# Adding New Element Types – Playbook

Element-type metadata lives in a central configuration file. Follow these steps to integrate a new type without missing any remaining touchpoints.

---

## 1. Update the Central Config (Single Source of Truth)

Edit `src/config/element-types.ts`:

```ts
ELEMENT_TYPE_CONFIG[ElementType.MYTYPE] = {
  plural: 'mytypes',
  directory: 'mytypes',
  mcpSupported: true,
  hasManager: true,
  icon: '✨',
  description: 'What this element provides'
};
```

This automatically updates:
- MCP-supported type arrays (`MCP_SUPPORTED_TYPES`, `VALID_TYPES_ARRAY`)
- Plural → `ElementType` maps
- Directory resolution helpers

### Sanity check
```bash
cat src/config/element-types.ts
```
Ensure `ElementType` is imported and the new entry matches the naming conventions (pluralized directory, etc.).

---

## 2. Extend Core Types & Managers

### `src/portfolio/types.ts`
Add the enum entry:
```ts
export enum ElementType {
  // ...
  MYTYPE = 'mytypes'
}
```

### Element implementation
Create `src/elements/mytypes/MyType.ts` (extends `BaseElement`) and `MyTypeManager.ts` (extends `BaseElementManager` or uses the relevant pattern). Export from `src/elements/mytypes/index.ts`.

### Dependency injection
Wire the manager in `src/di/Container.ts`:
```ts
this.register('MyTypeManager', () => new MyTypeManager(/* deps */));
```
Inject it into `ElementCRUDHandler` (constructor and property wiring) if the type should participate in generic CRUD operations.

---

## 3. Update Handlers & Tools

- **Element CRUD**: add cases in `ElementCRUDHandler` if the new type needs custom activation/listing behavior.
- **Collection tooling**: if the type should be downloadable from the community collection, ensure any type filters in `CollectionHandler` or installers allow it.
- **Portfolio sync**: confirm `portfolio_element_manager` operations infer the type correctly (should pick it up from the central config automatically once managers are wired).

---

## 4. Tests

- Unit tests for the new element class and manager.
- CRUD handler tests if behavior differs from existing types.
- Collection/installer tests if users can install the new type.
- Add any integration tests necessary for MCP tool coverage.

---

## 5. Documentation & Release Notes

- Update developer docs (e.g., `element-development.md`) with type-specific considerations.
- Mention the new type in user-facing docs if applicable.
- Include test results and migration steps in the release notes or PR description.

---

## 6. Final Checklist

- [ ] `ElementType` enum updated
- [ ] `ELEMENT_TYPE_CONFIG` entry added
- [ ] Manager and element class implemented
- [ ] DI container wiring complete
- [ ] Handlers/tools aware of the new type
- [ ] Tests added/updated
- [ ] Docs and release notes revised

Following this playbook ensures the new element type integrates cleanly with the architecture and future changes remain centralized.***
