---
name: "Professional Email"
description: "Business email template with proper formatting and tone"
type: "template"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "communication"
tags: ["email", "business", "communication", "professional"]
variables:
  recipient_name:
    type: "string"
    description: "Recipient's name"
    required: true
  sender_name:
    type: "string"
    description: "Sender's name"
    required: true
  sender_title:
    type: "string"
    description: "Sender's job title"
    required: false
  company:
    type: "string"
    description: "Company name"
    required: false
  subject:
    type: "string"
    description: "Email subject line"
    required: true
  email_type:
    type: "string"
    description: "Type of email"
    default: "general"
    enum: ["general", "inquiry", "proposal", "follow-up", "introduction", "thank-you", "apology"]
  tone:
    type: "string"
    description: "Email tone"
    default: "professional"
    enum: ["formal", "professional", "friendly-professional", "casual-professional"]
outputFormats: ["text", "html", "markdown"]
includes: []
---

Subject: {{subject}}

Dear {{#if recipient_title}}{{recipient_title}} {{/if}}{{recipient_name}},

{{#if email_type == 'introduction'}}
I hope this email finds you well. My name is {{sender_name}}{{#if sender_title}}, {{sender_title}}{{#if company}} at {{company}}{{/if}}{{/if}}. {{#if introduction_context}}{{introduction_context}}{{else}}I am reaching out to introduce myself and explore potential opportunities for collaboration.{{/if}}
{{else if email_type == 'follow-up'}}
I hope you're doing well. I wanted to follow up on {{#if follow_up_context}}{{follow_up_context}}{{else}}our previous conversation{{/if}} and {{#if follow_up_purpose}}{{follow_up_purpose}}{{else}}see if you had any questions or needed any additional information{{/if}}.
{{else if email_type == 'thank-you'}}
I wanted to take a moment to thank you for {{#if thank_you_reason}}{{thank_you_reason}}{{else}}your time and consideration{{/if}}. {{#if thank_you_impact}}{{thank_you_impact}}{{/if}}
{{else if email_type == 'inquiry'}}
I hope this message finds you well. I am writing to inquire about {{#if inquiry_topic}}{{inquiry_topic}}{{else}}[topic of inquiry]{{/if}}.
{{else if email_type == 'proposal'}}
I hope you're having a great day. Following {{#if proposal_context}}{{proposal_context}}{{else}}our recent discussions{{/if}}, I'm pleased to present {{#if proposal_topic}}{{proposal_topic}}{{else}}this proposal for your consideration{{/if}}.
{{else if email_type == 'apology'}}
I am writing to {{#if apology_reason}}sincerely apologize for {{apology_reason}}{{else}}express my sincere apologies regarding the recent situation{{/if}}.
{{else}}
I hope this email finds you well. {{#if opening_context}}{{opening_context}}{{else}}I am writing to you regarding {{subject}}.{{/if}}
{{/if}}

{{#if main_content}}
{{main_content}}
{{else}}
[Main body of the email - include key points, context, and any necessary details. Keep paragraphs concise and focused.]

{{#if key_points}}
Key points to highlight:
{{#each key_points}}
• {{point}}
{{/each}}
{{/if}}

{{#if action_items}}
Action items:
{{#each action_items}}
{{@index+1}}. {{item}}{{#if deadline}} (Due: {{deadline}}){{/if}}
{{/each}}
{{/if}}
{{/if}}

{{#if email_type == 'proposal'}}
{{#if proposal_benefits}}
Benefits of this proposal:
{{#each proposal_benefits}}
• {{benefit}}
{{/each}}
{{/if}}

{{#if proposal_next_steps}}
Next Steps:
{{#each proposal_next_steps}}
1. {{step}}
{{/each}}
{{/if}}
{{/if}}

{{#if attachments}}
Please find attached:
{{#each attachments}}
• {{description}}
{{/each}}
{{/if}}

{{#if call_to_action}}
{{call_to_action}}
{{else if email_type == 'inquiry'}}
I would greatly appreciate any information you can provide regarding this matter. Please let me know if you need any additional details from my end.
{{else if email_type == 'proposal'}}
I would welcome the opportunity to discuss this proposal further at your convenience. Please let me know if you would like to schedule a call to go over any questions you might have.
{{else if email_type == 'follow-up'}}
Please don't hesitate to reach out if you have any questions or need clarification on any points. I'm happy to schedule a call at your convenience.
{{else if email_type == 'introduction'}}
I would love to connect and learn more about {{#if introduction_interest}}{{introduction_interest}}{{else}}your work and explore potential synergies{{/if}}. Would you be available for a brief call in the coming weeks?
{{else if email_type == 'thank-you'}}
{{#if thank_you_follow_up}}{{thank_you_follow_up}}{{else}}Please don't hesitate to reach out if there's anything I can do to support you in return.{{/if}}
{{else if email_type == 'apology'}}
{{#if apology_resolution}}{{apology_resolution}}{{else}}I am committed to ensuring this doesn't happen again and would appreciate the opportunity to discuss how we can move forward.{{/if}}
{{else}}
I look forward to hearing from you.
{{/if}}

{{#if closing_remarks}}
{{closing_remarks}}
{{/if}}

{{#if tone == 'formal'}}
Yours sincerely,
{{else if tone == 'professional'}}
Best regards,
{{else if tone == 'friendly-professional'}}
Kind regards,
{{else if tone == 'casual-professional'}}
Best,
{{/if}}

{{sender_name}}
{{#if sender_title}}{{sender_title}}{{/if}}
{{#if company}}{{company}}{{/if}}
{{#if contact_info}}

{{#if contact_info.email}}Email: {{contact_info.email}}{{/if}}
{{#if contact_info.phone}}Phone: {{contact_info.phone}}{{/if}}
{{#if contact_info.linkedin}}LinkedIn: {{contact_info.linkedin}}{{/if}}
{{#if contact_info.website}}Website: {{contact_info.website}}{{/if}}
{{/if}}

{{#if email_signature}}
{{email_signature}}
{{/if}}

{{#if confidentiality_notice}}
---
CONFIDENTIALITY NOTICE: This email and any attachments are confidential and intended solely for the addressee. If you have received this email in error, please notify the sender immediately and delete this message.
{{/if}}