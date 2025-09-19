## 🔒 Security

DollhouseMCP implements enterprise-grade security measures to protect your data and ensure safe operation.

### Security Features

- **Input Sanitization**: All user inputs validated and sanitized
- **Path Traversal Prevention**: Filesystem access strictly controlled
- **YAML Injection Protection**: Safe parsing with validation
- **Command Injection Prevention**: No direct shell command execution
- **Token Encryption**: OAuth tokens encrypted at rest
- **Rate Limiting**: API calls throttled to prevent abuse
- **Audit Logging**: Security events tracked for analysis

### Security Testing

- **Automated Security Scanning**: GitHub Advanced Security enabled
- **Dependency Scanning**: Automated vulnerability detection
- **Code Analysis**: Static analysis with CodeQL
- **Secret Scanning**: Prevents credential leaks

### Reporting Security Issues

If you discover a security vulnerability, please:

1. **DO NOT** create a public GitHub issue
2. Open a private security advisory on GitHub
3. Include steps to reproduce if possible
4. Allow up to 48 hours for initial response

For more details, see our [Security Policy](SECURITY.md).