# Putting PhoneRevive online (free)

The site runs on **Render** from this GitHub repository. Render updates the site by itself whenever the repository changes.

## Render settings

- **Language:** Node
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Instance Type:** Free

These did not change when the week bar was added, so an existing Render service keeps working.

## After a change

1. Open your service on render.com and click **Events** (or **Logs**). A new deploy starts within a minute of the change reaching GitHub.
2. Wait for `PhoneRevive is running`. The next line lists the weeks it found, for example `Weeks: Week 2 at /wk2, Week 3 at /wk3`.
3. If no deploy starts, click **Manual Deploy > Deploy latest commit**.
4. Open your link. You should see the dark week bar at the top. If you still see the old page, press Ctrl+F5.

## Good to know

- **The first visit can be slow.** On the free plan the site sleeps after about 15 minutes with no visitors and takes 30 to 60 seconds to wake up.
- **Saved data resets.** When the site sleeps or restarts, the CSV files go back to what is in GitHub. Carts, orders and new repair bookings are cleared. The sample repair R-1001 in week 3 is always there.

## If Render says a file is missing

Each week needs its whole folder: `weeks/wk3/server.js`, `weeks/wk3/data/` and `weeks/wk3/public/`. If the log says `Missing data file` or `Cannot find module`, open the repository on GitHub and check that the files sit inside those folders and did not end up at the top level.
