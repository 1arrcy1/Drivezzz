# How many people the server can take

Measured on 5 November 2026 on the machine it runs on now: an LXC container with 3 cores of an i5-6600K (2015), 5.9 GB of memory and 24 GB of disk, sharing them with the live and test services. To measure again: `server/test/reference/capacity.mjs`, which says at the top how to run it.

## The answer

**On this machine: about 100,000 phones at once, in the best case.** It holds up to about 100,000 to 120,000, and at 150,000 it's full. That is the server alone: the things under "What this doesn't cover" come first.

Load from a Mac on the same network, on 10,000 drivers online within 30 km, 20,000 riders with 20 rides of history each per driver, and 2,000 rides going on.

| Phones | Requests a second | Waiting on open connections | Server CPU, of 3 cores | 95% of answers within | Out of the server | Result |
|---|---|---|---|---|---|---|
| 25,000 | 1,154 | 3,750 | 0.9 | 73 ms | 26 Mbit/s | fine |
| 50,000 | 2,308 | 7,500 | 1.5 | 59 ms | 52 Mbit/s | fine |
| 100,000 | 4,617 | 15,000 | 2.0 | 66 ms | 104 Mbit/s | fine, with 2 helpers |
| 150,000 | 6,925 | 22,500 | 2.9 | 444 ms | 156 Mbit/s | full, with 3 helpers: some requests time out |
| 200,000 | 9,233 | 30,000 | 2.9 | 25 s | 208 Mbit/s | too much |

What those phones were assumed to do is a guess: half looking at the map (every 30 s), a tenth driving (a position every minute, orders every 30 s, earnings every 2 minutes), a twentieth on a ride (a position every 15 s), everyone asking for a quote every 10 minutes, and idle riders asking for news every minute. Real people will differ. Since 8 November 2026 the apps ask more often (Pieter: drivers should be seen moving): the map every 10 s, a driver online every 15 s when moving, and coming or on a ride every 5 s when moving, so looks are three times and ride positions about three times what was measured here, and ride positions on disk grow with them. Not measured again yet. Waiting for news costs 12 KB of memory per phone, so 100,000 waiting phones are 1.2 GB.

Before this work, with 3,000 drivers online, a look at the map took 83 ms of CPU and 465 KB: about 12 looks a second, or a few hundred riders on the whole machine. Now it's 0.15 ms and 4.8 KB with 10,000 drivers.

## What this doesn't cover

None of these could be measured here, and each can stop things well before the server does.

- **OSRM, for quotes and routes.** It's the free public demo server, which asks for about one request a second and no commercial use. 100,000 phones would ask hundreds a second. It gets blocked, and quotes fall back to straight-line estimates. **Needed well before this: our own OSRM.** `OSRM_URL` is all that changes. The measurement above ran without road lookups.
- **Solana.** Once the contract is live, paying and paying out talk to a Solana server. The public ones have low limits, so this needs a paid one. On the pretend chain nothing of this runs.
- **What's in front of the server.** Traffic comes in through Cloudflare and a reverse proxy. That machine and the router have to keep a connection open for every waiting phone, and their limits weren't measured.
- **Disk.** 24 GB doesn't last. At the mix above, ride positions alone are about 330 rows a second, roughly 2 to 3 GB a day, kept 90 days. Backups need to keep up too (`server/deploy/backup.sh`).
- **Other work.** The background jobs were off in the measurement, the database was new and small, and it ran for minutes, not days.
- **Android and older iPhone builds** keep a connection open all the time. 100,000 of those are 4,000 requests a second for news alone instead of about 1,700, and 100,000 open connections.

## For real use at that size

Leave room for a peak or everyone reconnecting at once: not 2 of 3 cores busy, but well under half. That means something like 8 or more cores, 16 GB of memory and an NVMe disk of a few hundred GB. With the `WORKERS` setting, more cores simply mean more helpers. Beyond one machine, SQLite is the wall: all writing happens in one process on one disk, and the next step would be a real database server.

## What changed

- **Helpers** (`WORKERS`, `server/src/edge.js`): processes that answer what only reads (news, the map, orders, a driver's screen, quotes) and pass everything else on to the main process. All writing stays in one process, so a ride can't be claimed or paid twice. `WORKERS` unset is one process, as before. All tests pass both ways.
- **Online drivers in memory** (`onlineNow`), refreshed every 2.5 seconds; a booking asks for the latest.
- **One answer per neighbourhood** (`sharedLooks`): riders within a few square kilometres asking the same get one ready, compressed answer for 5 seconds (15 until 8 November 2026). A driver who's booked or goes offline leaves it at once (`forgetLooksOf`).
- **Fewer questions from the phone**: positions every 5 minutes when just looking, the map only refreshing when on screen, news by asking when nothing's going on, and no waking both phones for every position on a ride.
- **Writes**: a position within 15 m is no move (GPS wobble), and "last seen" goes in batches.
- **Queries**: missing indexes, a stats query that went through every finished ride, and a driver's screen that went through every online driver.

## Turning it on

The live server doesn't have any of this yet. `./deploy.sh` brings the code, and it runs as one process until `Environment=WORKERS=2` is added to `server/deploy/drivezzz.service`. The test server has it on.
