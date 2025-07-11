# JSON Configuration Merge Guide for Claude Desktop

## 🎯 Quick Answer
Add `dollhousemcp` INSIDE the existing `mcpServers` object, as a sibling to other servers.

## 📊 Visual Guide

### ❌ WRONG - Don't do this:
```json
{
  "globalShortcut": "Alt+Ctrl+Cmd+2",
  "mcpServers": {
    "whois": {
      "command": "npx",
      "args": ["-y", "@bharathvaj/whois-mcp@latest"]
    }
  },
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["@mickdarling/dollhousemcp"]
    }
  }
}
```
❌ This creates duplicate `mcpServers` keys - JSON doesn't allow this!

### ❌ WRONG - Don't do this either:
```json
{
  "globalShortcut": "Alt+Ctrl+Cmd+2",
  "mcpServers": {
    "whois": {
      "command": "npx",
      "args": ["-y", "@bharathvaj/whois-mcp@latest"]
    },
    "mcpServers": {
      "dollhousemcp": {
        "command": "npx",
        "args": ["@mickdarling/dollhousemcp"]
      }
    }
  }
}
```
❌ This nests `mcpServers` inside `mcpServers` - wrong level!

### ✅ CORRECT - Do this:
```json
{
  "globalShortcut": "Alt+Ctrl+Cmd+2",
  "mcpServers": {
    "whois": {
      "command": "npx",
      "args": ["-y", "@bharathvaj/whois-mcp@latest"]
    },
    "dollhousemcp": {
      "command": "npx",
      "args": ["@mickdarling/dollhousemcp"]
    }
  }
}
```
✅ Both servers are siblings inside the same `mcpServers` object!

## 🔍 Understanding the Structure

```
{                            ← Root level
  "globalShortcut": "...",   ← Root property
  "mcpServers": {            ← Root property (container for ALL servers)
    "whois": {...},          ← First server (inside mcpServers)
    "dollhousemcp": {...}    ← Second server (inside mcpServers)
  }                          ← End of mcpServers
}                            ← End of root
```

## 📝 Step-by-Step Instructions

1. **Find the closing brace `}` of your existing server** (whois in this case)
2. **Add a comma `,` after that closing brace**
3. **Add the new server configuration on the next line**
4. **Make sure you're still inside the `mcpServers` object**

## 🎨 Visual Levels

```
Level 0: {                              ← File root
Level 1:   "mcpServers": {              ← All servers go here
Level 2:     "whois": {                 ← Individual server
Level 3:       "command": "npx",        ← Server settings
Level 3:       "args": [...]
Level 2:     },                         ← End of whois
Level 2:     "dollhousemcp": {          ← Another server (same level as whois!)
Level 3:       "command": "npx",        ← Server settings
Level 3:       "args": [...]
Level 2:     }                          ← End of dollhousemcp
Level 1:   }                            ← End of mcpServers
Level 0: }                              ← End of file
```

## 💡 Pro Tips

1. **Use a JSON validator** to check your syntax: https://jsonlint.com/
2. **Count your braces** - every `{` needs a matching `}`
3. **Watch your commas** - every item except the last needs a comma
4. **Use a code editor** with JSON syntax highlighting

## 🚨 Common Mistakes

- **Missing comma** after the previous server
- **Extra comma** after the last server
- **Wrong nesting level** - adding at root instead of inside mcpServers
- **Duplicate keys** - having two `mcpServers` objects

## 🛠️ Your Specific Configuration

Here's exactly what your file should look like after adding DollhouseMCP:

```json
{
  "globalShortcut": "Alt+Ctrl+Cmd+2",
  "mcpServers": {
    "whois": {
      "command": "npx",
      "args": [
        "-y",
        "@bharathvaj/whois-mcp@latest"
      ]
    },
    "dollhousemcp": {
      "command": "npx",
      "args": ["@mickdarling/dollhousemcp"]
    }
  }
}
```

Save this file and restart Claude Desktop!