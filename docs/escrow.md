# Drivezzz with a smart contract: the full plan

2 November 2026. **On the real network since 6 November 2026** (`41tGxjd1fDPtPXJXk2cLMuitX6tixZA5XVPQefSe7xzf`). Sections 0 to 19 are the plan as you approved it, 20 the contract's results, 21 where
everything stood and how it went live; `docs/mainnet-checklist.md` has what's left.
On `main` since 4 November 2026, there is no separate branch any more. The version without a smart contract is commit `309d745`, and the private GitHub repository `no-smart-contract-version` stays that version. The code with the escrow is public at [github.com/1arrcy1/Drivezzz](https://github.com/1arrcy1/Drivezzz) since 11 November 2026, under the Drivezzz Source Licence (`LICENSE`).

---

## 0. In short
Riders pay each ride from their own Solana wallet (USDC or SOL) into a small program on the Solana blockchain: an escrow. The server never holds
anyone's coins. Per ride, the server can only pick one of three outcomes (pay out, 50/50, refund), and the money can only go to the rider who
paid, the driver and your fee address. If nothing happens for 30 days, the rider gets everything back, even if the server is gone.
You control the program through a page in the admin panel where you **connect Phantom**: no 12 words anywhere.

---

## 1. Everything decided so far
**Payments**
- USDC and SOL on Solana only. XRP, LTC and XLM are removed.
- No deposits, no balances, no withdrawals. Each ride has its own escrow.
- The address that pays is the address that gets refunds.
- Drivers need a connected Solana wallet to go online; payouts go there.
- €0.10 per ride paid out in full, in the ride's coin, taken from the driver's payout, to `6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN` (your profit). No fee
  on 50/50 or refunds.
- The rider pays the network fees and the escrow's deposit; the deposit goes back to the rider automatically.
- Minimum ride €0.50. No maximum.
- 50/50 with an odd amount: the rider gets the extra smallest unit.

**Ordering**
- Placing an order is free and touches no chain. A driver claims it → the rider is asked to pay → once paid, the driver is told to drive.
- Ride now: pay within 10 minutes of the claim, or the order is cancelled (not put back on the market).
- Planned (up to 7 days ahead): pay when a driver claims it, at the latest 30 minutes before pickup, or it's cancelled.
- An unclaimed ride now is cancelled after 2 hours. An unclaimed planned ride can be cancelled any time. Neither involves money.

**Cancelling**: see section 4.

**After the ride**
- 24 hours for either side to appeal; no appeal → paid out automatically.
- An appeal holds the money until an admin picks refund, 50/50 or pay out; no decision in 30 days → refunded automatically.
- A driver's appeal with at least 60 % of the route driven → pay out by default.
- Check-out from 200 m of the drop-off; the rider's phone beyond 500 m (or unknown) → a heads-up to both, nothing held.
- No check-out within 24 hours of the expected arrival → refund, unless the driver appeals.
- Driver no-show at the pickup → refund.

**The program**
- Written from scratch in Rust, as small as possible; tested against every known attack; no paid audit; source published.
- You can update it, with your Phantom wallet.

**Unchanged from before**
- Drivezzz checks no licences; drivers see the "Before you drive" notice once. The app is for all countries.
- Report, block, word filter, strikes (a week's ban each, three is permanent), support: all stay (Apple requires them).
- Bans now also cover the phone through Apple's DeviceCheck and every wallet address the person used.
- The App Review demo account keeps its own demo world, with no chain.

---

## 2. Money per ride
| What | Who pays | Amount | Comes back? |
| --- | --- | --- | --- |
| Ride price | Rider | The quote (≥ €0.50) | Per the outcome |
| Drivezzz fee | Driver's payout | €0.10 in the ride's coin | No, to you |
| Payment transaction | Rider | 0.000005 SOL (€0.001) | No |
| Settle transaction | Rider, through a small allowance in the escrow that pays back the server's wallet | 0.000005 SOL, at most 0.00001 | Unused part, to the rider |
| Escrow deposit (Solana's rent) | Rider | ~0.002 SOL (SOL ride), ~0.004 SOL (USDC ride) | Yes, to the rider when the escrow closes |

Prices are in euros. At payment the server fixes the exact USDC or SOL amounts (price, driver's part, the fee) and the escrow stores them, so the
program never needs a price. A planned ride paid in SOL pays the driver that SOL amount, whatever SOL is worth on the day.

**Why the server wallet needs ~0.01 SOL**: each settle transaction must be paid by whoever sends it: the server. That's 0.000005 SOL, which
the escrow pays back in the same transaction. So the wallet needs a small float once (0.01 SOL is 2,000 transactions' worth), and it never
runs down. It's not a cost per ride.

---

## 3. Rider flow
1. **Home**: Now or Plan a ride, Where to?, quote (unchanged). The coin choice shows USDC and SOL only.
2. **Order**: free. "Looking for a driver". Cancel any time, free.
3. **A driver claims it**: push notification "Anna took your ride: pay €5.16 to confirm", and a pay screen with a countdown (10 minutes, or
   until 30 minutes before a planned pickup). The cancel terms are shown here (section 4).
4. **Pay**: tap Pay → your wallet app (Phantom, Solflare, Trust or MetaMask) opens with the payment ready → approve → back in Drivezzz. WalletConnect is
   the second way, for other wallets. The server makes the transaction; the wallet only signs it. Shown: price, network fee (~€0.001), deposit
   (~€0.30, comes back).
5. **Paid**: the app waits for the chain (a few seconds), then "Paid: Anna is on her way". The ride works as today: follow the driver, check
   the plate, check in within 100 m.
6. **Drop-off**: the driver checks out. If you weren't near, you get the warning (section 6). 24 hours to appeal, then it's final.
7. **Wallet screen**: no balance. "On hold": each ride with its amount, state (paid, riding, 24 h to final, under review) and a link to the
   chain. Connected wallet and "Change wallet" stay.

## 4. Cancelling
| When | Result |
| --- | --- |
| Before a driver claims it, or before paying | Free, nothing on chain |
| Ride now, paid, the rider cancels | 50/50 |
| Planned and paid, the rider cancels 3 h or more before pickup | Refund |
| Planned and paid, the rider cancels less than 3 h before | 50/50 |
| The driver cancels | Refund |
| The driver doesn't show up at the pickup | Refund |
| No check-out within 24 h of the expected arrival | Refund, unless the driver appeals within those 24 h |

## 5. Driver flow
1. **Going online** needs a connected Solana wallet (and the vehicle, as today). For USDC rides the wallet needs a USDC account; the app
   checks and explains how to add USDC in Phantom.
2. **Claiming**: as today. Then "Waiting for the rider to pay" with the countdown. Not paid in time → "The rider didn't pay; the ride is
   cancelled", and the driver is free again.
3. **Paid**: push "Paid: start driving" (planned: "Paid: see you at 14:30"). Navigation as today.
4. **Check-out**: within 200 m of the drop-off. Then "€5.06 arrives in 24 hours" (price minus the fee) and a countdown in Wallet.
5. **Wallet screen**: "Pending payouts" with countdowns, "Paid" with links to the chain. No balance.
6. **Appeals**: as today, from the ride.

## 6. Check-out warning
Rider's phone within 500 m of the drop-off at check-out: nothing. Further away or unknown: to both, nothing held:
> "The rider wasn't near the drop-off when the driver checked out. This can be ignored if the rider's phone was off or the app was closed.
> If you didn't reach your destination, appeal within 24 hours."

---

## 7. The program
**Size**: aim 20 to 40 KB, written from scratch in Rust with the smallest library Solana offers (no big framework).

**Accounts**
- **Settings**, one: the server's signing key, the fee address, the USDC mint, the program's admin (your Phantom address).
- **Escrow**, one per ride, at an address made from the ride's number (so one ride can never have two): payer, driver, coin, driver's part,
  fee, allowance, created at. A USDC escrow also has a token account the escrow owns.

**Five actions**
| Action | Who signs | What it does |
| --- | --- | --- |
| `init` | Your Phantom | Creates the settings, once |
| `update` | Your Phantom | Changes the server key, fee address or admin |
| `pay` | The rider | Creates the escrow; moves price, allowance and deposit in |
| `settle(outcome)` | The server's key | Pay out, 50/50 or refund; closes the escrow, deposit to the rider |
| `expire` | Anyone, after 30 days | Full refund to the payer; closes the escrow |

**Outcomes**
| Outcome | Rider (the address that paid) | Driver | Your fee address |
| --- | --- | --- | --- |
| Pay out | deposit + unused allowance | price − the fee | the fee |
| 50/50 | half the price + deposit + unused allowance | half the price | – |
| Refund | the whole price + deposit + unused allowance | – | – |
Plus at most 0.00001 SOL back to the server's wallet for the settle transaction.

**The 30 days**: a blockchain doesn't act by itself, so the server sends `expire` on day 30. If the server is gone, anyone can send it (the app
has a button for the rider); it can only refund the address that paid. The time is fixed in the build: 10 minutes on devnet (to test it), 30
days on the real network.

**Checks** (each has a test)
- Every account checked: owner, correct derived address, signer where needed, the real USDC mint only (no fake tokens).
- Money only to the payer, driver and fee address stored in the escrow.
- Settled once; a closed escrow can't come back; one escrow per ride.
- Overflow-checked sums that must add up exactly.
- `settle` only by the server key; `init`/`update` only by the admin; `expire` only after the time and only as a refund.
- Attack tests: wrong signer, swapped or fake accounts, fake mint, fake escrow, double settle, early expire, other destination; plus random
  inputs (fuzzing). Source published.

**Updates**: the right to update the program belongs to your Phantom address (section 9).

---

## 8. Keys and wallets
**Never type your 12 words into a website, an app or a chat, ours included.** Nothing here asks for them.

| Wallet | What for | Where | SOL |
| --- | --- | --- | --- |
| Your Phantom | Admin of the program (update, settings), pays the deploy, receives the fee | Your phone/browser | ~0.6 SOL on deploy day, ~0.3 stays locked (refundable) |
| Server key | Signs pay out, 50/50, refund | The server, in its own file, passed by systemd like today's wallets; never printed | ~0.01 SOL once |
| Deploy key | Uploads the program in pieces, then only stays admin of the settings (for connecting another fee address on the panel) | The server, `/root/drivezzz-deploy-key.json` | 0.13 SOL once, what's left stays there |
| Devnet test keys | Testing | The server | Free test SOL |

The old wallets (`/root/drivezzz-wallets.json`, `/root/keys.txt`) are left untouched; you keep whatever is in them.

## 9. The admin page: "Smart contract" (connect Phantom)
A new page in the admin panel (admin login as today), which you open in Phantom's browser on your phone or in a browser with the Phantom
extension. You tap **Connect Phantom**; every action shows in Phantom for you to approve; the server never sees your keys.
- **Status**: program address, version, size, who can update it, the server key's SOL, the settings, devnet or real network.
- **Deploy (first time)**: (1) you approve one transaction that moves ~0.6 SOL to the temporary deploy key; (2) the server uploads the
  program in pieces; (3) you approve the final transaction, which makes your Phantom address the one that can update it. The temporary key's
  leftover SOL goes back to you, and it's deleted.
- **Update**: the same, with the new version: one approval to fund, one to switch.
- **Settings**: change the server key or fee address (one approval).
- **Top up the server key**: send it SOL (one approval).
- Every step is tried on devnet first, with Phantom in Testnet Mode.

## 10. Admin panel, other changes
- Rides show their escrow: address, amounts, state, links to the chain, the warning flag.
- Disputes: three buttons (refund, 50/50, pay out), with the 60 % rule and the GPS shown.
- Removed: deposits, balances, withdrawals, unmatched payments, stuck payouts, network switch (the program's address decides the network).
- A failed settle is simply retried: the program only allows one outcome per escrow, so retrying can never pay twice.
- Bans: phone (DeviceCheck) and wallet addresses shown and removable.

---

## 11. Server changes
**Removed**: `wallet.js` deposits, balances, withdrawals, payout sending; XRP/LTC/XLM in `coins.js`; the ledger for rides.

**Added**
- `escrow.js`: builds `pay` transactions for the app, reads escrows from the chain, sends `settle` and `expire`, retries safely.
- Order states: `open` → `claimed` (waiting for payment) → `paid` → ride as today → `checked_out` → `final` / `appealed` → settled.
- Jobs: payment deadlines (10 min / 30 min before), unclaimed after 2 h, settle 24 h after check-out, no check-out 24 h after expected
  arrival, `expire` at 30 days, retry of unsent settles.
- Cancel rules (section 4), check-out warning (section 6), 60 % rule.
- DeviceCheck (Apple's API, with an Apple key; I'd use the existing push key if it allows DeviceCheck, otherwise you make one in your Apple
  account) and wallet-address bans.
- Push: "pay to confirm", "waiting for payment", "paid: start driving", "not paid: cancelled", "arrives in 24 h", "paid out", "refunded",
  "the rider wasn't near the drop-off", "appeal decided".
- Prices from Kraken as today (SOL/EUR, USDC/EUR) to fix amounts at payment.
- Tests for every rule (the existing test suite, extended).

## 12. App changes
- Pay screen with countdown, terms, Pay (wallet app) and WalletConnect; "paid" confirmation from the chain.
- Driver: waiting-for-payment state, paid push, USDC account check, wallet required to go online.
- Wallet screen rebuilt: on hold / pending payouts / paid, no balance, no "Add crypto", no withdraw.
- Coin choice: USDC and SOL. Onboarding, order sheet and texts updated.
- Check-out warning and appeal from it. "Get my money back" button for a 30-day-old escrow.
- DeviceCheck token sent at sign-in.

## 13. Website and documents
- Terms: the new cancel table, escrow, 24 h appeals, 30-day refund, €0.10 fee, warning text. Privacy: wallet addresses and payments are public
  on Solana.
- Home page and onboarding: USDC and SOL only.
- `APP_STORE.md`: only the demo account sees demo drivers; all crypto goes through a smart contract on Solana and drivezzz.s3rver.nl never
  holds anyone's coins; review notes updated.
- README, CLAUDE.md: the new money rules.
- Store screenshots: the quote one shows "XLM" today, so it gets re-made.

---

## 14. Where it's built and tested
Your server has **1 CPU, 1 GB of memory, 21 GB free**, and no compilers. Two options:

| | Build on the server (as you asked) | Build on the Mac |
| --- | --- | --- |
| Needs | Install compilers (`build-essential`), Rust, Solana's tools (~3 GB), a 4 GB swap file | Rust and Solana's tools on the Mac (~3 GB; 269 GB free) |
| Speed | Slow (1 CPU), builds may run out of memory without swap | Fast |
| Live app | Competes with it for the one CPU while building | Not affected |
| Safety | Build tools run as a separate non-root user | Nothing on the server |

**My recommendation: build and test the program on the Mac**, and keep the server as it is: it doesn't need Rust at all, since the Node server
only talks to the chain (as it does today). The finished program is uploaded through the admin page (section 9). If you prefer the server,
I'll do it there with a separate user and a swap file.

**Test instance**: a separate devnet instance on the server (as in CLAUDE.md), never the live database.

## 15. Devnet test plan
1. **Tools** (Mac or server, your choice above). Devnet keys, free test SOL, our own test "USDC" coin on devnet.
2. **Program**: build, measure size, all tests and attack tests pass, deploy to devnet.
3. **Server** on a devnet test instance: everything in section 11, its tests pass.
4. **Admin page**: deploy and update the devnet program with your Phantom in Testnet Mode.
5. **App**: simulator, then your iPhone with Phantom in Testnet Mode (Settings → Developer Settings → Testnet Mode → Solana Devnet).
6. **Full check**, each on the explorer to the smallest unit:
   - [ ] Ride in SOL and in USDC, no appeal: driver price − the fee, you the fee, rider deposit and allowance back.
   - [ ] Paid ride now cancelled by the rider: 50/50. Planned: 3 h+ refund, under 3 h 50/50.
   - [ ] Driver cancels, driver no-show: refund.
   - [ ] Not paid in 10 min / 30 min before: cancelled, nothing on chain. Unclaimed after 2 h: cancelled.
   - [ ] Check-out with the rider far away: warning to both, still paid after 24 h.
   - [ ] No check-out: refund after 24 h; with the driver's appeal at 60 %+: paid out.
   - [ ] Admin decides refund, 50/50, pay out (once each).
   - [ ] `expire`: by the server, and by the rider's button with the server stopped.
   - [ ] Attack attempts against the deployed program fail.
   - [ ] Retrying a settle never pays twice.
   - [ ] Banned phone and banned wallet can't come back.
   - [ ] The demo account works without any chain.
   Pass: every box ticked, every amount exact, no escrow left open.

## 16. Going live
1. Back up the live server and database.
2. Admin page, real network: connect Phantom (~0.6 SOL in it), deploy, check address and size. ~0.3 SOL stays locked as the program's deposit.
3. Top up the server key with ~0.01 SOL; add USDC in your Phantom.
4. Switch server and app over; terms, `APP_STORE.md`, README live.
5. First real rides with small amounts, checked on the explorer.

## 17. Risks, honestly
- **No audit**: a bug could lock or misroute riders' money. Small code, many tests, devnet weeks and published source make it less likely,
  not impossible.
- **Your Phantom can update the program**: whoever has your Phantom's 12 words could rewrite it. Keep them offline; consider a separate
  Phantom account just for this.
- **The server key**: if the server were hacked, the attacker could only choose a different outcome for existing rides, between that ride's
  rider and driver. They can't send money anywhere else.
- **Legal**: a non-custodial escrow is the strongest position for no licence and no rider KYC, but not certain (the server decides the
  outcomes, and you can update the program). Drivers' tax details (DAC7) may still be needed.
- **Apple**: the organisation account is still advisable for anything with payments in crypto.

## 18. What I need from you
**Now**
1. Your OK on this plan (or what to change).
2. Where to build: **Mac (recommended)** or server (then: OK to install compilers, Rust and Solana's tools there under a separate user, and a
   4 GB swap file).

**During devnet**
3. Phantom in Testnet Mode on your phone, to test paying and the admin page.
4. Whether the push key can also be used for DeviceCheck; if not, make a DeviceCheck key in your Apple Developer account (I'll tell you where).

**Going live**
5. ~0.6 SOL in Phantom on deploy day, ~0.01 SOL for the server key, USDC added in Phantom.
6. Your go to switch the live server over.

## 19. Order of work
1. Program + tests + devnet deploy.
2. Server: escrow, orders, rules, jobs, tests.
3. Admin page with Phantom; admin panel changes.
4. App.
5. Full devnet check (section 15).
6. Documents, screenshots.
7. Real network, with you.

---

## 20. Devnet results (2 November 2026)
Built on the server (user `dzbuild`, Rust 1.99, Solana CLI 4.3.2, Pinocchio 0.12), deployed and tested on devnet.

- **Program**: `51WsotNgKe9Pk5AbtADz1P4oNDdpwqXWvVTfmih7x5oE`
  ([explorer](https://explorer.solana.com/address/51WsotNgKe9Pk5AbtADz1P4oNDdpwqXWvVTfmih7x5oE?cluster=devnet)),
  22,232 bytes since 3 November (the real network's deploy is sized to that), update right with the devnet deploy key `FZGC9kgANFFJK9j1N7AVnXMAGxZafMHQ21wUZUQ6SAb1`.
- **Test**: `contract/test/devnet.mjs`, **77 passed, 0 failed**: every outcome in SOL and USDC checked to the smallest unit, the 10-minute
  refund sent by a stranger, and every attack refused:
  - setting it up by anyone but the update key, setting it up twice, settings changed by anyone but the admin;
  - settling by anyone but the server key; paying another driver, fee address or rider; an unknown outcome;
  - settling twice, also twice in one transaction; paying the same escrow twice; nothing, or overflowing amounts;
  - an escrow address of another ride; the escrow as its own driver;
  - a fake token; token accounts of someone else; a look-alike vault (before and after the timeout); missing token accounts;
  - refunding early, or to another address.
  - Extra tokens sent to a vault don't block it: they go back to the rider when it closes.
- Error numbers: 1 wrong account, 2 not allowed, 3 bad data, 4 too early, 5 bad amount.
- **More on 3 November** (`contract/test/edge.mjs`): broken instructions and missing signatures; forged settings, escrows and vaults; a rider = driver wallet in every outcome; money sent in on top; odd amounts; three outcomes sent at the same moment (one lands, the money moves once); keys and the fee address changing mid-ride; a driver or rider closing or giving away their USDC account; the rent rule; compute and size limits; every way round the timeout.
- **The hole that found**: a rider could close their USDC account and send a tiny amount to the vault after the ride. The payout then failed every time, because the rider's part had nowhere to go, and after 30 days they'd get it all back: a free ride, also out of a 50/50. Fixed in the contract: the driver and fee address are paid regardless, and the rider's part waits in the vault for them. The server (`escrows.leftover`) sends it once they have an account again, and anyone can after the timeout.

### What it costs (real network; SOL €81.92 on 2 November 2026)
| | SOL | € |
| --- | --- | --- |
| Deploying, measured on devnet (same rates as the real network) | 0.11149 | ~€9.13 |
| of which locked as the program's deposit (back if the program is ever closed) | 0.11136 | ~€9.12 |
| Needed on deploy day besides that, for a few minutes (the upload's temporary account), then back | ~0.111 | ~€9 |
| Rider per ride: their transaction fee + the settle allowance | 0.00001 | ~€0.001 |
| Rider per ride: deposit, back when the escrow closes: SOL ride / USDC ride | 0.00136 / 0.00285 | ~€0.11 / ~€0.23 |
| Server key: a float that each settle pays back, except its priority fee of at most 0.000006 SOL | 0.01 once | ~€0.82 |

## 21. Where it stands

### Built and tested
- **Server**: payments, deadlines, settling, jobs, the 30-day refund, wallet bans. `npm test` passes on a pretend chain (44 tests).
- **Server and program together on devnet** (`contract/test/e2e-server.mjs`, 40 checks, all passed): SOL and USDC, Solana Pay and signed-in-the-app payments, refund, pay
  out to the smallest unit, nothing but this ride's payment sent on, an empty wallet told so, a driver's wallet without a USDC account stopped before paying.
- **Admin panel**: money page, three outcomes on appeals, holds and banned wallets on a user. Parsed and loaded; not clicked through yet.
- **App in the simulator, against a devnet instance**: order, driver waits with a countdown, rider's pay card and wallet list, a real devnet payment moves both
  phones on by themselves, on hold in Wallet, driver cancels and the refund lands.
- Website, terms, privacy, `APP_STORE.md`, README, CLAUDE.md updated (not deployed).

- **Manual control**, added after the plan: the admin panel can hold any paid ride, release it, or refund, split or pay it out now, with or without an appeal. Tested on devnet (`contract/test/checklist.mjs`, every amount on the chain) and by clicking the buttons on real devnet escrows.

### Not tested: needs your iPhone
Signing in a real wallet app can't be done in the simulator: Phantom, Solflare, Trust and WalletConnect paying are written to their documents but have never run.
**Trust is the biggest unknown**: its documents don't confirm `solana_signTransaction`. With Phantom in Testnet Mode (Settings → Developer Settings → Testnet
Mode → Solana Devnet) and the app on the test instance, pay one ride with each wallet you care about.

### Different from the plan
- **Paying**: each wallet is asked directly, through its own link or WalletConnect, and the server sends what it signed. On iOS a plain Solana Pay link opens
  whichever wallet the phone picks, and Phantom's send-it-yourself link is deprecated. The Solana Pay link and QR stay as an extra.
- **First deploy**: you send the SOL to a deploy address, the program is deployed from the server, and the update right goes to your Phantom. So no admin page with
  Phantom yet (section 9).

### Not built
- **The admin page with Phantom** (section 9). After the first deploy, your Phantom holds the update right, and using it needs that page or the Solana CLI with your key.
- **DeviceCheck** (section 11): needs an Apple key from you. Bans cover the app's own phone id and wallet addresses until then; reinstalling can get around the phone part.
- **"Get my money back" button** (section 12). The server sends the refund on day 30, and anyone can send it on the chain. A button in the app only matters with the server
  gone, and then the app can't load the ride either. A small public page would do that job better, if you want it.
- **Publishing the source** (section 7), and **new store screenshots**: the quote one still shows XLM.

### Added on 3 November
- **Tests on the final code, 3 November**: `devnet.mjs` 77 of 77, `edge.mjs` 131 of 131, `checklist.mjs` 489 of 489 on devnet, `npm test` 44 of 44. No wallet app has paid yet (see above).
- **After the 10-minute rule, 3 November**: `checklist.mjs` 491 of 491 and `e2e-server.mjs` all passed on the latest server. The real app paid a whole ride in the simulator on devnet, through the real WalletConnect relay with the scripted wallet: SOL answering with a signature, USDC with the whole transaction. Each paid out to the smallest unit, the fee was €0.10, and the rider's deposit came back. The escrow ride also ran on the driver side with moving GPS, up to a cancel before payment.
- **The order flow** (README, "Ordering" to "Cancelling", and the driver's "Cancelling"): 5 minutes to accept, offline without an answer; 5 minutes to pay while the driver can already set off; a full refund from a late driver until check-in, and 50/50 from the moment a ride for now is paid; 50% for a driver after 10 minutes stopped at the pickup, or from check-in on, frozen by an appeal. None of it touches the contract: nothing is locked before paying, and the server picks the outcome as before.
- **What can't go out**: a USDC outcome whose account is gone waits, tells that person once a day and shows the admin why. A SOL payment too small for an empty driver wallet is refused before paying, as Solana itself would refuse the payout. An emptied fee address shows on the money page.

### Going live
The live database has no balances, no open rides and no pending payouts (checked 2 November 2026), so nobody's money is in the way of switching.
1. **You**: test paying on your iPhone (above). Decide on an audit or small first limits: there has been no paid audit.
2. The fee address is `6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN`: it has a USDC account and SOL, so nothing is needed there (checked 3 November 2026). Never empty its SOL: without any, SOL payouts are refused.
3. The keys are made: `/root/drivezzz-deploy-key.json`, `drivezzz-escrow-key.json` and `drivezzz-program-key.json` (mode 600, never printed). The deploy key `7TyadkaYpmaoSNAaYwXPkXd6czu5wkMKxvrdeU4kM5at` has its SOL (0.243, received 3 November 2026). Rehearsed on devnet with exactly that: it used 0.118 SOL, and the buffer doesn't need its own money on top (the chain moves it over).
4. Back up the live database. **You** run `bash /root/drivezzz-go-live/go-live.sh <your Solana address>` on the server (`contract/go-live.sh`): it spends real SOL, so it's yours to run. It deploys the contract built without the devnet setting, sets it up (server key, fee address, real USDC, the fee address's USDC account, the server key's fees) and gives the update right to your address. The deploy key stays admin of the settings, so the panel can change the fee address; it has no right to update the program.
5. Take `PRETEND_CHAIN=1` out of `/etc/default/drivezzz` (the server refuses to start with both), put `ESCROW_PROGRAM_ID` in, `./deploy.sh` (it installs the service file that loads the key, so the key has to exist first), and check the admin money page says nothing is wrong.
6. Build the app for your iPhone: the old app doesn't work with this server. Try each coin with about €1 and check it on the explorer.
