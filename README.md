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
Saved through `google-apps-script.gs` (version 6+) into two tabs it creates automatically:
- **Sessions** — one row per study session (who, where, date, start/end, minutes, rating, notes,
  photo links, timelapse link). Live sessions are saved as `active` when started and `done` when stopped.
- **Rating Log** — every rating submitted from New Rating, with the date it applies to.

Session photos and timelapse videos are uploaded to Cloudinary (same unsigned preset as spot photos).
Timelapses use the browser camera (`getUserMedia`), capture a frame every few seconds while the tab is
open, and are rendered to video in the browser with `MediaRecorder` when the session stops.

## GitHub Pages
This repository is a static website. Enable GitHub Pages in **Settings → Pages**, choose **Deploy from a branch**, then select **main** and **/(root)**.
