---
name: "Code Documentation"
description: "Technical documentation template for code modules, APIs, and functions"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "technical"
tags: ["documentation", "code", "api", "technical", "reference"]
variables:
  - { name: "module_name", type: "string", required: true, description: "Name of the module or component" }
  - { name: "module_type", type: "string", required: false, description: "Type of code module (module, class, function, api, library, component)", default: "module" }
  - { name: "module_version", type: "string", required: true, description: "Version number", default: "1.0.0" }
  - { name: "language", type: "string", required: true, description: "Programming language", default: "typescript" }
  - { name: "author", type: "string", required: true, description: "Author name" }
  - { name: "last_updated", type: "string", required: false, description: "Date of last update" }
  - { name: "overview", type: "string", required: false, description: "Brief description of purpose and primary functionality" }
  - { name: "installation", type: "string", required: false, description: "Installation instructions and commands" }
  - { name: "requirements", type: "string", required: false, description: "Pre-formatted bullet list of prerequisites and dependencies" }
  - { name: "quick_start_code", type: "string", required: false, description: "Minimal working code example showing basic usage" }
  - { name: "api_reference", type: "string", required: false, description: "Pre-formatted API documentation: constructors, methods with signatures, parameters, return types, and examples" }
  - { name: "properties", type: "string", required: false, description: "Pre-formatted property list with name, type, access level, and description" }
  - { name: "events", type: "string", required: false, description: "Pre-formatted event documentation with name, description, data structure, and usage example" }
  - { name: "basic_example", type: "string", required: false, description: "Complete basic usage example with code" }
  - { name: "advanced_example", type: "string", required: false, description: "Advanced usage example demonstrating complex scenarios" }
  - { name: "configuration_options", type: "string", required: false, description: "Pre-formatted table rows: | Option | Type | Default | Description |" }
  - { name: "environment_variables", type: "string", required: false, description: "Pre-formatted bullet list of environment variables and descriptions" }
  - { name: "error_handling", type: "string", required: false, description: "Error types, codes, descriptions, and handling guidance" }
  - { name: "testing_info", type: "string", required: false, description: "Testing commands and example test code" }
  - { name: "contributing_info", type: "string", required: false, description: "Development setup, code style, and contribution guidelines" }
  - { name: "license", type: "string", required: false, description: "License information" }
---
# {{module_name}} Documentation

**Type:** {{module_type}}
**Version:** {{module_version}}
**Language:** {{language}}
**Author:** {{author}}
**Last Updated:** {{last_updated}}

## Overview

{{overview}}

## Installation

{{installation}}

### Requirements

{{requirements}}

## Quick Start

{{quick_start_code}}

## API Reference

{{api_reference}}

### Properties

{{properties}}

### Events

{{events}}

## Examples

### Basic Example

{{basic_example}}

### Advanced Example

{{advanced_example}}

## Configuration

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
{{configuration_options}}

### Environment Variables

{{environment_variables}}

## Error Handling

{{error_handling}}

## Testing

{{testing_info}}

## Contributing

{{contributing_info}}

## License

{{license}}

---
*Generated with {{module_name}} v{{module_version}}*
