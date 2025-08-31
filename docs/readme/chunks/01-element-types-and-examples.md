## 🎯 Element Types: Available Now & Coming Soon

### ✅ Available Now

<table>
<tr>
<td width="50%">

#### 🎭 Personas
Shape how your AI behaves and responds
- **Examples**: Creative Writer, Code Reviewer, Business Consultant
- **Use**: `"Activate the creative writer persona"`

</td>
<td width="50%">

#### 💡 Skills  
Add specialized capabilities your AI can use
- **Examples**: Data Analysis, Code Generation, Language Translation
- **Use**: `"Enable the data analysis skill"`

</td>
</tr>
<tr>
<td width="50%">

#### 📝 Templates
Ensure consistent, high-quality outputs
- **Examples**: Meeting Notes, Code Reviews, Email Drafts
- **Use**: `"Use the meeting notes template"`

</td>
<td width="50%">

#### 🤖 Agents
Enable autonomous task completion
- **Examples**: Project Manager, Research Assistant, Code Debugger
- **Use**: `"Run the project manager agent"`

</td>
</tr>
</table>

### 🔄 Coming Soon

<table>
<tr>
<td width="50%">

#### 🧠 Memory
Persistent context across sessions
- **Examples**: Project Context, Learning Progress, Personal Preferences
- **Status**: In Development

</td>
<td width="50%">

#### 🎯 Ensembles
Combine multiple elements as one entity
- **Examples**: Full-Stack Developer (multiple skills), Complete Writing Suite
- **Status**: In Development

</td>
</tr>
</table>

## 💬 Natural Language Usage Examples

DollhouseMCP is designed for natural language interaction. Just describe what you want in plain English - you don't need to be overly specific, the system will figure it out.

### Importing from the Community Collection

**Natural Language Examples:**
- `"Show me all the personas in the Dollhouse Collection"`
- `"What creative writing personas are available?"`
- `"Install the storyteller persona from the collection"`
- `"Search for Python development skills"`
- `"Find templates for technical documentation"`

**Direct Commands (if you prefer):**
```bash
browse_collection type="personas"
search_collection "creative writing"
install_content "personas/storyteller.md"
```

### Managing Your Portfolio

**Natural Language Examples:**
- `"What's in my portfolio?"`
- `"Show me all my custom personas"`
- `"Sync my portfolio with GitHub"`
- `"Create a backup of my elements"`
- `"Search my portfolio for marketing templates"`

**Direct Commands (if you prefer):**
```bash
portfolio_status
list_elements type="personas"
sync_portfolio
search_portfolio "marketing"
```

### Working with Elements

**Natural Language Examples:**
- `"Activate the code reviewer persona"`
- `"What's currently active?"`
- `"Switch to creative writing mode"`
- `"Deactivate all elements"`
- `"Show me details about the data analyst skill"`
- `"Create a new persona for customer support"`
- `"Edit the email template to be more formal"`

**Direct Commands (if you prefer):**
```bash
activate_element "code-reviewer" type="personas"
get_active_elements
deactivate_element type="personas"
get_element_details "data-analyst" type="skills"
create_element type="personas" name="customer-support"
```

### Complete Workflow Example

Here's how a typical session might look:

```
You: "I need help with creative writing"
Assistant: "I'll help you with creative writing. Let me check what personas are available..."

You: "Show me creative writing personas in the collection"
Assistant: [Shows list of available creative writing personas]

You: "Install and activate the storyteller persona"
Assistant: "I've installed and activated the Storyteller persona. I'm now ready to help craft engaging narratives..."

You: "Actually, let me create my own persona for science fiction writing"
Assistant: "I'll help you create a custom science fiction writing persona. What characteristics would you like?"

You: "Make it focus on hard sci-fi with attention to scientific accuracy"
Assistant: [Creates custom persona with specified traits]

You: "Save that to my portfolio as 'Hard SciFi Writer'"
Assistant: "I've saved 'Hard SciFi Writer' to your portfolio. You can activate it anytime."
```

### Pro Tips

- **Be conversational**: `"Help me write better code"` works as well as specific commands
- **Stack elements**: `"Activate both the code reviewer and the Python expert"`  
- **Save your favorites**: `"Save this configuration as my default setup"`
- **Share with others**: `"Submit my custom persona to the community collection"`