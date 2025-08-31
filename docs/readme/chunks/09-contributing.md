## 🤝 Contributing

We welcome contributions to DollhouseMCP! Here's how you can help:

### Ways to Contribute

- **🐛 Report Bugs**: Open an issue with reproduction steps
- **✨ Request Features**: Suggest new functionality
- **📝 Improve Documentation**: Fix typos, add examples
- **💻 Submit Code**: Fix bugs or implement features
- **🎨 Share Elements**: Contribute personas, skills, templates

### Development Process

1. **Fork the Repository**
   ```bash
   gh repo fork DollhouseMCP/mcp-server
   ```

2. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature
   ```

3. **Make Changes**
   - Follow existing code style
   - Add tests for new functionality
   - Update documentation

4. **Test Thoroughly**
   ```bash
   npm test
   npm run lint
   npm run typecheck
   ```

5. **Submit Pull Request**
   - Target the `develop` branch
   - Provide clear description
   - Reference any related issues

### Code Style

- TypeScript with strict mode
- ESLint configuration provided
- Prettier for formatting
- Comprehensive JSDoc comments

### Commit Messages

Follow conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `test:` Testing
- `chore:` Maintenance

### Review Process

1. Automated CI checks must pass
2. Code review by maintainers
3. Address feedback
4. Merge when approved

For detailed guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).