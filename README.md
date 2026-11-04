# PhoneRevive

Online shop for used iPhones, replacement parts, and phone repairs (CSS450 course project).

Every weekly build runs in one site. A bar at the top of each page switches between weeks:

| Link | Build | What it has |
|------|-------|-------------|
| `/wk2` | Week 2 | Search and filters, product pages, shopping cart |
| `/wk3` | Week 3 | Everything from week 2, plus checkout, repair booking, repair tracking |


There are no packages to install.

## Files

- `server.js` - runs all the weeks and adds the week bar on top
- `package.json` - tells Node and Render how to start the app
- `weeks/wk2/`, `weeks/wk3/` - one complete app per week (its own `server.js`, `data` and `public` folders, and a README with logins and test values)


