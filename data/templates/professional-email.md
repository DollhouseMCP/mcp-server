---
name: "Professional Email"
description: "Business email template with proper formatting and tone"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "communication"
tags: ["email", "business", "communication", "professional"]
variables:
  - { name: "recipient_name", type: "string", required: true, description: "Recipient's name" }
  - { name: "recipient_title", type: "string", required: false, description: "Recipient's title or honorific (e.g. Dr., Mr., Ms.)" }
  - { name: "sender_name", type: "string", required: true, description: "Sender's name" }
  - { name: "sender_title", type: "string", required: false, description: "Sender's job title" }
  - { name: "company", type: "string", required: false, description: "Company name" }
  - { name: "subject", type: "string", required: true, description: "Email subject line" }
  - { name: "opening_paragraph", type: "string", required: false, description: "Opening paragraph with greeting context and purpose" }
  - { name: "body_content", type: "string", required: false, description: "Main email body with key points, context, and details" }
  - { name: "call_to_action", type: "string", required: false, description: "Closing request or next steps for the recipient" }
  - { name: "sign_off", type: "string", required: false, description: "Closing salutation (e.g. Best regards, Sincerely)", default: "Best regards," }
  - { name: "contact_info", type: "string", required: false, description: "Pre-formatted contact details, one per line (Email, Phone, LinkedIn, etc.)" }
  - { name: "confidentiality_notice", type: "string", required: false, description: "Optional confidentiality disclaimer text" }
---
Subject: {{subject}}

Dear {{recipient_title}} {{recipient_name}},

{{opening_paragraph}}

{{body_content}}

{{call_to_action}}

{{sign_off}}

{{sender_name}}
{{sender_title}}
{{company}}

{{contact_info}}

{{confidentiality_notice}}
