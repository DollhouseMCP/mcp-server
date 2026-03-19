---
name: "Meeting Notes"
description: "Structured template for capturing meeting information, decisions, and action items"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "business"
tags: ["meeting", "notes", "documentation", "collaboration"]
variables:
  - { name: "meeting_title", type: "string", required: true, description: "Title of the meeting" }
  - { name: "meeting_date", type: "string", required: true, description: "Date of the meeting" }
  - { name: "meeting_time", type: "string", required: false, description: "Start time of the meeting" }
  - { name: "duration", type: "string", required: false, description: "Meeting duration", default: "60 minutes" }
  - { name: "meeting_type", type: "string", required: false, description: "Type of meeting (standup, review, planning, etc.)", default: "general" }
  - { name: "attendees", type: "string", required: true, description: "Pre-formatted attendee list, one per line with bullet points" }
  - { name: "agenda", type: "string", required: false, description: "Pre-formatted agenda items, numbered list" }
  - { name: "discussion_points", type: "string", required: false, description: "Key discussion points and summaries" }
  - { name: "decisions", type: "string", required: false, description: "Decisions made with rationale and impact" }
  - { name: "action_items", type: "string", required: false, description: "Pre-formatted table rows: | Action | Owner | Due Date | Priority |" }
  - { name: "next_steps", type: "string", required: false, description: "Pre-formatted numbered list of next steps" }
  - { name: "note_taker", type: "string", required: false, description: "Person who took the meeting notes" }
  - { name: "next_meeting_date", type: "string", required: false, description: "Date of the next meeting" }
---
# {{meeting_title}}

**Date:** {{meeting_date}}
**Time:** {{meeting_time}}
**Duration:** {{duration}}
**Type:** {{meeting_type}}

## Attendees
{{attendees}}

## Agenda
{{agenda}}

## Meeting Notes

### Key Discussion Points
{{discussion_points}}

### Decisions Made
{{decisions}}

### Action Items
| Action | Owner | Due Date | Priority |
|--------|-------|----------|----------|
{{action_items}}

### Next Steps
{{next_steps}}

## Follow-up
**Next Meeting:** {{next_meeting_date}}

---
*Notes taken by: {{note_taker}}*
