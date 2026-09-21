# Backend / Deployment — Come back to this later

Not needed to build the site (see CLAUDE.md). Fill in once known.

## Contact form → Wise Agent CRM

Leads from contact.html should land in Wise Agent, not just an inbox.

- Endpoint: `POST https://sync.thewiseagent.com/http/webconnect.asp`
- Required fields: `requestType=webcontact`, `CFirst`, `CLast`, `Source`
  (e.g. "Photography Website")
- Recommended fields: `CEmail`, `MobilePhone`; map the session-type
  dropdown to `Categories` or `Pipeline`
- Auth: OAuth 2.0 Bearer token in the `Authorization` header — generate
  from the Wise Agent account/API settings

**The token can't be called directly from client-side JS** (it would be
exposed in the browser). The form must POST to a small server-side
endpoint that holds the token and forwards the request to Wise Agent.

## Hosting

Site will be hosted on an AWS server via a personal contact (not Wise
Agent's own managed website product — that's a separate, unrelated
service). Ask the server owner:

1. What type of AWS resource is it? (EC2, S3, Lightsail, Elastic
   Beanstalk, other)
2. Direct SSH/shell access, or do files get handed off / uploaded another
   way?
3. Is a web server already running on it (Nginx, Apache), or is it blank?
4. Can a backend script/process run on it (Node.js, Python, PHP — to
   handle the contact form and forward to Wise Agent), or is it static
   files only?
5. Is a domain already pointed at it, or does DNS need to be set up?

## Once both are known

1. Stand up the server-side forwarding endpoint (framework depends on
   the AWS answer above — e.g. a small Node/Express route if it's an
   EC2 box with Node available, or a Lambda if it's S3-only).
2. Store the Wise Agent Bearer token as an environment variable on the
   server — never hardcode it or ship it to the client.
3. Replace the stubbed `console.log` in `scripts/main.js` (contact form
   handler) with a `fetch()` POST to that endpoint.
4. Point DNS at the server if not already done.
