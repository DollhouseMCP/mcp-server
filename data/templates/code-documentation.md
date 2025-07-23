---
name: "Code Documentation"
description: "Technical documentation template for code modules, APIs, and functions"
type: "template"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "technical"
tags: ["documentation", "code", "api", "technical", "reference"]
variables:
  module_name:
    type: "string"
    description: "Name of the module or component"
    required: true
  module_type:
    type: "string"
    description: "Type of code module"
    default: "module"
    enum: ["module", "class", "function", "api", "library", "component"]
  version:
    type: "string"
    description: "Version number"
    required: true
    default: "1.0.0"
  language:
    type: "string"
    description: "Programming language"
    required: true
    default: "typescript"
  author:
    type: "string"
    description: "Author name"
    required: true
outputFormats: ["markdown", "html", "jsdoc", "typedoc"]
includes: []
---

# {{module_name}} Documentation

**Type:** {{module_type}}  
**Version:** {{version}}  
**Language:** {{language}}  
**Author:** {{author}}  
**Last Updated:** {{last_updated}}

## Overview
{{#if overview}}
{{overview}}
{{else}}
[Provide a brief description of what this {{module_type}} does and its primary purpose]
{{/if}}

## Table of Contents
1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [API Reference](#api-reference)
4. [Examples](#examples)
5. [Configuration](#configuration)
6. [Error Handling](#error-handling)
7. [Testing](#testing)
8. [Contributing](#contributing)

## Installation

{{#if installation_method}}
{{installation_method}}
{{else}}
```bash
# NPM
npm install {{module_name}}

# Yarn
yarn add {{module_name}}

# PNPM
pnpm add {{module_name}}
```
{{/if}}

### Requirements
{{#if requirements}}
{{#each requirements}}
- {{requirement}}
{{/each}}
{{else}}
- Node.js >= 18.0.0
- TypeScript >= 5.0.0 (if using TypeScript)
{{/if}}

## Quick Start

```{{language}}
{{#if quick_start_code}}
{{quick_start_code}}
{{else}}
// Import the module
import { {{module_name}} } from '{{module_name}}';

// Basic usage
const instance = new {{module_name}}({
  // configuration options
});

// Use the module
const result = await instance.doSomething();
console.log(result);
{{/if}}
```

## API Reference

### {{#if class_name}}Class: {{class_name}}{{else}}Main API{{/if}}

{{#if class_description}}
{{class_description}}
{{/if}}

#### Constructor
```{{language}}
{{#if constructor_signature}}
{{constructor_signature}}
{{else}}
new {{module_name}}(options?: {{module_name}}Options)
{{/if}}
```

**Parameters:**
{{#if constructor_params}}
{{#each constructor_params}}
- `{{name}}` ({{type}}){{#if optional}} - Optional{{/if}}: {{description}}{{#if default_value}} Default: `{{default_value}}`{{/if}}
{{/each}}
{{else}}
- `options` (Object) - Optional configuration object
  - `option1` (string): Description of option1
  - `option2` (boolean): Description of option2
{{/if}}

### Methods

{{#if methods}}
{{#each methods}}
#### {{name}}
{{description}}

```{{../language}}
{{signature}}
```

**Parameters:**
{{#each parameters}}
- `{{name}}` ({{type}}){{#if optional}} - Optional{{/if}}: {{description}}
{{/each}}

**Returns:** {{returns}}

**Example:**
```{{../language}}
{{example}}
```
{{/each}}
{{else}}
#### methodName
Brief description of what this method does.

```{{language}}
methodName(param1: string, param2?: number): Promise<Result>
```

**Parameters:**
- `param1` (string): Description of param1
- `param2` (number) - Optional: Description of param2

**Returns:** Promise<Result> - Description of return value

**Example:**
```{{language}}
const result = await instance.methodName('value', 123);
```
{{/if}}

### Properties

{{#if properties}}
{{#each properties}}
#### {{name}}
- **Type:** {{type}}
- **Access:** {{access}}
- **Description:** {{description}}
{{#if default_value}}- **Default:** `{{default_value}}`{{/if}}
{{/each}}
{{else}}
#### propertyName
- **Type:** string
- **Access:** public readonly
- **Description:** Description of this property
{{/if}}

### Events

{{#if events}}
{{#each events}}
#### {{name}}
{{description}}

**Event Data:**
```{{../language}}
{{data_structure}}
```

**Example:**
```{{../language}}
instance.on('{{name}}', (data) => {
  console.log('Event received:', data);
});
```
{{/each}}
{{else}}
This module does not emit any events.
{{/if}}

## Examples

### Basic Example
```{{language}}
{{#if basic_example}}
{{basic_example}}
{{else}}
import { {{module_name}} } from '{{module_name}}';

async function main() {
  const instance = new {{module_name}}({
    debug: true
  });
  
  try {
    const result = await instance.process('input data');
    console.log('Success:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
{{/if}}
```

### Advanced Example
```{{language}}
{{#if advanced_example}}
{{advanced_example}}
{{else}}
// Advanced usage with custom configuration
const config = {
  timeout: 5000,
  retries: 3,
  customHandler: (data) => {
    // Custom processing logic
    return data.transform();
  }
};

const instance = new {{module_name}}(config);

// Chain multiple operations
const result = await instance
  .operation1()
  .operation2()
  .operation3()
  .execute();
{{/if}}
```

## Configuration

### Configuration Options
{{#if config_options}}
| Option | Type | Default | Description |
|--------|------|---------|-------------|
{{#each config_options}}
| {{name}} | {{type}} | {{default}} | {{description}} |
{{/each}}
{{else}}
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| debug | boolean | false | Enable debug logging |
| timeout | number | 30000 | Operation timeout in ms |
| retries | number | 3 | Number of retry attempts |
{{/if}}

### Environment Variables
{{#if env_vars}}
{{#each env_vars}}
- `{{name}}`: {{description}}
{{/each}}
{{else}}
- `{{MODULE_NAME}}_DEBUG`: Enable debug mode
- `{{MODULE_NAME}}_TIMEOUT`: Override default timeout
{{/if}}

## Error Handling

### Error Types
{{#if error_types}}
{{#each error_types}}
#### {{name}}
- **Code:** {{code}}
- **Description:** {{description}}
- **How to handle:** {{handling}}
{{/each}}
{{else}}
#### ValidationError
- **Code:** VALIDATION_ERROR
- **Description:** Input validation failed
- **How to handle:** Check input parameters

#### TimeoutError
- **Code:** TIMEOUT_ERROR
- **Description:** Operation timed out
- **How to handle:** Retry or increase timeout
{{/if}}

### Error Handling Example
```{{language}}
try {
  const result = await instance.riskyOperation();
} catch (error) {
  if (error.code === 'VALIDATION_ERROR') {
    // Handle validation error
  } else if (error.code === 'TIMEOUT_ERROR') {
    // Handle timeout
  } else {
    // Handle unknown error
    throw error;
  }
}
```

## Testing

### Running Tests
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- path/to/test
```

### Writing Tests
```{{language}}
{{#if test_example}}
{{test_example}}
{{else}}
import { {{module_name}} } from '{{module_name}}';

describe('{{module_name}}', () => {
  let instance;
  
  beforeEach(() => {
    instance = new {{module_name}}();
  });
  
  test('should perform basic operation', async () => {
    const result = await instance.doSomething();
    expect(result).toBeDefined();
  });
});
{{/if}}
```

## Contributing

### Development Setup
```bash
# Clone the repository
git clone {{repository_url}}

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev
```

### Code Style
{{#if code_style}}
{{code_style}}
{{else}}
- Use ESLint configuration
- Follow TypeScript best practices
- Write comprehensive tests
- Document all public APIs
{{/if}}

## License
{{#if license}}
{{license}}
{{else}}
MIT License - see LICENSE file for details
{{/if}}

---
*Generated with {{module_name}} v{{version}}*