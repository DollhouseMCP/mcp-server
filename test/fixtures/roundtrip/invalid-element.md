# Invalid Test Element

This is an intentionally malformed element for testing error handling.

## Metadata
- Type: unknown-type
- Version: invalid-version
- Author: 
- Tags: 
- Created: invalid-date
- Updated: 

## Description

This element is designed to test error handling in the roundtrip workflow. It contains various invalid elements:

1. **Invalid Type**: Uses "unknown-type" which is not a valid element type
2. **Invalid Version**: Uses "invalid-version" instead of semantic versioning
3. **Missing Author**: Author field is empty
4. **Empty Tags**: Tags field is empty
5. **Invalid Dates**: Uses "invalid-date" format

## Malformed Content

This section contains intentionally problematic content:
- Missing required fields
- Inconsistent formatting
- Invalid characters in metadata
- Broken markdown structure

## Testing Purpose

This element should trigger various error conditions:
- Validation failures during installation
- Parse errors during metadata extraction
- Type checking failures
- Version validation errors
- Missing required field errors

## Expected Behavior

When this element is used in tests, the system should:
1. Reject installation with clear error messages
2. Prevent submission to portfolio
3. Block collection submission
4. Provide helpful debugging information
5. Not corrupt other valid elements

## Error Scenarios

### Scenario 1: Installation Attempt
- **Action**: Try to install this as a valid element
- **Expected**: Installation fails with validation error
- **Error Type**: Invalid element type

### Scenario 2: Local Creation
- **Action**: Try to create this element locally
- **Expected**: Creation blocked with metadata errors
- **Error Type**: Missing required fields

### Scenario 3: Portfolio Submission
- **Action**: Try to submit to portfolio
- **Expected**: Submission fails with validation error
- **Error Type**: Content validation failure

### Scenario 4: Collection Submission
- **Action**: Try to submit to collection
- **Expected**: Submission blocked with format error
- **Error Type**: Invalid element format