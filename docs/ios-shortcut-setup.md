# Jarvis → Apple Reminders: iOS Shortcut Setup

This shortcut checks Jarvis for new reminders and adds them to your **Work** list in the Apple Reminders app automatically.

---

## Before You Start

You'll need these two things:

| | |
|---|---|
| **Jarvis URL** | `https://jarvis.baileyobyrne.com` |
| **Jarvis Password** | `solar-atlas-cedar-ember` |

---

## Step 1 — Create a New Shortcut

1. Open the **Shortcuts** app on your iPhone
2. Tap the **+** button in the top right corner
3. Tap the name at the top (it says "New Shortcut") and rename it to **Jarvis Reminders**

---

## Step 2 — Add the First Action (Save Your Token)

1. Tap **Add Action**
2. Search for **Text** and tap it
3. In the text box that appears, type exactly: `solar-atlas-cedar-ember`
4. Tap the blue **Text** label on the action result pill
5. Tap **Add to Variable**
6. Name the variable `Token` → tap **Done**

---

## Step 3 — Fetch Pending Reminders from Jarvis

1. Tap **Add Action**
2. Search for **Get Contents of URL** and tap it
3. Tap the URL field and enter: `https://jarvis.baileyobyrne.com/api/reminders/ios-pending`
4. Tap **Show More** (below the URL)
5. Change **Method** to `GET`
6. Tap **Add new header**
   - Header field: `Authorization`
   - Value field: type `Bearer ` (with a space after it), then tap the **Variable** icon and select `Token`

---

## Step 4 — Parse the Response

1. Tap **Add Action**
2. Search for **Get Dictionary from Input** and tap it
   - It should automatically use the result from Step 3

3. Tap **Add Action** again
4. Search for **Get Dictionary Value** and tap it
5. Where it says **Value**, change it to `reminders`
6. Where it says **Dictionary**, make sure it points to the Dictionary from the previous step

---

## Step 5 — Loop Through Each Reminder

1. Tap **Add Action**
2. Search for **Repeat with Each** and tap it
   - Where it says **Items**, tap it and select the **Dictionary Value** from Step 4

Now you are inside the loop. Add the following actions **inside** the Repeat block (before "End Repeat"):

---

### Inside the Loop — Part A: Extract the Details

**Action 5a — Get the title:**
1. Tap **Add Action** (inside the loop)
2. Search for **Get Dictionary Value** and tap it
3. Change **Value** to `title`
4. Tap the result pill → **Add to Variable** → name it `RTitle`

**Action 5b — Get the notes:**
1. Tap **Add Action**
2. Search for **Get Dictionary Value** and tap it
3. Change **Value** to `notes`
4. Tap the result pill → **Add to Variable** → name it `RNotes`

**Action 5c — Get the due date:**
1. Tap **Add Action**
2. Search for **Get Dictionary Value** and tap it
3. Change **Value** to `due`
4. Tap the result pill → **Add to Variable** → name it `RDue`

**Action 5d — Get the ID:**
1. Tap **Add Action**
2. Search for **Get Dictionary Value** and tap it
3. Change **Value** to `id`
4. Tap the result pill → **Add to Variable** → name it `RId`

---

### Inside the Loop — Part B: Create the Reminder

1. Tap **Add Action**
2. Search for **Add New Reminder** and tap it
3. Set the fields as follows:
   - **Reminder:** tap and select the variable `RTitle`
   - **List:** tap and select **Work**
   - **Notes:** tap and select the variable `RNotes`
   - **Due Date:** tap and select the variable `RDue`

---

### Inside the Loop — Part C: Tell Jarvis It Was Synced

1. Tap **Add Action**
2. Search for **Get Contents of URL** and tap it
3. Tap the URL field and enter:
   `https://jarvis.baileyobyrne.com/api/reminders/`
   then tap the **Variable** icon and select `RId`
   then type `/ios-synced` immediately after (no spaces)

   The full URL should look like: `https://jarvis.baileyobyrne.com/api/reminders/[RId]/ios-synced`

4. Tap **Show More**
5. Change **Method** to `POST`
6. Tap **Add new header**
   - Header field: `Authorization`
   - Value: `Bearer [Token]` (same as Step 3)

---

## Step 6 — Done! Test It

1. Tap the **Play** button (▶) at the bottom to run it manually
2. Check your **Work** list in Reminders — new items from Jarvis should appear within a few seconds

---

## Step 7 — Automate It (Run Automatically)

To have this run automatically without you needing to open Shortcuts:

1. Go to the **Automation** tab in the Shortcuts app (bottom of screen)
2. Tap **New Automation**
3. Choose **Time of Day**
4. Set it to run at **8:00 AM** every day
5. Toggle off **Ask Before Running** so it runs silently
6. Select the **Jarvis Reminders** shortcut

You can also add a second automation at another time (e.g. 1:00 PM) for afternoon reminders.

---

## How It Works

- When you create a reminder in Jarvis, it sits in a queue marked "not yet synced to iOS"
- When the Shortcut runs, it fetches all unsynced reminders and creates them in your **Work** list
- Each reminder is then marked as synced so it won't be created twice
- Completing reminders: tick them off in the Jarvis dashboard — the Reminders app copy is just a notification

---

## Troubleshooting

**Nothing appears in Reminders after running the shortcut**
- Check that you selected **Work** as the list in the "Add New Reminder" action
- Make sure the URL in Step 3 is entered exactly as shown

**"Network connection" error**
- Your phone needs to have internet access (WiFi or mobile data) when the shortcut runs

**Reminders are duplicating**
- This means Step 5c (marking as synced) isn't completing — check the URL in that step includes `[RId]` as a variable, not typed literally
