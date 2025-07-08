# GitHub Project Field IDs Reference

## Project Information
- **Organization**: DollhouseMCP
- **Project Number**: 1
- **Project ID**: `PVT_kwDODRuHjc4A9b0K`
- **Project URL**: https://github.com/orgs/DollhouseMCP/projects/1

## Field IDs for GraphQL Operations

### Status Field
- **Field ID**: `PVTSSF_lADODRuHjc4A9b0KzgxI18k`
- **Type**: Single Select
- **Options**:
  - 🔍 Triage: `f75ad846`
  - 📋 Backlog: `92a638ee`
  - 📅 Ready: `282c5b23`
  - 🚧 In Progress: `47fc9ee4`
  - 👀 In Review: `909c0975`
  - ✅ Done: `98236657`

### Priority Field
- **Field ID**: `PVTSSF_lADODRuHjc4A9b0KzgxI6wM`
- **Type**: Single Select
- **Options**:
  - P0: `b2eaba22`
  - P1: `a10c7552`
  - P2: `538c2b5f`

### Area Field
- **Field ID**: `PVTSSF_lADODRuHjc4A9b0KzgxI8v0`
- **Type**: Single Select
- **Options**:
  - CI/CD: `d96ad1b2`
  - Docker: `1995bf86`
  - Testing: `f7eb6d68`
  - Platform: `5ee594d8`
  - Marketplace: `0f996289`
  - UX: `c84f02d4`
  - Security: `cf722e57`
  - Performance: `da8b9c19`
  - Tooling: `d3f45756`

### Size Field
- **Field ID**: `PVTSSF_lADODRuHjc4A9b0KzgxI66w`
- **Type**: Single Select
- **Options**: XS, S, M, L, XL (need to get option IDs)

### Effort Field
- **Field ID**: `PVTSSF_lADODRuHjc4A9b0KzgxI67g`
- **Type**: Single Select
- **Options**: XS, S, M, L, XL (need to get option IDs)

### Other Fields
- **Estimate**: `PVTF_lADODRuHjc4A9b0KzgxI63M` (Number)
- **Start date**: `PVTF_lADODRuHjc4A9b0KzgxI63Q` (Date)
- **End date**: `PVTF_lADODRuHjc4A9b0KzgxI63U` (Date)
- **Sprint**: `PVTIF_lADODRuHjc4A9b0KzgxI63Y` (Iteration)
- **Iteration**: `PVTIF_lADODRuHjc4A9b0KzgxI63c` (Iteration)

## Example GraphQL Mutations

### Update Status
```graphql
mutation {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: "PVT_kwDODRuHjc4A9b0K"
      itemId: "ITEM_ID_HERE"
      fieldId: "PVTSSF_lADODRuHjc4A9b0KzgxI18k"
      value: { singleSelectOptionId: "98236657" }  # Done
    }
  ) {
    projectV2Item { id }
  }
}
```

### Update Priority
```graphql
mutation {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: "PVT_kwDODRuHjc4A9b0K"
      itemId: "ITEM_ID_HERE"
      fieldId: "PVTSSF_lADODRuHjc4A9b0KzgxI6wM"
      value: { singleSelectOptionId: "b2eaba22" }  # P0
    }
  ) {
    projectV2Item { id }
  }
}
```

## CLI Commands

### Get all field details
```bash
gh api graphql -f query='
{
  organization(login: "DollhouseMCP") {
    projectV2(number: 1) {
      fields(first: 30) {
        nodes {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  }
}'
```

### Get item IDs for issues
```bash
gh api graphql -f query='
{
  organization(login: "DollhouseMCP") {
    projectV2(number: 1) {
      items(first: 100) {
        nodes {
          id
          content {
            ... on Issue {
              number
            }
          }
        }
      }
    }
  }
}'
```

## Notes
- These IDs are specific to this project and won't work elsewhere
- Field IDs remain constant even if field names change
- Option IDs remain constant even if option names change
- Always test mutations with a single item first