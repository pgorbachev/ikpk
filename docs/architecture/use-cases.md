# Use Cases: ikpk.su

## UC-01: Visitor searches for a course

```
Actor:        Visitor (physician, student)
Goal:         Find a suitable seminar and learn the details
Precondition: Visitor has opened the website

Main scenario:
1. Visitor sees 3 institutes in the sidebar
2. Clicks on an institute → sees the list of course groups + instructors
3. Clicks on a course group → sees the list of seminars with status badges
4. Clicks on a seminar → sees:
   - Description, duration, certificate type
   - Nearest date, price, city
   - Instructor (photo, name → link to profile)
   - "Enroll" button

Alternative scenario (via schedule):
1. Visitor clicks "Schedule & Prices" in the sidebar
2. Sees a table of all upcoming seminars
3. Filters by institute / city
4. Clicks on a seminar → navigates to the detail page
```

## UC-02: Visitor searches for information via site search

```
Actor:        Visitor
Goal:         Quickly find the desired page
Precondition: Visitor is on any page of the website

Main scenario:
1. Clicks on the search icon (magnifying glass) in the header
2. A search input field opens
3. Types a query (e.g., "craniosacral")
4. Results appear as the user types:
   - Page title
   - Type (seminar / article / institute / course)
   - Text snippet with the match highlighted
5. Clicks on a result → navigates to the page

Alternative scenario (typo):
3a. Types "cranisacral" (typo)
4a. Pagefind returns results via fuzzy matching
```

## UC-03: Visitor enrolls in a seminar

```
Actor:        Visitor
Goal:         Submit an enrollment request for a seminar
Precondition: Visitor is on the seminar page

Main scenario:
1. Visitor clicks "Enroll" on the seminar page
2. A form opens: name, email, phone
3. Fills in the fields, clicks "Submit"
4. Sees a confirmation: "Your request has been submitted; we will contact you"
5. The request is saved in the CMS / sent via email

Alternative scenario (validation error):
3a. Leaves a required field empty or enters an invalid email
4a. Sees an error message next to the corresponding field
```

## UC-04: Visitor subscribes to the newsletter

```
Actor:        Visitor
Goal:         Subscribe to the email newsletter
Precondition: Visitor is on any page (form above the footer)

Main scenario:
1. Enters email in the subscription field
2. Checks the "I agree to data processing" checkbox
3. Clicks "Subscribe"
4. Sees: "You have successfully subscribed!"

Alternative scenario (no consent):
2a. Does not check the checkbox
3a. Sees: "Consent to data processing is required"
```

## UC-05: Visitor reads an article

```
Actor:        Visitor
Goal:         Read an article and discover related content
Precondition: Visitor is on the /statyi page or arrived via search

Main scenario:
1. Sees a list of articles (cards: image, title, date, excerpt)
2. Clicks on an article
3. Reads the full text with images
4. In the sidebar sees the publication date and 4 related articles
5. Clicks on a related article → navigates to it
```

## UC-06: Visitor watches a video

```
Actor:        Visitor
Goal:         Watch an educational video
Precondition: Visitor is on the /video page

Main scenario:
1. Sees a list of playlists (6 total)
2. Clicks on a playlist
3. Sees an embedded YouTube player with the playlist
4. Watches the video directly on the website

Alternative scenario (YouTube unavailable):
3a. Sees links to RUTUBE and VK
4a. Navigates to the alternative platform
```

## UC-07: Content manager updates the schedule

```
Actor:        Content manager
Goal:         Add a new seminar to the schedule
Precondition: Authenticated in Strapi (cms.ikpk.su/admin)

Main scenario:
1. Opens the «Schedule Entries» section in Strapi
2. Clicks «Create new entry»
3. Fills in: seminar (select from list), start date, end date,
   city, price
4. Clicks «Save» → «Publish»
5. Webhook triggers an Astro rebuild
6. Within 2–5 minutes the new seminar appears on the website
   (schedule + seminar page)
```

## UC-08: Content manager publishes an article

```
Actor:        Content manager
Goal:         Publish a new article
Precondition: Authenticated in Strapi

Main scenario:
1. Opens the «Articles» section in Strapi
2. Clicks «Create new entry»
3. Fills in: title, slug, author, content (WYSIWYG)
4. Uploads an image (drag-and-drop)
5. Fills in SEO fields: seo_title, seo_description
6. Clicks «Save» → «Publish»
7. Within 2–5 minutes the article appears on the website
```

## UC-09: Content manager edits a page

```
Actor:        Content manager
Goal:         Update text on a static page (payment, contacts, etc.)
Precondition: Authenticated in Strapi

Main scenario:
1. Opens the «Pages» section in Strapi
2. Finds the page (e.g., "Payment")
3. Edits the text in the WYSIWYG editor
4. Clicks «Save»
5. Webhook → rebuild → update on the website within 2–5 minutes
```

## UC-10: Administrator adds an editor

```
Actor:        Administrator
Goal:         Grant CMS access to a new team member
Precondition: Authenticated as admin in Strapi

Main scenario:
1. Opens Settings → Users
2. Clicks «Invite new user»
3. Enters email, selects the «Editor» role
4. The new user receives an invitation email
5. Sets a password and gains access to content editing
   (without access to settings and roles)
```

## UC-11: Administrator performs deployment and monitoring

```
Actor:        Administrator
Goal:         Update the website, verify availability, resolve issues
Precondition: Access to GitHub Actions and VPS

Scenario A — manual rebuild:
1. Opens GitHub Actions
2. Triggers the «Deploy» workflow manually (workflow_dispatch)
3. Sees status: build → rsync → done
4. Verifies the website in a browser

Scenario B — monitoring:
1. Receives an alert from UptimeRobot (website / CMS unreachable)
2. Connects to the VPS via SSH
3. Checks: systemctl status nginx, systemctl status strapi
4. Restarts the failed service
5. Reviews logs: journalctl -u strapi --since "1 hour ago"

Scenario C — Strapi update:
1. Connects to the VPS via SSH
2. cd /opt/cms && npm run upgrade:dry
3. npm run upgrade
4. npm run build && systemctl restart strapi
5. Verifies the admin panel in a browser
```
