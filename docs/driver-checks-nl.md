# Driver checks in the Netherlands: draft plan

Started as a draft on 5 November 2026; most of it is now built (`server/src/checks.js`, `drivezzz/Features/Checks/`), so read "As built" below first where the two differ. Pieter asked for it: "when going live, im focusing on the netherlands and here you need to check if a driver is allowed to drive". It should check the driver's ID and a photo of the person (a match of at least 70%), send anything that fails to a person, and read everything it needs from the ID by itself. Later he added: "how i would do the id check car check, and taxi check all automated".

No lawyer has read this. The law is my reading of the sources at the end. Where something is uncertain I say so, and the open questions are at the end.

## As built (5 November 2026)

Pieter's decision: everything that can be automatic is, and only what can't be confirmed goes to a person on the panel's Driver checks tab, with the reason. A driver who passes never reaches a person.

| Check | How | Without it, the driver waits for a person because |
|---|---|---|
| ID | The chip, signed by the state and answering our challenge | The chip isn't confirmed |
| Face | Matched on the phone, signed with App Attest | The match is low, or not from the real app |
| Chauffeurskaart | Scanned with the camera and read on the phone, signed with App Attest (the lines end in the photo's hash, `signedByApp`). The server compares the ID's surname, the number and date against what the scan read, a date at most 5 years off, words that say what it is, and the same number on another account | Any of these fails |
| Permit | The same scan. KvK's name must be on it, and the same permit under another KvK number is flagged. Drivers of one company share a permit and a KvK number, which is fine | Any of these fails |
| KvK | The API: found, not ended, SBI 49.32 | No answer or no key, which the hourly job retries, or any of these fails. Asked again every 30 days, as the permit ends with the registration |
| Car | RDW: passenger car, taxi, insured, APK, not exported. These tell the driver what's wrong; a person can't fix them | - |
| Plate | Read from the car's back photo on the phone and signed with App Attest, as anyone can type a taxi's plate | It wasn't read, or not by the real app. The driver's other car and approval stay |

**The RDW taxi flag is the permit's best proof.** The RDW only registers a car as a taxi with a KvK taxi registration and a Kiwa permit (rdw.nl, "Voertuig als taxi registreren"). It says someone had a permit then, not that they still do, and open data has no owner, so the plate photo and the permit's KvK name tie it to this driver.

**Real plates, 5 November 2026:** 43,245 cars are flagged as taxis, all of them passenger cars. 1,624 of those are exported, 428 of them still insured, which is why `exported` is a check of its own. 6,429 have an open recall, which isn't a reason to stop one. 1XSB61 went through the whole approval by itself with a pretend passport and app signature; 1KHS75 (exported), 82TGN7 (not insured), 31RVR9 (APK ran out) and 63SXLB (not a taxi) were stopped.

**What still gets through:** a good fake card, and a card Kiwa withdrew, as the date on it doesn't change. Only Kiwa can see those (decision 15), or the CDT from 2028.

**The screen (Pieter's decisions, 5 November 2026):** four steps: ID and selfie, chauffeurskaart, taxi permit, KvK. Agreeing isn't one of them: its page comes up once, before the first step someone taps, because the face match needs explicit consent. A driver with all of it is verified, shows a blue check (`VerifiedMark`) on their profile, in Profile and in riders' lists, and can go online. Someone with only a motor or scooter isn't asked and doesn't see the row.

**No "let a person compare my face" any more.** Pieter removed it as confusing. Two things follow. Section 4 says consent is only free if there's a real alternative, and this was that alternative, so a lawyer should look at it before real drivers use this. And a face that doesn't match goes to a person with only its score, as the selfie never leaves the phone: the panel's choices there are to ask for the ID and selfie again or to decide from the chauffeurskaart's photo. The server still has `/api/checks/face-photo` and `face_by_person`, which nothing in the app calls now.

**Not tried yet:** a real chauffeurskaart or permit. The words looked for are a guess from their names, so if real ones go to a person with "doesn't say what it is", widen `SCANS` in `checks.js`. App Attest needs a real iPhone: a simulator or Android always goes to a person. Without `KVK_API_KEY` every driver waits for a person on KvK.

## In short

- **This changes a product rule.** Until now: "Drivezzz checks no licences and is for all countries" (`CLAUDE.md`, Terms section 3, `APP_STORE.md` section 1 item 2). New: **in the Netherlands a driver can only go online after the checks below.** Elsewhere it stays as it is (`drivers.rules_seen_at`, the "You drive for yourself" page), unless Pieter decides otherwise (decision 2).
- **Dutch law for a car:** paid rides in a car are *taxivervoer*. The driver needs a **chauffeurskaart** (Kiwa), the business a **vergunning taxivervoer** (Kiwa) and a **KvK** registration, and the car must be **registered as a taxi at the RDW** (blue plates). The VOG, the taxi diploma and the medical statement are conditions for the chauffeurskaart, so checking the card covers them: **we never ask for a VOG or medical data.**
- **Motor and scooter:** my reading is that the taxi law doesn't cover them at all. It only covers a *personenauto op ten minste vier wielen*. A lawyer has to confirm this before NL motor and scooter rides go live (decision 3).
- **What can run with no person involved:**
  - **ID:** yes. The phone reads the passport or ID card's chip by NFC: the government's signature proves it's genuine, and the name, date of birth, expiry and photo come from the chip.
  - **The person:** yes. A selfie with a liveness check, matched against the chip photo.
  - **The vehicle:** yes. The RDW's open data says per plate whether it's a taxi, whether it's insured and until when its APK runs. We already call it.
  - **KvK:** yes, with KvK's paid API.
  - **Chauffeurskaart and taxi permit:** **not fully, today.** Kiwa has no public register or API. It only confirms "valid and issued by us" to employers and the police. So the app reads both documents and compares them with the ID, KvK and RDW, and approves by itself, until Kiwa agrees to something better (decision 15). A good fake or a withdrawn card gets through that (see As built).
- **Only a person says no.** The automatic part can approve, never decline. Anything that doesn't pass goes to the admin panel, like wallet changes do now. GDPR article 22 and the EU Platform Work Directive both point that way.
- **Build or buy:** buy the ID, selfie and face match from a vendor; build everything else. The face match and liveness are where fraud happens, and doing them ourselves would put biometric data on our own server.
- **Phasing:** phase 1 is the vehicle, KvK, document photos and manual review, without biometrics. It's quick to build and is how Uber does it today. Phase 2 adds the vendor's ID and face check with automatic approval. Phase 3 adds re-checks and the CDT (from 2028).

## 1. What Dutch law asks

### Cars: taxivervoer

The Wet personenvervoer 2000 (Wp2000) defines *taxivervoer* as "personenvervoer per auto tegen betaling, niet zijnde openbaar vervoer". An *auto* is "personenauto op ten minste vier wielen", for at most eight people besides the driver. Article 76 forbids taxivervoer without a licence from the minister (issued by Kiwa Register for the ILT).

| What | Who | What it means for us |
|---|---|---|
| **Vergunning taxivervoer** (the taxi permit, *ondernemersvergunning*) | Kiwa Register. It needs a KvK registration and a VOG, and is tested again every 5 years. About €300–340 to apply. | The driver holds one, or drives for a taxi company that does. The Rijksoverheid says a driver is either self-employed without staff or works for a permit holder. Per article 76 the *vergunningbewijs* must be in the car, visible to the rider. |
| **Chauffeurskaart** (the driver's card, the *taxipas*) | Kiwa Register. It needs a driving licence B, a **VOG** (taxi screening profile), the **chauffeursdiploma taxi** (CBR), and a **medical statement**. It's valid for 5 years. | Without it, nobody may drive a taxi. Riders must be able to see it in the car. Justis screens taxi drivers continuously: a new conviction leads to a new VOG request, and Kiwa or the ILT withdraws the card if it doesn't come. **So a valid card stands for a current VOG, diploma and health statement, and we don't ask for those.** |
| **KvK** | Kamer van Koophandel | Needed before the permit. A self-employed driver registers an *eenmanszaak*. |
| **Vehicle** | RDW | It's registered as a taxi, which gives a blue plate. It has a *keuringsbewijs taxi* (the RDW's inspection of the fittings) and a taximeter checked yearly by NMi (per Ondernemersplein), and is WA insured. |
| **Ride registration** | ILT | Until now the *boordcomputer taxi* (BCT). Since 1 July 2025 the **Centrale Database Taxivervoer (CDT)** can be used instead: rides and working hours go straight to the ILT, through a device or app of a connected ICT provider. **CDT is mandatory from 1 January 2028.** |
| **Tariffs, complaints** | Wp2000 art. 81, Rijksoverheid | The maximum tariff (2026: €4.31 start, €3.17/km, €0.52/min for up to 4 people) applies to the *opstapmarkt* (taxi ranks, hailing). Art. 81(2) leaves out a fixed price agreed in writing. A Drivezzz ride is ordered in advance at a price shown first, so the maximum most likely doesn't apply. **To confirm.** The driver must show a tariff card and have a complaints procedure and a disputes committee. |
| **Municipalities** | Art. 82, 82a, 82b | Cities may add rules for taxis offered on their streets (the opstapmarkt). Rides ordered in advance through an app are usually outside that. Amsterdam, Rotterdam, The Hague and Utrecht should each be checked before launch there. |

**The platform's own risk.** Article 75 says offering taxivervoer counts as performing it, unless the offer comes from "tussenpersonen die bemiddelen in dat vervoer". Drivezzz is that kind of go-between: drivers set their own prices. But in the UberPop case the court (CBb, 8 December 2014, ECLI:NL:CBB:2014:450) upheld the ILT's view that Uber was a *medepleger* (co-perpetrator) of its unlicensed drivers' offences. Uber settled the criminal case for about €2.3 million in 2019. A marketplace that knowingly lets unlicensed drivers take paid rides in the Netherlands carries that risk. That is the strongest reason for these checks.

### Motor and scooter

Taxivervoer needs an *auto*, a passenger car on at least four wheels. So under my reading a paid ride on a motor or scooter isn't taxivervoer: no permit, no chauffeurskaart, no blue plates. The RDW data fits this: all 43,245 vehicles marked as a taxi are *Personenauto* (queried 5 November 2026), with no motorcycle among them.

What still applies: a driving licence for the vehicle (A for a motor, AM for a moped), insurance that covers a passenger who pays (the WAM covers a passenger, but an insurer may refuse paid transport), a seat and footrests for the passenger, and helmets. KvK registration is still likely once someone does it to earn money.

**Uncertain:** whether the ILT sees it the same way, and whether any other rule (municipal or insurance) blocks it. This needs a lawyer before NL motor and scooter rides go live (decision 3).

### What can be checked automatically, and how

| Check | Source | Automatic? |
|---|---|---|
| ID document is genuine and not altered | NFC chip, *passive authentication*: the data groups are signed by the issuing state (ICAO 9303) | **Yes** |
| Name, date of birth, nationality, expiry | Chip DG1 (the MRZ data) | **Yes.** There's no address in it: Dutch documents don't hold one. |
| The person holding the phone is the person on the document | Selfie with liveness, compared with the chip photo (DG2) | **Yes**, by the vendor. Doubt goes to a person. |
| The vehicle is a taxi | RDW open data, `taxi_indicator` | **Yes**, free. We call this dataset already (`server/src/rdw.js`). |
| The vehicle is insured | RDW `wam_verzekerd` | **Yes.** It says insured, not that the policy covers paid rides. |
| The APK is valid | RDW `vervaldatum_apk` | **Yes** |
| The vehicle is a passenger car, not exported | RDW `voertuigsoort`, `export_indicator` | **Yes.** An open recall (`openstaande_terugroepactie_indicator`) stops nobody. |
| The plate in the photos is the plate entered | On-phone text recognition (Vision on iPhone, ML Kit on Android) of the back photo | **Yes**, signed with App Attest. Anything else goes to a person. |
| KvK registration is active, does taxi work, and the name matches | KvK API (Basisprofiel): status, SBI code 49.32 *taxivervoer*, owner name | **Yes**, a paid API. Whether it returns a sole trader's name is to be checked. |
| Chauffeurskaart is valid | Kiwa only: no public register | **Partly.** The app reads the card's number, name and expiry and compares them (see As built). Whether it's valid today needs Kiwa (decision 15). |
| Taxi permit is valid | Kiwa only, but the RDW only registers a taxi with one | **Mostly**: the RDW's taxi flag, plus KvK's name on the permit. |
| Owner or keeper of the vehicle | Not in RDW open data | **No.** It isn't needed if the vehicle is a taxi and the permit holder is named. |
| VOG, diploma, medical statement | Conditions for the chauffeurskaart | **Not asked** (see above) |

## 2. When it's asked

**The moment:** when a driver taps Drive for the first time with their position in the Netherlands. A driver can also start sooner, from a new row in Profile: "Driving in the Netherlands".

**How it fits what's there.** `POST /api/driver/online` in `server/src/drivers.js` checks in this order today: a vehicle (`need_car`), its photos (`need_photos`, `photosMissing`), USDC, a wallet (`need_wallet`), and not riding. The NL checks go after the photos and before the wallet, with a new error `409 need_checks` that carries `{ missing: [...], status }`. The app already shows the server's message (`AppState.goOnline`). For `need_checks` it opens the new checks sheet instead, at the first missing step, the same way `DriverRules` opens now when `rulesSeenAt` is nil (`Driving.swift`, `toggle()`).

- **In the Netherlands** the checks page replaces "You drive for yourself": finishing it also sets `rules_seen_at`.
- **Elsewhere** nothing changes: `DriverRules` and `rules_seen_at` stay as they are.
- **Where is "in the Netherlands"?** The server decides, from the position it's sent: a simplified border of European Netherlands (Natural Earth, public domain, or PDOK's *Landsgrens*), with a 1 km margin counted as inside, in `server/src/geo.js` as `inNetherlands(lat, lng)`. The Caribbean Netherlands have their own transport law and are left out.
- **Rides, not just going online:** accepting (`POST /api/rides/:id/accept`) and claiming (`/claim`) a ride whose **pickup** is in the Netherlands also needs approved checks. Otherwise a driver who went online just over the border could still take Dutch rides. The map and the market need nothing extra: an unchecked driver can't be online in the Netherlands.
- **Vehicles:** the check is per vehicle (prices, pets and seats already are). Activating a vehicle that isn't a taxi, or whose APK or insurance ran out, gives `need_checks` with `vehicle` missing. A motor or scooter in the Netherlands follows decision 3.
- **Demo accounts** (`users.is_demo`) skip it, as they skip the photos, so App Review can still try driving. The pretend drivers on the test and live servers pass through the fake mode in section 6.

**Drivers already online when it's switched on.** It runs behind a switch with a start date (`rules.nlChecksFrom`). From that moment:

- Drivers online in the Netherlands without approved checks go offline, with a push: "Driving in the Netherlands now needs a check. It takes about 10 minutes."
- Planned rides they claimed go back on the market, and the rider is told.
- Decision 11 is whether they get a grace period. While the live server is on a pretend chain, nobody real is affected.

**Afterwards, every night:** expiry dates are checked again (the ID, the chauffeurskaart, the permit's 5-year test, the APK) along with the RDW (taxi, insurance) and KvK (still active). Something that ran out puts the driver back on `need_checks` for that item, with a warning 30 days before. It never takes a driver offline in the middle of a ride.

## 3. The ID check

### The flow on the phone

1. **Consent.** One screen says what happens, who does it (the vendor, by name), what we keep and for how long, and that a person decides any no. It offers the alternative without a face scan (see section 4). An explicit "I agree" is recorded (`consent_at`, `consent_version`).
2. **The document.** A Dutch passport, ID card or (decision 12) driving licence; other EU documents work the same.
   - The camera reads the MRZ on the back of an ID card (the side without the photo; on a passport, the bottom of the photo page), or the driver types the document number, date of birth and expiry, to open the chip (BAC or PACE). After a scan the form shows only the number, for the driver to check and change. Not the name: it has no check digit and was too often read wrong (Pieter, 8 November 2026), while the chip gives it exactly, and that's the one shown ("Read from your ID's chip") and kept; the scan no longer waits for it either. Not the dates, which are printed on the ID card's front and made drivers think that was the side to scan (Pieter, 5 November 2026). Typing it in, the way out when scanning fails, does show them, and so does the chip refusing the details, so they can be checked against the front. The scan only hands over what it read the same way in 6 looks over two and a half seconds, with no close rival (`MRZTally`): two agreeing looks were too quick and took wrong numbers and dates. Names have no check digit: a filler at the end of a line, a passport's P<NLD on a short line, letters from other alphabets that look like ours, and a run of fillers read as K or C at the end are tidied away; a line that stops on a letter was cut short and gives no names; a surname that's the end of another one read lost its start and doesn't compete; and a name counts once it's read the same way 3 times and twice as often as any other (still parsed, not used). Measured on 672 spoiled pictures of ID codes, through Apple's reader on the Mac and Google's on an Android 16 emulator (7 November 2026): wrong numbers or dates at the end of a scan went from 2.7–4.9% to 0.3–0.7%, wrong surnames from 118–133 to 12–18 in about 570 scans. Nothing from the camera is sent: what counts is what the chip gives. The BSN, in the optional data of older documents, isn't looked at.
   - The driver holds the phone to the document and the chip is read. Passive authentication checks the signatures against the CSCA certificates. Chip or active authentication shows the chip isn't a copy.
   - The fallback is a photo of the document with text recognition and the vendor's checks for forgery. It's weaker, and always goes to a person.
3. **The selfie** with a liveness check (a short video or movement, against photos, screens, masks and injected video). It's matched against the **chip photo**: that photo is signed and good, unlike a photo of a printed one. In the app (both): look straight, turn one way and the other in the order the server asks, look straight again. An arrow in the circle says which way and four marks how far along; a turn counts from how the head was held looking straight; turning the same way twice says "the other way" rather than asking again for a way it won't take (that could get stuck before 7 November 2026); a tip comes after 8 seconds on one step; it gives up after 2 minutes (was 45 seconds). The face match runs SFace on each face and on its mirror image and adds the two, so it doesn't matter that the iPhone's selfie is mirrored and the chip's photo isn't (that cost score before). The result says what the phone found: a good match (0.40 or more, the server's `faceAutoMatch`, and the head turn seen) says "Your face matches your ID", with "A person confirms it once more" when the server can't take it by itself, as on Android without App Attest.
4. **The result** comes from the vendor's server to ours (a signed webhook), never from the phone, so a tampered app can't send "approved".

### What "a match of at least 70%" means

A face-match score isn't a percentage of likeness, and 70 on one vendor's scale says nothing about another's. A vendor's threshold is set for a **false match rate**: how often two different people would pass (for example 1 in 10,000), against how often the right person is refused. So the plan is:

- **Approve automatically** only when the vendor's decision is "match" at its high-confidence threshold, the liveness passed, and the document checks passed.
- **Anything between that and a clear "no match" goes to a person**, and so does a clear "no match". It's never declined automatically.
- We keep the vendor's score and decision with the check, so a person can see why. The threshold becomes a setting (`rules.faceMatch`), and the vendor's own guidance fills in what Pieter's "70%" means on its scale (decision 6).

### What's taken from the ID automatically, and what isn't

| Taken | Why |
|---|---|
| Surname, given names | To match the chauffeurskaart, permit and KvK, and to name the driver in the admin panel |
| Date of birth | Age and cross-checks. DAC7 needs it too (section 5). |
| Document type, issuing country, expiry | To ask again before it expires |
| The last 4 characters of the document number, and a hash of the whole number | To recognise the same document on another account without keeping the number |
| **Not kept** | **The photo, the selfie, biometric templates, the BSN, the MRZ's optional data, the full document number, the document image** |

**The BSN.** Dutch documents issued before August 2021 hold the BSN in the chip (DG1) and in the MRZ's optional data. Newer ones print it, and on the ID card it's in a QR code on the back. A private company may only use a BSN where a law allows it (Wabb). So:

- the optional data field is dropped on the phone or by the vendor, and never reaches us;
- the NFC path takes no picture of the document;
- the photo fallback must mask the BSN before anything is kept, or not be offered for documents that show it.

DAC7 may be the one exception (section 5).

### Build it ourselves, or a vendor

| | Build | Vendor |
|---|---|---|
| Chip reading | Feasible. [NFCPassportReader](https://github.com/AndyQ/NFCPassportReader) (MIT, iOS, BAC, PACE generic mapping, passive and active authentication) and [JMRTD](https://jmrtd.org) (LGPL, Android). Needs the CSCA certificate lists and testing on Dutch ID cards (one known issue with ID cards). | Included |
| Liveness | The hard part. Deepfakes and injected video need a certified (iBeta, ISO 30107-3) system, and open source ones are weak. | Included, certified |
| Face match | Apple's Vision finds faces but doesn't compare them. Open models like InsightFace's weights are for non-commercial use. We'd run biometrics on our own server. | Included |
| Cost | Weeks of work, ongoing upkeep, a much heavier DPIA | About €1–2 a check plus a monthly minimum |

**Recommendation: buy the ID, liveness and face match. Build the rest** (the vehicle, KvK, documents, manual review, the rules).

### Vendors (what I could find; get quotes and a DPA before deciding)

| Vendor | Where | NFC chip | Liveness and face | Price | EU data | iOS and Android SDK |
|---|---|---|---|---|---|---|
| **ReadID** (Inverid, now Signicat) | Enschede, NL; Signicat is Norwegian | The specialist: NFC is the product | Face match and liveness through the iProov add-on (UK) | Quote only. Old UK G-Cloud listings: £0.10–£3.95 a check. | To ask (Signicat is European) | Yes, native. Not public: ask through Signicat. No web SDK. |
| **Veriff** | Estonia | Yes, in the iOS SDK (DG1, DG2), "to be enabled" by them | Yes, iBeta-conformant liveness | **$0.80 / $1.39 / $1.89** a check, minimum **$49 / $99 / $209** a month. Retries are free. | Stored on AWS in **Ireland** by default. Kept 3 or 6 months by plan. | Yes |
| **Onfido** (now Entrust) | UK, US parent | Yes | Yes ("Motion") | Quote only. Estimates are $1.50–$3.50. | EU option said to exist; a US parent | Yes |
| **iDenfy** | Lithuania | Yes (since 2021) | Yes | $1.35 a check, $135 a month minimum | Not found: ask | Yes |
| **Sumsub** | UK and Cyprus | Not on the price page: ask | Yes | $1.35 a check, $149 a month minimum (Basic) | Not found: ask | Yes |
| **IDnow** | Germany | Yes (AutoIdent) | Yes | Quote only | Said to be in EU data centres | Yes |

**My pick to start: Veriff**. It's self-serve, has published prices with a low minimum, data in Ireland, and NFC plus liveness. **ReadID** is the one to ask in parallel: it's Dutch-made and the NFC specialist, but it's quote-only and the face match is an add-on. The choice is Pieter's (decision 4). Either way the server talks to the vendor through one small module (`server/src/idv.js`), so it can be swapped.

**Cost at launch:** a few dozen drivers a month at €1–2 each, so the monthly minimum ($49–150) is the real cost. Then the KvK API (a subscription plus a few cents a lookup) and nothing for the RDW.

## 4. Privacy and the stores

### The rules that apply

- **GDPR article 9:** a face match to identify someone is biometric data, a special category, forbidden unless an exception applies. The Dutch UAVG article 29 allows biometrics where "necessary for authentication or security". The Autoriteit Persoonsgegevens reads that narrowly: its examples are a nuclear plant and explosives at a port. It fined a company €725,000 for employee fingerprints. **So the basis is explicit consent (art. 9(2)(a)).** Consent is only free if there's a real alternative, so the plan offers one: identification through the driver's bank with **iDIN** (name, address, date of birth; €0.49–0.65 a check through CM.com) plus manual review of the chauffeurskaart. No face is scanned on that path.
- **Article 6:** for the rest (documents, vehicle, KvK) it's legitimate interest, art. 6(1)(f): keeping unlicensed taxis off the platform, and the platform's own legal risk.
- **Article 10 (criminal data):** we never ask for or keep a VOG.
- **Article 9 (health):** we never ask for the medical statement.
- **Article 22 (automated decisions):** a person decides every no. The privacy page's "Automatic decisions" section says so.
- **The BSN (Wabb):** never stored, and masked anywhere it could appear (section 3).
- **A DPIA is required** before starting: the AP's list includes biometric data. I can draft it; Pieter signs it as the controller.
- **The vendor is a processor:** a data processing agreement (*verwerkersovereenkomst*) is needed, along with its sub-processors (iProov in the UK has an adequacy decision; a US parent means the Data Privacy Framework or standard clauses).
- **The EU AI Act:** 1:1 biometric verification "the sole purpose of which is to confirm that a specific natural person is the person he or she claims to be" is excluded from the high-risk list (Annex III 1(a)). The vendor carries the rest.
- **The EU Platform Work Directive** (2024/2831, transposition due 2 December 2026; the Dutch *Wet platformwerk* was consulted June–August 2026 and will be late). Its rules on automated systems also cover self-employed drivers:
  - no 1:N biometric identification against a database (our 1:1 check is fine);
  - a DPIA;
  - telling drivers about automated systems;
  - a human decision for restricting or suspending an account.

  The plan already does all of this. The rest of that law (the presumption of employment) is a separate subject for Pieter's lawyer.

### What never reaches our server

The selfie, the chip photo, any face template, the document image in the NFC path, the BSN and the full document number. The vendor keeps its images only as long as needed for the decision and a possible appeal (decision 10: 30 days), and is told to delete them when the account goes.

### What we keep, and for how long

| Kept | How long |
|---|---|
| The status of each check, who decided and when, a decline reason, the vendor's session id and score | As long as the account exists |
| Name, date of birth, document type and expiry, the last 4 characters and a hash of the document number | As long as the account exists |
| Chauffeurskaart number and expiry; permit number, holder and expiry; KvK number | As long as the account exists |
| Photos of the chauffeurskaart and permit | Encrypted, outside the database's backups, deleted 30 days after the decision |
| The RDW answer per vehicle (taxi, insured, APK date) | With the vehicle |

On deleting the account, `forgetPerson` in `server/src/auth.js` removes all of it and asks the vendor to delete its session. The exception is decision 10: whether a decline for fraud stays with the phone's record, like strikes do.

### Pages to change (when it's built, not now)

- **`server/public/privacy.html`:**
  - new rows in "What we keep" for identity checks;
  - the vendor and Kiwa in "Others we use";
  - where the vendor's data is ("Outside the EU");
  - "Automatic decisions" (approval is automatic, a no is a person);
  - "Your permissions": the camera and NFC. Today it says the app "asks for no access to your library or camera", which will no longer be true;
  - "Deleting your account".
- **`server/public/terms.html`:**
  - Section 3 says "We don't check licences": in the Netherlands we will. The "Checked" mark gets a new meaning (taxi, insured, APK).
  - Section 8 (drivers) gets what's checked, that keeping it valid is the driver's job, and that we may take a driver offline when something runs out.
  - Drivers must be told at least 15 days before (section 15).
- **`server/public/index.html`** (Drive) and **`support.html`:** what a driver needs in the Netherlands.
- **`APP_STORE.md`:** section 1 item 2 ("drivers' responsibility, available everywhere") changes, along with the App Review notes and the privacy label.

### App Store and Google Play

- **Apple 5.1.1:**
  - the privacy policy covers this collection (i);
  - consent comes before collecting (ii);
  - only what's needed (iii): drivers outside the Netherlands aren't asked;
  - deletion takes it all (v).
- **Apple 5.1.2(vi):** face data may not be used for marketing or data mining. It isn't.
- **The privacy label** gets: *Sensitive Info* (biometric data, collected by the vendor's SDK in our app); *Contact Info: Name*; *User Content: Photos* (documents); *Other Data* (date of birth, document details). All linked to the user, for app functionality.
- **iOS needs:**
  - the NFC Tag Reading capability on the App ID;
  - `NFCReaderUsageDescription`;
  - `com.apple.developer.nfc.readersession.iso7816.select-identifiers` with `A0000002471001` (eMRTD);
  - `NSCameraUsageDescription`.

  Pieter's iPhone 13 Pro Max can read chips; every iPhone since the 7 can.
- **App Review:** a demo account still drives without the checks (`is_demo`). The review notes say the checks exist and which countries they cover.
- **Google Play:**
  - the Data safety form (personal info, photos, and what the vendor collects);
  - the *Personal and Sensitive User Data* policy: a prominent disclosure in the app before the camera and the check, consent by a distinct tap, and the privacy policy linked in the app;
  - camera permission at runtime; NFC needs no prompt.

## 5. Close to this, but not part of it

- **DAC7 (tax reporting by platforms).** It covers "personal services", and transport is one of them, with no lower limit for those. My reading is that Drivezzz must collect each Dutch driver's name, address, date of birth and **tax number (the BSN)**, verify them, and report yearly to the Belastingdienst. That would be the one law that lets us keep a BSN, for that report only and apart from the ID check. The ID check gives the name and date of birth; the address comes from iDIN or is typed. **Uncertain:** needs a tax adviser, including how crypto and cash rides count (decision 13).
- **CDT from 1 January 2028:** every taxi ride registered at the ILT. A driver can use any connected app, but Drivezzz could become a connected ICT provider so its rides register themselves. The ILT's interface covers assigning a driver and checking their driving licence (contact `cdtaansluiting@ILenT.nl`). That's a project of its own (decision 14). It could also become the way to see that a driver is licensed. **Uncertain:** the ILT's interface documents gave 404s here.
- **Receipts and the tariff card:** a Dutch taxi rider can ask for a receipt. The ride's page could give one with the driver's KvK name and permit number. The driver's tariff card could be their Drivezzz prices.
- **The EU wallet (EDI-wallet):** the Netherlands must offer one by the end of 2026, and most companies will have to accept it. Once a driver can share their identity from it, that could replace the chip and selfie. Later.

## 6. What changes where

### Server (`server/src`)

- **`db.js`:**
  - a new table `driver_checks`, one row per driver and country: `status` (none, pending, review, approved, declined, expired), each item's status, the fields in section 3, `consent_at`, `consent_version`, `submitted_at`, `decided_at`, `decided_by` and `decline_reason`;
  - `check_documents` (id, user_id, kind, file, delete_after);
  - new columns on `cars`: `rdw_taxi`, `rdw_wam`, `rdw_apk_until`, `rdw_checked_at`;
  - the admin's decisions in `log`, as now.
- **`geo.js`:** `inNetherlands(lat, lng)`.
- **`rdw.js`:** `lookupPlate` already gets the whole RDW row. It also returns `taxi`, `insured`, `apkUntil` and `passengerCar`, and the vehicle check uses those.
- **New `checks.js`:**
  - `nlMissing(user, car)`;
  - the routes `GET /api/checks`, `POST /api/checks/consent`, `POST /api/checks/id/session` (opens a vendor session and returns the SDK's token), `POST /api/checks/id/webhook` (signed by the vendor), `POST /api/checks/documents` (chauffeurskaart, permit), `POST /api/checks/kvk`;
  - the nightly re-check.
- **New `idv.js`:** the vendor, behind one small interface, with `IDV_FAKE=1` for the test server: `/dev/idv?user=&result=pass|review|fail`, like `/dev/pay`.
- **`drivers.js`:** `need_checks` in `POST /api/driver/online` and in activating a vehicle; `ownDriver` gets `checks: { nl: { status, missing } }`.
- **`rides.js`:** the same check in accept and claim for a pickup in the Netherlands.
- **`auth.js` (`forgetPerson`):** removes the check data and files, and asks the vendor to delete.
- **`config.js`:** `rules.nlChecksFrom`, `rules.faceMatch`; `IDV_VENDOR`, `IDV_API_KEY`, `IDV_WEBHOOK_SECRET`, `KVK_API_KEY`; a folder for the document photos outside `PHOTO_DIR`.
- **`edge.js`:** none of these routes is a read-only hot path, so all stay in the main process.

### Admin panel (`server/admin`, `server/src/admin.js`)

- A **Driver checks** tab with a count, like Wallet changes. It lists Waiting, Approved, Declined and All. Per driver it shows:
  - the vendor's result and score;
  - the name and date of birth from the chip next to the names on the chauffeurskaart, permit and KvK;
  - the document photos;
  - the RDW answer per vehicle;
  - how many drives they've done.
- **Approve, Decline (with a reason the driver sees), or Ask again** for one item. `notify()` tells the driver, as for wallet changes. Until it's decided the app lists what's still open in plain words (Pieter, 8 November 2026: "only give info as in waiting for review or please scan this document again"): what waits for review, from the moment it's sent, never why (`open` in `GET /api/checks`; the reasons stay on the panel). Nothing is asked for again by itself, only by a person after review (Pieter: "only after review"): what the phone reads from a real card missed its words, number or date too often to tell a bad photo from a good one, and a first try at asking by itself asked for a good permit again right after it was sent; once approved every row shows Done; after Ask again it says what to send and the note (`again`, `note`, `driver_checks.asked_again`) instead of that list, until it's sent. A row that's Done is locked with a check (Pieter, 8 November 2026), except what runs out within 30 days (`renew`) and everything after a decline. The driver's own data and every sync carry a summary (`checks`: status, what a person asked again, and `open`, always 0 now, `checksSummary`), which Profile and the Driving tab turn into "what still needs attention", which reloads an open checks screen, and from which a phone without push says a change itself. Reaching a person sends a notification.
- The vendor's images stay at the vendor. Either the panel fetches them for the person looking, without keeping them, or the panel links to the vendor's own review screen (decision 9).
- Users page: the check status per driver.

### iPhone (`drivezzz/`)

- **New `Features/Driver/DriverChecks.swift`**, a sheet with steps that shows what's done and what's waiting:
  - consent, then the ID through the vendor's SDK as a full-screen cover (not over the map);
  - the chauffeurskaart, photographed with VisionKit's document camera, its number and expiry read on the phone (the Vision framework) and shown to confirm;
  - the permit (number plus a photo or PDF), then the KvK number;
  - each vehicle's RDW result;
  - at the end, "We're checking", usually within a day, with a push when it's done.
- **`Driving.swift`:** on `need_checks` it opens this sheet instead of showing the error. **`DriverRules.swift`** stays for outside the Netherlands.
- **Profile:** a "Driving in the Netherlands" row to start or see it at any time.
- **`VehiclePage.swift`, `MyPage.swift`:** "Taxi · insured · APK until …" instead of "Checked" for a Dutch plate, and a warning pill when one of those is missing.
- **`Core/Models.swift`:** the new fields as optionals, as always.
- **The project:** the NFC capability, the Info.plist keys from section 4, the vendor's Swift package.
- **Smoothness:** the sheet holds its own state (a child, not the map's screen), and shows what it has at once and loads after sliding up, like `DriverProfileView`.

### Android (`android/`)

The same flow with the vendor's Android SDK (`features/DriverChecks.kt`), plus:

- the NFC permission in the manifest;
- CameraX with ML Kit's on-device text recognition, using the bundled model so no image leaves the phone for reading.

Apple first: until Android has it, an Android driver in the Netherlands gets the server's `need_checks` message and can't go online there. Add it to "Waiting for Android" in `docs/android.md`.

### Tests

- **New `server/test/checks.test.js`:**
  - going online in the Netherlands without checks gives `need_checks`; outside it, it works as now;
  - a pickup in the Netherlands needs checks to accept and claim;
  - the webhook's signature;
  - a pass approves; a review or a fail waits for a person and never declines;
  - the admin's approve, decline and ask-again;
  - expiry puts a driver back on `need_checks` but not during a ride;
  - the RDW taxi fields are parsed;
  - `forgetPerson` removes it all;
  - demo accounts skip.

  Run with `WORKERS=2` too.
- A scripted fake vendor in `server/test/reference/`, like `wc-wallet.mjs`.
- **In the simulators**, on the test server with `IDV_FAKE=1`: a pass, a review, a fail. The NFC reading itself only works on a real phone: on Pieter's iPhone with his own ID, at his go.

### Test server and live server

- **Test server:** `IDV_FAKE=1`. `contract/test/test-driver.mjs` passes its own checks through `/dev/idv`, so the four pretend drivers near Den Haag keep working. Its pretend plates aren't taxis, so the fake mode also skips the RDW taxi check.
- **Live server**, while it's on the pretend chain: the real checks since 6 November 2026 (Pieter: "i want to move to live"; deployed that day). Only its own four pretend drivers still pass pretend: `POST /api/checks/fake` answers there only to a connection from the server itself (127.0.0.1, nothing passed on by Cloudflare or a helper process), and marks the pass `fake-local-…` (`config.checks.fakeLocal`). At every start `dropPretendPasses` removes any other pretend pass, so an account that passed pretend before does the real checks; on the real network no pretend pass is left at all. Without `KVK_API_KEY` every driver who sent all four lands on the panel's Waiting list for a person. The app has no test buttons for this any more.

## 7. Phasing

| Phase | What | Needs |
|---|---|---|
| **0. Decisions and law** | Pieter's decisions below; a lawyer on Wp2000 art. 75, the UberPop risk, motor and scooter, and the Terms; a tax adviser on DAC7; Kiwa asked about verification; the DPIA; a vendor and its DPA. Drivezzz's own KvK registration (also needed for the App Store organisation account). | Pieter |
| **1. Without biometrics** | NL border, `need_checks`, the RDW vehicle check, the KvK API, photos of the ID's front (BSN masked), chauffeurskaart and permit, and manual review on the panel. Everything waits for a person. | About a week on server and iPhone, then Android |
| **2. Automatic ID** | The vendor's NFC, liveness and face match; automatic approval when every item passes; iDIN as the path without a face scan. | Phase 0's vendor, DPA and DPIA |
| **3. Keeping it valid** | The nightly re-checks; optionally a selfie now and then when going online, against account sharing (decision 8); CDT by 2028 (decision 14); Kiwa verification if they agree; the EU wallet later. | — |

Phase 1 is close to what Uber does today in the Netherlands: drivers upload their chauffeurskaart, permit and licence, and Uber checks them. It's lawful to launch with, and phase 2 then takes the waiting away.

## 8. Decisions for Pieter

| # | Decision | My advice |
|---|---|---|
| 1 | **The rule changes:** in the Netherlands we check before going online. From when? | Yes, behind a switch with a date, before real money |
| 2 | **Other countries:** stay open as now (the driver's own responsibility), or the Netherlands only at launch (also in App Store Connect's countries) | The Netherlands only at launch is the safest. Other countries keep the current page if you keep them. |
| 3 | **Motor and scooter in the Netherlands:** allow with ID, licence and RDW checks only, or not at launch | Not at launch, until a lawyer agrees with my reading |
| 4 | **Vendor** | Veriff to start, ReadID asked in parallel |
| 5 | **Build or buy** | Buy the ID, liveness and face; build the rest |
| 6 | **What "70%" means** | The vendor's high-confidence "match" approves; anything less goes to a person; nothing is declined automatically |
| 7 | **A path without a face scan** (iDIN plus manual review) | Yes: it's what makes consent free |
| 8 | **Selfie re-checks** now and then when going online, against someone else driving on a checked account | Later (phase 3); it means keeping biometric data longer |
| 9 | **Where a person reviews:** our panel (images fetched from the vendor, not kept) or the vendor's own dashboard | Our panel, fetching on demand |
| 10 | **Retention:** vendor images 30 days after the decision? Does a decline for fraud stay on the phone's record? | 30 days; yes for fraud, like strikes |
| 11 | **Drivers already online at the start:** a grace period, or straight away | Straight away (there are no real drivers yet) |
| 12 | **The Dutch driving licence as the ID** (it has a chip too) | Passport and ID card first; the licence if the vendor reads it |
| 13 | **DAC7:** ask a tax adviser, and collect the BSN apart from the ID check for that report only, if it's required | Ask first |
| 14 | **CDT 2028:** become a connected ICT provider, or leave it to the drivers' own apps | Decide in 2027; the drivers' own apps until then |
| 15 | **Kiwa:** ask whether a platform may check that a chauffeurskaart and permit are valid (by email, phone or an API) | Yes, ask now: it's the one check that can't be automated today |
| 16 | **Drivers for a taxi company** (the permit is the company's, the chauffeurskaart theirs) | Allow: the permit holder's KvK must match the permit |

## Not verified, or uncertain

- That motor and scooter rides fall outside the Wp2000 (my reading of article 1 and the RDW data).
- That the maximum tariff doesn't apply to app rides with a price agreed beforehand.
- Whether Kiwa will verify for a platform, and whether any public register of permits exists. The CDT's interface documents gave 404s.
- KvK API prices and whether a sole trader's name comes back.
- Every vendor's data location except Veriff's; NFC at Sumsub; ReadID's prices.
- DAC7's reach over crypto and cash rides, and whether it lets us keep the BSN.
- When the Dutch *Wet platformwerk* takes effect.
- A reported delay of the AI Act's Annex III to December 2027.
- Chip reading of Dutch ID cards with the open-source libraries (a known issue with ID cards, not tested).

## Sources

Law and government:

- [Wet personenvervoer 2000](https://wetten.overheid.nl/BWBR0011470/) (articles 1, 75, 76, 79–82; version from 1 July 2026)
- [Rijksoverheid: what a taxi driver needs](https://www.rijksoverheid.nl/vraag-en-antwoord/taxi/wat-moet-ik-hebben-om-als-taxichauffeur-te-werken)
- [Rijksoverheid: applying for a chauffeurskaart](https://www.rijksoverheid.nl/vraag-en-antwoord/taxi/hoe-vraag-ik-een-chauffeurskaart-taxi-aan)
- [Ondernemersplein: starting a taxi business](https://ondernemersplein.overheid.nl/stappenplan-taxibedrijf-starten/)
- [Ondernemersplein: the new registration system (CDT)](https://ondernemersplein.overheid.nl/wetswijzigingen/taxis-krijgen-nieuw-verplicht-registratiesysteem/)
- [Rijksoverheid: registering taxi rides](https://www.rijksoverheid.nl/onderwerpen/taxi/registreren-taxiritten-en-arbeidstijden)
- [Rijksoverheid: taxi costs and maximum tariffs](https://www.rijksoverheid.nl/vraag-en-antwoord/taxi/wat-zijn-de-kosten-voor-een-taxi)
- [Stb. 2025, 161 (CDT)](https://www.njb.nl/wetgeving/staatsbladen/centrale-database-taxivervoer/)
- [Kamerstuk 36 800 VI nr. 139 (continuous screening, chauffeurskaart)](https://zoek.officielebekendmakingen.nl/kst-36800-VI-139.pdf)
- [Kiwa Register privacy statement: verification answers](https://www.kiwaregister.com/getmedia/6efc3256-7796-4103-a8f3-839598a26cb2/Kiwa-Register_Land_Matrix_Privacy-Statement_AVG_EN.pdf)
- [RDW open data, registered vehicles](https://opendata.rdw.nl/resource/m9d7-ebf2.json) (fields `taxi_indicator`, `wam_verzekerd`, `vervaldatum_apk`; queried 5 November 2026)
- [CBb 8 December 2014, UberPop (ECLI:NL:CBB:2014:450)](https://omgevingsweb.nl/jurisprudentie/eclinlcbb2014450/)
- [Uber settles the UberPop case, 2019](https://dutchnews.nl/2019/03/five-years-on-uber-settles-dutch-uberpop-case-for-e2-3m)
- [Uber NL driver requirements](https://www.uber.com/nl/en/drive/requirements)

Privacy and the BSN:

- [Rijksoverheid: copies of an ID and the BSN](https://www.rijksoverheid.nl/vraag-en-antwoord/identiteitsfraude/ben-ik-verplicht-om-een-kopie-van-mijn-identiteitsbewijs-te-geven-aan-een-bedrijf)
- [Rijksoverheid: what the chip holds](https://www.rijksoverheid.nl/vraag-en-antwoord/paspoort-en-identiteitskaart/wat-is-een-elektronisch-reisdocument-en-welke-gegevens-bevat-de-chip-hierin)
- [The BSN out of the chip since 2021 (Tweede Golf)](https://tweedegolf.nl/en/blog/54/the-future-of-the-bsn-and-dutch-identification/)
- [UAVG article 29 and the AP on facial recognition](https://www.securitymanagement.nl/ap-geeft-antwoord-op-prangende-juridische-vragen-over-gezichtsherkenning/)
- [Kamerstukken on article 29](https://zoek.officielebekendmakingen.nl/ah-tk-20192020-1414.html)
- [AI Act Annex III](https://ai-act-service-desk.ec.europa.eu/en/ai-act/annex-3)
- [Platform Work Directive, summary](https://www.taylorwessing.com/en/insights-and-events/insights/2024/11/radar---eu-platform-work-directive-brings-in-new-protections-for-platform-professionals)
- [Dutch Wet platformwerk](https://www.globalworkplaceinsider.com/2026/09/the-platform-work-act-implementing-the-eu-platform-work-directive-in-the-netherlands/)
- [DAC7 at the Belastingdienst](https://www.belastingdienst.nl/wps/wcm/connect/en/business/content/eu-directive-administrative-cooperation-digital-platforms-dac7)
- [PwC on DAC7 and the BSN](https://www.pwc.nl/nl/actueel-en-publicaties/belastingnieuws/overig/wetsvoorstel-dac7-naar-de-tweede-kamer.html)
- [EDI-wallet, end of 2026](https://www.binnenlandsbestuur.nl/digitaal/vijf-vragen-over-de-aankomende-edi-wallet)
- [Google Play: User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)

Vendors and tools:

- [Signicat ReadID docs](https://developer.signicat.com/docs/id-document-and-biometric-verification/provider-specific-integrations/signicat-readid/about-readid/)
- [Signicat buys Inverid](https://www.biometricupdate.com/202507/signicat-forms-european-identity-powerhouse-with-inverid-acquisition)
- [ReadID on G-Cloud](https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/275785064788228)
- [Veriff pricing](https://www.veriff.com/pricing)
- [Veriff iOS NFC](https://devdocs.veriff.com/docs/ios-sdk-nfc-data-listener)
- [Veriff: data stored in Ireland](https://help.veriff.com/en/articles/6897946-do-you-need-to-store-your-customer-personal-data)
- [Sumsub pricing](https://sumsub.com/pricing/)
- [Price comparison, 2026](https://trustswiftly.com/blog/identity-verification-pricing-comparison-and-alternatives/)
- [iDenfy NFC](https://www.paymentsjournal.com/idenfy-new-identity-verification-tool-leverages-nfc-technology-to-confirm-real-users/)
- [IDnow NFC](https://doc.idnow.de/core-features)
- [Entrust (Onfido) NFC and Motion](https://documentation.identity.entrust.com/guide/etsi-certified-idv/)
- [CM.com iDIN prices](https://www.cm.com/nl-nl/producten/toegang/idin/)
- [KvK API](https://kvk.nl/en/ordering-products/kvk-api)
- [NFCPassportReader](https://github.com/AndyQ/NFCPassportReader)
- [Info.plist keys for chip reading](https://pub.dev/packages/biometric_passport_nfc)
