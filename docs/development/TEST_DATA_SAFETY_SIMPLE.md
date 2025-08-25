# How to Enable Test Data - Simple Guide

## The Situation
You've cloned the DollhouseMCP repository and want to run it locally. By default, the example personas and skills in the `data` folder won't load (this is intentional, to keep your environment clean).

## How to Run the MCP Server WITH Test Data

### Step-by-Step Instructions

1. **Open your terminal** (Terminal on Mac, Command Prompt on Windows)

2. **Navigate to the MCP server folder:**
   ```bash
   cd /path/to/mcp-server
   ```

3. **Choose ONE of these options to run the server:**

   **Option A: Run WITHOUT test data (default)**
   ```bash
   npm run dev
   ```
   
   **Option B: Run WITH test data (adds one thing to the front)**
   ```bash
   DOLLHOUSE_LOAD_TEST_DATA=true npm run dev
   ```

That's it! The `DOLLHOUSE_LOAD_TEST_DATA=true` part is just something you type BEFORE the npm command, all on the same line.

## What's Actually Happening?

When you type:
```bash
DOLLHOUSE_LOAD_TEST_DATA=true npm run dev
```

You're doing two things at once:
1. Setting a temporary variable (`DOLLHOUSE_LOAD_TEST_DATA=true`)
2. Running the server (`npm run dev`)

This variable only exists for that one command. Next time you run `npm run dev` without it, test data won't load.

## Real Example

```bash
# Monday - Working on a new feature, don't need test data
cd /path/to/mcp-server
npm run dev
# Result: Server starts, portfolio is empty/clean

# Tuesday - Need to test with example personas
cd /path/to/mcp-server
DOLLHOUSE_LOAD_TEST_DATA=true npm run dev
# Result: Server starts, example personas/skills are available

# Wednesday - Back to regular development
cd /path/to/mcp-server
npm run dev
# Result: Server starts, portfolio is empty/clean again
```

## For Windows Users

If you're on Windows Command Prompt, it's slightly different:

```cmd
REM Option A: Without test data
npm run dev

REM Option B: With test data (two commands)
set DOLLHOUSE_LOAD_TEST_DATA=true
npm run dev
```

## The Key Point

- **You DON'T edit any files**
- **You DON'T change any configuration**
- **You just add `DOLLHOUSE_LOAD_TEST_DATA=true` before your npm command when you want test data**
- **It's temporary - only for that one time you run it**

## Why Would You Want Test Data?

Enable it when you want to:
- See example personas in action
- Test that elements are loading correctly
- Debug issues with specific element types
- Have some content to play with

Keep it disabled when you want to:
- Work with a clean environment
- Test your own custom personas
- Use the MCP server for real work
- Avoid clutter from test examples