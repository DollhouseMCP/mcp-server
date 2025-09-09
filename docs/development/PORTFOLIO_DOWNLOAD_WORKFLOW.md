# Portfolio Download Workflow Guide

## 🎉 NEW: Fuzzy Matching Support

The system now has **automatic fuzzy matching** for element names! You don't need to worry about exact formatting anymore.

### When User Says: "Download [persona name]" or "Get [persona] from my portfolio"

**SIMPLIFIED WORKFLOW:**

1. **Just download with the natural name (fuzzy matching will find it):**
   ```
   sync_portfolio 
     operation: "download"
     element_name: "[natural-name]"  
     element_type: "personas"
     options: {force: true}
   ```
   
   Examples that all work:
   - "verbose victorian scholar" 
   - "Victorian Scholar"
   - "verbose-victorian"
   - "victorian"
   
   The system will automatically match to "Verbose-Victorian-Scholar"!

2. **After successful download, reload the elements:**
   ```
   reload_elements 
     type: "personas"
   ```

3. **Finally, activate the persona:**
   ```
   activate_element 
     name: "[lowercase-name]"
     type: "personas"
   ```

## Common Name Format Issues

GitHub portfolio often stores personas with different formats than expected:
- **GitHub format**: `Verbose-Victorian-Scholar` (capitalized with hyphens)
- **Local format**: `verbose-victorian-scholar` (lowercase with hyphens)
- **Activation format**: Usually lowercase

## Example: Downloading "Verbose Victorian Scholar"

```
User: "Download the Verbose Victorian Scholar"

Step 1: Try download with likely name
sync_portfolio operation:"download" element_name:"Verbose-Victorian-Scholar" element_type:"personas" options:{force:true}

If not found...

Step 2: List available
sync_portfolio operation:"list-remote" filter:{type:"personas"}
// Look for "Verbose-Victorian-Scholar" in the list

Step 3: Download with correct name
sync_portfolio operation:"download" element_name:"Verbose-Victorian-Scholar" element_type:"personas" options:{force:true}

Step 4: Reload
reload_elements type:"personas"

Step 5: Activate
activate_element name:"verbose-victorian-scholar" type:"personas"
```

## Important Notes

1. **Always use `options: {force: true}`** for downloads to avoid confirmation prompts
2. **Always reload after downloading** - new elements won't be available until reload
3. **Activation uses lowercase** - even if GitHub name is capitalized
4. **Element type is always plural** - "personas" not "persona"

## Troubleshooting

### "Element not found in GitHub portfolio"
- Use `list-remote` to see exact names
- Check for capitalization differences
- Look for alternative naming (e.g., "creative-writer" vs "Creative Writer")

### "Cannot activate persona"
- Make sure you ran `reload_elements` after download
- Try lowercase version of the name
- Use `list_elements type:"personas"` to see local names

### "Already exists locally"
- Use `options: {force: true}` to overwrite
- Or activate the existing local version directly

## Complete Working Example

```javascript
// User: "Please download and activate the debug detective persona"

// Step 1: Try common formats
sync_portfolio({
  operation: "download",
  element_name: "debug-detective",  // Try lowercase first
  element_type: "personas",
  options: { force: true }
})

// If not found, try capitalized
sync_portfolio({
  operation: "download", 
  element_name: "Debug-Detective",  // Try capitalized
  element_type: "personas",
  options: { force: true }
})

// Step 2: After successful download
reload_elements({ type: "personas" })

// Step 3: Activate
activate_element({
  name: "debug-detective",  // Use lowercase for activation
  type: "personas"
})
```

## Key Reminders

- **sync_portfolio** is the ONLY tool for downloading from GitHub portfolio
- **install_content** is for the community collection, NOT personal portfolio
- **submit_content** uploads TO portfolio, doesn't download FROM it
- After any download, ALWAYS reload before activating