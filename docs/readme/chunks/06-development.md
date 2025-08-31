## 🛠️ Development

### Getting Started

```bash
# Clone the repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

### Development Workflow

1. **Create Feature Branch**: `git checkout -b feature/your-feature`
2. **Make Changes**: Implement your feature or fix
3. **Run Tests**: `npm test`
4. **Build**: `npm run build`
5. **Submit PR**: Create pull request to develop branch

### Available Scripts

- `npm run build` - Compile TypeScript
- `npm run dev` - Development mode with watch
- `npm test` - Run test suite
- `npm run lint` - Check code style
- `npm run typecheck` - TypeScript type checking

### Project Structure

```
src/
├── index.ts           # Main server entry
├── tools/            # MCP tool implementations
├── utils/            # Utility functions
├── types/            # TypeScript definitions
└── elements/         # Element system
```

For detailed development guides, see [Development Documentation](docs/development/).