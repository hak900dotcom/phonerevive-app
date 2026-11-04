# PhoneRevive (Final Build: Features 1 to 6)

Online shop for used iPhones, replacement parts, and phone repairs.

| # | Feature | Built in |
|---|---------|----------|
| 1 | Search and filters (phones and parts) | Week build |
| 2 | Product pages (phone detail and part detail) | Week build |
| 3 | Shopping cart (add, change quantity, remove, totals, 15-minute hold on phones) | Week build |
| 4 | Checkout (shipping form, test card payment, order confirmation) | Final build |
| 5 | Repair booking (instant price, drop-off time or mail in) | Final build |
| 6 | Repair tracking (status timeline, staff page to update it) | Final build |

## How to run it in VS Code

1. Install Node.js (version 18 or newer) from https://nodejs.org if you do not have it.
2. In VS Code, choose File > Open Folder and open the `phonerevive` folder.
3. Open a terminal (Terminal > New Terminal) and type:

   ```
   node server.js
   ```

4. Open http://localhost:3000 in your browser.
5. To stop it, click in the terminal and press Ctrl+C.

There are no packages to install. The app only uses what comes with Node.js. (`npm start` also works.)

To put the app online so others can open it, see [DEPLOY.md](../../DEPLOY.md).

## Logins and test values

- **Test card:** 4242 4242 4242 4242, any future date (like 08/28), any 3 digits. No real money is charged.
- **Staff PIN:** 2468 (Home page > Staff login). Change it in `data/settings.csv`.
- **Sample repair to track:** repair number `R-1001`, email `sam@example.com`.

## Data files (in the `data` folder)

| File | What it holds |
|------|---------------|
| phones.csv | Each used phone for sale. `status` changes to `sold` after checkout |
| parts.csv | Replacement parts. `stock` goes down after checkout |
| settings.csv | Shipping fee, free shipping amount, tax rate, phone hold time, repair labor fee, bookings per drop-off time, staff PIN |
| cart_items.csv | Shopping carts |
| orders.csv | One row per order (shipping address, totals, last 4 digits of the card) |
| order_items.csv | The items in each order |
| repairs.csv | One row per repair booking, with its current status |
| repair_updates.csv | Every status change and staff note, with the time. The tracking page is built from this |

The full card number and CVC are never saved. Restart the server after editing phones.csv, parts.csv, or settings.csv by hand.

## Things to try

- Add a phone and a part to the cart, click **Proceed to Checkout**, and place an order with the test card. The phone then shows as sold and the part stock goes down.
- Click **Place order** with an empty form to see the error messages.
- Go to **Repair**, pick iPhone 12 and Screen, and click **See price**. Book a drop-off time.
- After booking you land on the tracking page. Open **Staff login**, enter 2468, and move the repair to Received with a note. Refresh the tracking page to see it.
- Each drop-off time takes 2 bookings, then it shows as Full.

## Files

- `package.json` - tells Node and Render how to start the app
- `server.js` - the whole app (reads and writes the CSV files, builds every page)
- `public/style.css` - page styles (mobile first)
- `data/` - the CSV data files
