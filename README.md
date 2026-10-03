# Spot Rankings — USC × LA

A student-made guide to study spots around USC and Los Angeles, with a vintage global coffeehouse aesthetic.

## Features
- Live data from the public `SPOT RANKINGS` Google Sheet
- All LA / USC Campus / K-Town / Fryft Zone filters
- Search and sorting
- Detailed reviewer scores for Lena, Ashlyn, and Marc
- Personal favorites calculated from each reviewer’s own café ratings
- Responsive mobile layout
- **Study Wrapped**: log study sessions (live timer or after the fact), camera timelapses, a monthly
  Spotify-Wrapped-style recap, a study calendar, a friendly leaderboard and achievements — per rater

## Study Wrapped data
Everything lives in the existing Google Sheet, written by `google-apps-script.gs` (version 6+):

```
User (rater)
 └─ Sessions tab   Session ID · Person · Place · Area · Date · Start · End · Minutes · Status ·
                   Studied · Rating · Notes · Timelapse · Source · Started At · Updated At
     ├─ Location   Place + Area → the On Campus / K-Town / Fryft Zone tabs (or a new place, Area "Other")
     ├─ Photos tab (existing) rows with Photo Type "session" and the Session ID in column H
     └─ Timelapse  Cloudinary video link on the session row
 └─ Rating Log tab every rating from New Rating with the date it applies to
```

- Live sessions are saved as `active` when they start and `done` when they stop, so a session survives
  a refresh or a closed browser (and can be stopped from another device).
- Monthly Wrapped statistics, the calendar, leaderboard and badges are all computed from these rows on
  the fly — nothing is stored as a running total.
- Dates are the device's local calendar date when the session started; a session that crosses midnight
  belongs to the day it started.
- Timelapses use the browser camera (`getUserMedia`), capture a frame every few seconds while the tab is
  open (frames are kept in IndexedDB so a refresh doesn't lose them), and are rendered to video with
  `MediaRecorder` when the session stops, then uploaded to Cloudinary.
