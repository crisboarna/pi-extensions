---
"@crisboarna/pi-account-guard": patch
---

The tag checklist now scrolls when there are more zones than the terminal has rows. It drew every zone, so with 30 zones on a 24-row terminal the last ones and the key hint were off the screen and the cursor could move onto rows nobody could see. It now shows a window around the cursor, with "↑ N more" and "↓ N more" for the zones above and below.
