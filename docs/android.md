# Drivezzz on Android

## Ready for Google Play: 6 November 2026, evening

**Android 16 only for now (Pieter, 7 November 2026): older versions can be added later.** `minSdk` 36, target 36. It has run on 8 to 16 before (6 November), so going back down is mostly `minSdk` and testing.

**An APK for a phone**: `./gradlew :app:assembleLive -Pabi=arm64-v8a` makes `app/build/outputs/apk/live/app-live.apk`, about 62 MB: the release build on the live server, signed with this Mac's debug key, only for ARM64 phones (the POCO is one). Android Studio's own way to build for one device (`android.injected.build.abi`) marks the APK test-only, and a phone refuses to install that. A phone with this APK has to remove it before installing from Play, as Play signs with another key. Real accounts and real money.

**The website** was deployed on 7 November 2026 (Pieter's go): the account deletion section on Support (`#delete`), the ML Kit line in Privacy, and the server's Android push code (off until `FCM_KEY_FILE`). The server tests pass, 90 of 90, also with `WORKERS=2`.

**Everything for Play is in `PLAY_STORE.md` and `android/play/`**: the signed bundle (`drivezzz-1.0-3.aab`, about 38 MB to download), icon, feature graphic, 8 screenshots, the location video, every form's answers and a note for testers.

### One look

iOS is the design. Android should read as the same app, so **compare a screen with iOS before calling it done**, and don't accept Material's defaults. How: a throwaway iPhone and an emulator on the test server, logged in to the same demo account at the same spot (`/root/drivezzz-test-review.txt`, made with `make-review-account.js`), so both show the same drivers and the same live ride. Both were put side by side for Home, the quote, paying, check-in, the ride, the review, Rides, Chat and Profile.

What changed to get there:
- **The map** (`calm` in `map/DzMap.kt`): OpenFreeMap's styles recoloured with values sampled from iOS's own map, light and dark: pale land, white streets, grey main roads, no yellow. Close in, the big city name goes, as on iOS. Minor streets aren't in the tiles below zoom 13, so far out iOS shows more of them.
- **The tab bar** (`TabBar` in `features/Root.kt`): an icon over a small word, 50 dp, no pill. It follows iOS 18, which Pieter's iPhone runs. iOS 26 floats its bar in glass; that isn't copied.
- **The panel** (`panelMiddle`): measured as on iOS, with the tab bar counted in, so the map keeps its room. The route is framed after the panel has settled, with iOS's insets.
- **Controls** (`ui/Controls.kt`): switch (51 x 31), slider, spinner, action sheet for `AskDialog`, centred alert (`DzAlert`), rounded menus with the icon on the right, and a press that dims instead of a ripple (`PressDim`).
- **Details**: a car from the side and a kick scooter (`Sym.carSide`, `Sym.scooter`, drawn here, as Material has neither), a chevron for back, ··· for menus, centred short titles and lower large titles (`Screen`), a visible track on segmented controls, `Close` top left, the plate under the driver's pin, chevrons on ride rows.

Left different on purpose: Android's own date and time pickers, its share and permission dialogs, Roboto instead of San Francisco (San Francisco may not be used outside Apple's platforms; Inter would be closer, and adding it is a small change in `ui/Theme.kt` but takes a look at every screen).

### Found and fixed

- **Notifications were never asked for on a first start**, on every supported version. Location and notifications were requested in the same frame and Android dropped the second, so a new driver had no "You're online" notification, no Go offline button and no "New ride" alert. Requests now wait in line (`Permissions`, with `PermissionsTest`), and going online asks again if it's still off. Android 8 hid this, as it has no such permission.

### Tried on Android 16, on the final code, against the test server

- A first start: both permission questions, one after the other.
- A whole ride with a pretend driver (`flow.py`): install, search, quote, book, test payment, check-in, ride, check-out, review.
- **Going online with the app closed**: online, app removed from Recents (`am stack remove`, as the emulator's Recents ignored a scripted swipe), the server kept hearing it every 60 s for over 5 minutes, past its 3-minute limit. "New ride" arrived with the app closed, tapping it opened the offer, Accept started the drive, and Go offline in the notification took the driver offline and stopped the service.
- Refusing notifications doesn't block going online.
- **The demo account as Google's reviewer will use it**: login, a ride that plays out, add a vehicle, go online, a demo offer, accept, cancel.
- The real bundle: installed from `app-release.aab`, reached the live server, EULA shown, not accepted, so no account was made there.
- 42 unit tests pass (6 relay tests skipped, as by default).

Note for testing the demo world: its pretend drivers follow the position the server last heard, which for a rider is only sent now and then. Jumping the emulator somewhere else leaves them behind and a quote says nobody's there. Restart the app after moving it.

### Not proven

A real phone (an APK for the POCO is ready, not yet installed), a real wallet paying on Android, real ID checks, push (no Firebase project), and an Android rider with an iPhone driver.

## Later on 6 November 2026: every Android version, and Google Play

**Tried on emulators against the test server (`qa` build), a whole ride as rider with a pretend driver**: Android 8 (API 26, 1080x1920), 9 (API 28, 4.7" 768x1280), 11, 12, 13, 14 (small 720x1280), 15 and 16. Driver side (online, offer, accept, directions, pickup, check-in, check-out) on Android 8, 14 and 16. Scripts: `flow.py` and `make-driver.py` were in the session's scratchpad; `make-driver.py` makes an app-made test account a driver by writing a session to the test database and calling the API as `contract/test/test-driver.mjs` does.

Fixed:
- **MapLibre's default Vulkan build crashed on start on Android 8 and 9** ("No Vulkan compatible GPU found"): now `android-sdk-opengl`, and the manifest requires OpenGL ES 3 so Play only offers the app to phones that have it. Emulators for API 26, 30 and up need `-feature GLESDynamicVersion` to offer ES 3; API 31-34 images need `kernel.parameters=clearcpuid=517 ...` (a number: their kernels don't know `waitpkg`).
- **Going online didn't wake the position loop** (Android and iOS): it could sit in a rider's 5-minute wait, and the server takes a driver offline after 3 minutes without a position. Seen in the background on Android 8 and 14; fixed with `nudge = true` in `goOnline`, then a position every 60 s.
- **Going online keeps you online with the app closed** (Pieter): swiping the app away no longer goes offline; the notification has Go offline. Tried on Android 8. iOS still goes offline on close (`closingApp`): an iPhone app can't send its position once swiped away; significant-change relaunch would be the way.
- **After Continue the app starts on Home** (both apps): `reset()` sets the tabs and mode back, so logging out or deleting from Profile no longer lands the next account on Profile. Android tried; iOS compiled, not run.
- Small screens: the route on the map is framed like iOS (`fit`, 1.6 times the box, room for pin heads), the check-in sheet keeps its button in view, the keyboard's search key puts the keyboard away.
- `debug` now means the live server, like iOS (Pieter). `qa` is the test server build.

**Push (FCM)**: built in the app and the server, tested against a pretend Google (`server/test/push.test.js`, all 90 server tests pass but one: `eula.test.js` wants the postal address another session removed from the EULA). Off until the Firebase project exists: decision 1 above.

**Google Play, ready here**: upload key `android/drivezzz-upload.jks` with its passwords in `android/keystore.properties` (both git-ignored: back them up, e.g. in a password manager; Play App Signing can reset a lost upload key). `./gradlew :app:bundleRelease` makes `app/build/outputs/bundle/release/app-release.aab`, signed, versionCode 1: 79 MB, about 38 MB to download on a phone (bundletool). The release build was installed from the bundle on Android 8 and reached the live server (EULA shown, declined, no account made). Native libraries are 16 KB aligned. The support page now has a way to ask for deletion without the app (Play asks for that URL: https://drivezzz.s3rver.nl/support#delete): **not deployed yet**.

**Next, for Play** (needs Pieter or his OK in the browser): create the app in Play Console (name Drivezzz, free, app); App content: privacy policy URL, app access with the review login from APP_STORE.md section 7, no ads, content rating (users interact, share location; 18+), target audience 18+, data safety (location precise and approximate, name, email, user IDs, device ID, photos, messages, other financial info and purchase history, all for app functionality, encrypted in transit, deletable), financial features (pays for a service from the user's own wallet; not a wallet or exchange), foreground service location declaration with a short video of going online and the notification. Store listing: short description "Rides at drivers' own prices. See the cheapest driver or name your own price.", the description from APP_STORE.md section 3 (Android: the notification instead of the blue bar), icon from `drivezzz/Assets.xcassets/AppIcon.appiconset/icon-1024.png` at 512, a 1024x500 feature graphic, phone screenshots at 9:16 from the Android 8 emulator (Play refuses the iPhone ones: taller than 2:1, and they must show Android). Then a **closed test**: a Google Group anyone can join as the tester list, the opt-in link to share, at least 12 testers opted in for 14 days in a row before a personal account can ask for production.

## Where this stands, 6 November 2026

Done and tried on the emulator against the test server (`drivezzz_test`, port 5556):
- **Caught up with the iPhone**: the driver checks for the Netherlands and the blue check, picking a driver with "Book with …", the vehicle pointing the way it moves, fewer requests and no rider on the driver's map. What was tried and what's only built: Waiting for Android and Driver checks below. A car's checks always reach a person on Android (decision 8), and the app got much bigger (decision 10).
- **Moving the map no longer picks a driver or a drop-off** (`FingerWatch` in `map/DzMap.kt`): a tap is a touch of at most 350 ms that stays within 6 dp, on a map that isn't gliding. A nudge, stopping a glide and a swipe starting on a pin all did nothing; a real tap on a pin still works. A hold is half a second, as on iOS, so a resting finger doesn't move the pickup. The half second has unit tests but wasn't run again on the emulator after it went in.
- **The map opens with you and the drivers in view**: a camera move used to cancel the panel's padding, leaving them under the panel (`clearOfCover`).
- **Portrait always**: tried turned at phone size, and at 1600 x 2560, where Android 16 ignores the lock without `PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`. That property stops working at targetSdk 37.
- **The EULA**: Continue opens it (`features/Eula.kt`), Accept makes the account, and the test server recorded version 1. Profile has the Licence agreement row, which wasn't looked at on screen.

Built, not seen running:
- **`ChainQueueNote`** on the pay card and the wallet sheet: the test server never has a line, so it needs a proxy answering `/api/chain/queue` with `seconds` of 3 or more.
- **The `live` variant**: `./gradlew :app:assembleLive`, the release build on the live server signed with the debug key, for Pieter's own phone next to his iPhone. `qa` and `debug` only reach the test server, so they never see an iPhone on live.

**Next, not done: the test Pieter asked for.** An Android driver picking up an iOS rider and the reverse, on the test server, with the current code. It was last tried on 5 November, before the blue check rule. Plan: make the driver through the API as `contract/test/test-driver.mjs` does (`/api/driver/enable`, a car, its photos, a wallet address, rules seen, `/api/checks/fake`), add an email and password with `/api/auth/register`, log in on the app under test, and run the rider on a throwaway iOS simulator with `-serverURLOverride http://your-server:8090`. Then the same on Pieter's POCO, as nothing here has touched a real phone.

The 45 unit tests pass (`RelayTest`'s 6 are skipped unless asked for). The audit compared API calls, model fields, screen text, polling and `AppState` with iOS: only App Attest is left missing, on purpose. It didn't run every screen. Nothing is committed. Left on the test server: account `dz-4gcyct`.

Status, 4 November 2026: the whole iPhone app is ported to Kotlin and Jetpack Compose in `android/`, package `eu.drivezzz.app`, about 14,000 lines. It builds from the command line and a full ride works on an emulator against the test server, as rider and as driver. No real wallet app and no real phone have touched it yet. Nothing is committed, and the server wasn't changed.

Two things stand between this and a release: **push** (Firebase, below) and **your Google Play account and upload key**. The privacy page names Android's services, online since 5 November 2026.

## Decisions for you

Each has a working default behind one small seam, so none of them blocks anything yet.

| # | Decision | What it does now | What I need from you |
|---|---|---|---|
| 1 | **Push** | Built on both ends, off until there's a Firebase project. The app reads `android/app/google-services.json` at build time (no Google plugin, `build.gradle.kts`) and starts Firebase itself (`Push` and `PushService` in `core/Notifier.kt`). The server sends through FCM's HTTP v1 API with a service account key (`FCM_KEY_FILE`, `server/src/push.js`), next to APNs; `push_env` is `fcm` for an Android phone. The app first asks the server (`PATCH /api/me` answers `fcmOn`) and only sends its token to a server that pushes through Firebase, so an older server never hands it to Apple. `server/test/push.test.js` runs it against a pretend Google. Until then: the app says things itself while it runs, and stays awake through a foreground service from ordering until the ride or drive is over; a closed app hears nothing (no "a driver claimed your planned ride", no new message). | A Firebase project for `eu.drivezzz.app` (console.firebase.google.com, same Google account as Play): its `google-services.json` into `android/app/`, and a service account key (Project settings, Service accounts, Generate new private key) on the server, root only, as `FCM_KEY_FILE` in `/etc/default/drivezzz` and `/etc/default/drivezzz-test`. **Deploy the server before shipping an app build with the json in it.** |
| 2 | **Google Play** | No account, no signing. A release build comes out unsigned. | An account, and an upload key in `android/keystore.properties` (not in git: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`). As far as I know a new personal account must also run a closed test with 12 testers for 14 days before production, and an organisation account doesn't: check that when you choose. Play also asks for a declaration with a video for location in a foreground service. |
| 3 | **Privacy page** | `server/public/privacy.html` now says what Android sends where: OpenFreeMap, Photon, the OSRM route server, the phone's own address service (Google or the phone's maker), no notification token, and a waiting rider's location in the background. Online since 5 November 2026, at your go. | A read when you can. It says plainly that we have no agreement with the three free services: that stops being needed once we host them or pay for them (row 4 and 5). |
| 4 | **Map** | MapLibre with OpenFreeMap's tiles: no key, no account, no bill. iOS uses Apple's. | Nothing, unless you want Google Maps: that needs an API key with billing, and only `map/DzMap.kt` changes. OpenFreeMap promises nothing, so before many drivers depend on it, tiles of our own or a paid host. **My advice: keep MapLibre.** |
| 5 | **Directions and address search** | Directions from OSRM's public demo server, the same one the server's quotes use. Search from Photon (komoot), with the phone's own geocoder for naming a spot. Both free, no key, no promises, and fair-use limits. What's typed, the position rounded to about a kilometre and the route's ends go to them. OSRM's [usage policy](https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy) asks for reasonable, non-commercial use, and its server logs requests. That goes for the server's quotes too, so also on iPhone. | Nothing for now. Before launch: our own OSRM and Photon, or paid ones. `map/Routing.kt`, `map/Places.kt`, and `OSRM_URL` on the server. |
| 6 | **Old chats on a new phone** | Chat keys stay on the phone. After a reinstall or on a new phone, old messages say they can't be read on this phone. New ones work. iPhones have iCloud Keychain for this. | Whether it matters. Google's Block Store is the likely answer, and it can't be tried without a Google account on a real phone. |
| 7 | **Banned phones** | The phone's id comes from Android's own id for this app, which survives reinstalling (tried). A factory reset gets around it, as erasing an iPhone does (`docs/todo.md`, item 12). | Whether to add Play Integrity later. |
| 8 | **Driver checks without App Attest** | The checks run on Android as on iOS, but the server can't tell that what an Android phone sends comes from the real app, so the face match, both document scans and the car's plate always wait for a person (`signedByApp` in `checks.js` says so). An Android driver with a car is never approved by itself. | Whether that's fine for launch. If not: Play Integrity, Android's App Attest. That's server work (checking Google's signed verdict next to `attest.js`) and a Google Cloud project, and a token from the app on each scan. |
| 9 | **ML Kit and the privacy page** | Text and faces are read on the phone with Google's ML Kit, its models inside the app: no picture leaves the phone. ML Kit does send Google figures about how it runs (Google's data disclosure lists them), and the Data safety answers in `PLAY_STORE.md` say so. `server/public/privacy.html` has the line, live since 7 November 2026. | A read when you can. |
| 10 | **Size** | The checks make the app much bigger: an arm64 phone gets about 64 MB from Play instead of about 20, and one APK for every kind of phone (`qa`) is 144 MB. Of that, ML Kit's text and face libraries are about 20 MB a phone, and SFace's weights 19 MB (the same as on iOS). | Nothing, or one of these: ML Kit through Google Play services instead of in the app (about 20 MB less, but the models download on first use and Google Play services must be there), the checks as a Play feature module downloaded when a driver opens them (only drivers with a car pay for it), or SFace's weights in 8 bits (10 MB less, scores a little off iOS's). |
| 11 | **JMRTD's licence** | The ID's chip is read with JMRTD and SCUBA, with CVC from EJBCA: LGPL 2.1 (JMRTD's own files say 2.1 or later; this note used to say 3.0). We may use them as they are, must say so and pass the licence on, and a changed copy must be published. Profile, Help, **Open source licences** (`features/Licences.kt`) lists every part with the full texts in `assets/licences/`, and needs updating when a library comes or goes. | A lawyer's look along with the other licences. |

## Running it

```bash
emulator -avd drivezzz_pixel -no-audio -no-boot-anim -gpu swangle
```

```bash
cd android && ./gradlew :app:assembleQa && adb install -r app/build/outputs/apk/qa/app-qa.apk
```

```bash
adb shell am start -n eu.drivezzz.app/.MainActivity
```

The `qa` build is the one to look at: it's what riders get, on the test server. `:app:installDebug` builds quicker, and is slower to use.

- **Why the emulator lags here**: `-gpu host` gets 17 ms a frame in the app (`dumpsys gfxinfo`), but on this Mac (AMD RX 580, macOS 26) its window stays black while the app runs fine inside. Everything that shows a picture draws on the processor: `swangle` is the best of those, at about 60 ms a frame over the map. So judge smoothness on a real phone. A mirror such as scrcpy over `-gpu host -no-window` should be smooth, but isn't tried. **Don't use `-gpu host` without a window either**: with MapLibre's Vulkan build (before it went to the OpenGL one) a ride page's small map never drew, and closing it froze the app for good, its main thread waiting on the map's render thread (`onSurfaceTextureDestroyed`, 6 November 2026).
- **The driver checks on an emulator**: no NFC and no face in its camera, so the ID step stops at "This phone can't read chips"; "Pretend to scan" fills the form in a debug build, which talks to the live server unless `serverURLOverride` points it at the test server first. `-camera-back emulated -camera-front emulated` gives the scanner and the document camera a picture. The test server's `/api/checks/fake` passes an account without documents (the app has no button for it, as on iOS).

- **Variants** (Pieter, 6 November 2026: Android is on the live server, like iOS): `debug` talks to the live server unless `serverURLOverride` says otherwise, as an iPhone debug build does, so set the override before anything that makes accounts. `qa` is a release build, shrunk by R8, on the test server: the one to test with. `release` is always the live server and allows no plain HTTP. `live` is the same as `release`, signed with the debug key to put on your own phone.
- **Another server**, debug only: `adb shell am start -n eu.drivezzz.app/.MainActivity --es serverURLOverride http://…`. Profile's last line says which server it's on.
- **This Mac's emulator**: every x86 Android 36 image panics at boot here (`invalid opcode` in `delay_halt_tpause`), as the i9-13900K offers an instruction Hypervisor.framework refuses. An AVD needs this line in its `config.ini`, and `drivezzz_pixel` and `flutter_pixel` have it: `kernel.parameters=clearcpuid=waitpkg clocksource=tsc tsc=reliable`. It then boots in about 70 seconds.
- **Toolchain**: all already here except what I added: Android 37 platform (Compose needs it to compile), Gradle 9.8.2 through the wrapper, AGP 9.5, Kotlin 2.4.21. `minSdk` 36, `targetSdk` 36. `java` isn't on the PATH in every shell: `$JAVA_HOME` is `~/development/jdk-21/Contents/Home`, which is also how to run `bundletool`.
- **Size**: 144 MB for `qa`, as MapLibre's and ML Kit's native code comes for four CPU types, plus SFace's 19 MB of weights. A Play app bundle splits that: an arm64 phone gets about 64 MB (decision 10).

## One market with the iPhone

Both apps talk to the same server, and an iPhone rider should be able to order from an Android driver and the other way round. The server doesn't know what kind of phone someone has: nothing in `server/src` looks at it, and `notify()` simply does nothing for someone without a push token.

- **Only on the same server**: a debug build means the live server on both, `qa` the test server, so an Android `qa` build and a debug iPhone don't see each other. Profile's last line says which it is. To put a real iPhone on the test server: `xcrun devicectl device process launch … eu.drivezzz.app -- -serverURLOverride http://your-server:8090`.
- **Tried, 5 November 2026**: an iPhone 17 Pro simulator ordered from an Android emulator driver on the test server, through paying, check-in, directions, check-out and a review, and the driver's wallet showed the €3.62 on its way (the price less the fee). The iPhone saw the Android driver's price on its map and its photos, and encrypted messages went both ways.
- **Not tried**: an Android rider ordering from an iPhone driver. It's the same server calls, and Android has ridden with the pretend driver.

## Waiting for Android

Pieter's decision, 5 November 2026: Apple first. What goes into the iPhone app and the server lands here afterwards. Nothing is waiting as of 6 November 2026; left out on purpose: App Attest (there's no Android version of it; see Driver checks).

Caught up, 6 November 2026, and tried on the emulator against the test server unless it says otherwise:
- **Your vehicle points the way it's moving**, whichever way the map is turned, and standing still it stays put (`DriveHeading` in `features/Navigation.kt`, as in `Navigation.swift`): on the Driving and Map tabs. Following a drive, the map stays where it is while the car stands still, instead of swaying with the GPS. Tried by moving the emulator's position; standing still is Built.
- **A tap picks a driver, a tap on the picked one opens their page**, on the map and in the list, with or without a route (`Booking.picked`). Picked before a route, the footer says "Book with …", which asks where to; "Anyone" lets go. The vehicle's picture in a row opens the driver's page, and holding a row still does too.
- **The blue check** (`VerifiedMark`, `VerifiedBadge`, `Theme.verified`): next to a driver's name in the lists, at the end of their pin's bubble, "Verified" on their page, by your own name on Profile (with a white rim on the coloured card) and My page. A car the RDW knows says "Checked" with a green circle, as on iOS.
- **The driver checks** (`features/checks/`): see Driver checks below. Going online with a car that needs them opens them (`need_checks`), and Profile has the Driving in the Netherlands row for anyone with a car or a blue check. "You drive for yourself" has the iPhone's text, with "Driving a car? Verify to get a blue check."
- **A car's back photo** sends the text read on it as `read` (ML Kit, on the phone), and says when the plate can't be read in it. Built: the emulator's photo picker has no car.
- **Fewer requests** (`docs/capacity.md`): news is waited for on an open connection (`wait=50`) only during a ride, a drive, drive mode or an open chat, and otherwise asked once a minute; the rider's map refreshes every 10 s (30 until 8 November 2026) only while Home is on screen with the app open, and its pins glide to where drivers are now; drivers ask for orders every 30 s and earnings every 2 minutes, only with the app open.
- **No rider on the driver's map**: the pin is gone; the server no longer sends where the rider is.
- **New drivers stay on Profile** when they switch to driving, as on iOS.

Caught up, 5 November 2026: pins (the first ones that fit get a bubble, a tap on a small one far out zooms in, holding one opens the driver's page), the first 50 with `sort` and `total`, the pickup (holding the map moves it, orange everywhere), saved routes (`core/SavedRoutes.kt`, Rides under Booked, a ride's page, the bookmark on Home's route), `distanceM` worked out on the phone, and the portrait lock.

- **Pins take no touches themselves**: `DzMap` finds the pin under a tap or a hold (`MapAnnotation.onTap`, `onHold`, `Modifier.mapTapArea()`), so a swipe that starts on a pin pans the map instead of opening that driver.

## Tests

```bash
cd android && ./gradlew :app:testDebugUnitTest
```

```bash
cd android && DRIVEZZZ_RELAY=1 ./gradlew :app:testDebugUnitTest --tests '*RelayTest*' --rerun
```

- **`CryptoTest`** against what the iPhone's own code produces: `ios-vectors.txt` comes from compiling `Core/NaCl.swift`, the secp256k1 and ECIES part of `MetaMaskConnect.swift` and CryptoKit, and running them. Base58, NaCl box, chat keys and sealing (E2E), WalletConnect's keys and cipher, ECIES. It also goes the other way: the Swift code opens what Kotlin sealed.
- **`RelayTest`** on the real relays, off by default as it needs the shared ssh connection. WalletConnect's own libraries (`wc-wallet.mjs`) and MetaMask's (`mm-wallet.mjs`, in `/home/dzbuild/mm` on the server) play the wallet. All 6 pass: connect, sign with the signature or the whole transaction back and the signature checked, MetaMask connect, sign, decline, no Solana account.
- **`FormatTest`**: money, distances, polylines, the word filter, the sun's height against `Core/Theme.swift`, server fields being optional.
- **`MrzTest`**: reading the code on an ID as `MRZ.swift` does: ICAO 9303's own passport, the Dutch card the iPhone pretends to scan, look-alikes (an O for a 0, a lost <, a blurry < read as a k), dates that can't be (2099, a sex that's a digit, the wrong place in a line), a number that's a guess, pieces of one line put together, the tally (6 looks over 2.5 s, a guess counts half, a rival holds it back), the dates.
- **`SFaceTest`**: the face match's network in Kotlin against ONNX Runtime running OpenCV Zoo's SFace on the same made-up picture (`test/resources/sface-reference.txt`, written by `android/tools/sface-weights.py`, which also makes the weights). Cosine 0.999997; under a second on the Mac.
- **`android/test/rider-sim.py`**: a pretend rider on the test server, to give the driver's side of the app something to do.
- **`android/fakewallet`**: a stand-in for Phantom, never shipped. It claims Phantom's package on the emulator and answers Phantom's deeplink protocol, so the real way out through an intent and back through `drivezzz://` runs. It shows that side of the app works, not what Phantom itself does.

## Screen by screen

**Tried**: on the emulator against the test server. **Tried, stand-in**: with a stand-in for what isn't there. **Built**: ported line by line and compiled, not seen running. Light and dark were both looked at, and blue and yellow.

### Starting and account

| iPhone | Android | State |
|---|---|---|
| Loading, Intro, What's your name | Same | Tried |
| Log in, Create a login | Same; a password with dashes goes through whole, the iOS `SecureField` bug | Tried, also a wrong password |
| Ban screen: reason, strikes, appeal once per 24 hours, Check again with its 30 seconds, comes back by itself | Same | Tried with a real strike on the test data |
| Ban after a decision ("You can't appeal again") | Same | Built |
| Location needed, precise location needed | Same; Android has "approximate" where iOS has reduced accuracy | Tried both |
| Delete account, Log out, rename | Same | Tried |
| Phone's id survives reinstalling | `ANDROID_ID`, hashed, separate for a test server | Tried: same account back after uninstalling |

### Riding

| iPhone | Android | State |
|---|---|---|
| Home: map with price tags, panel with three heights, filter, centre button | Same | Tried |
| Where to? with results, recents, change pickup, choose on the map | Same, on Photon | Tried; changing the pickup Built |
| Now or Plan, date and time | Android's own date and time pickers instead of iOS's inline one, same limits | Tried |
| Quote: route, moved-to-the-road notes, people, pet, vehicle, coin, offers, cancel terms | Same | Tried |
| A tap picks a driver, a tap on the picked one or their vehicle's picture opens their page; "Book with …" before a route | Same; holding a row opens the page too | Tried: picked, Book with, where to, booked and paid in SOL with the test button, checked in; again in cash, to check-out, "Paid in cash" and the review opening by itself; the page from the picture |
| The blue check in the list, on pins and on a driver's page | Same | Tried |
| Tap the map for a drop-off | Same | Tried |
| Name your price with the ruler | Same, with haptics | Tried |
| Driver's page: gallery, plate, prices, availability, reviews, Plan, Book, message, report, block | Same | Tried; full-screen gallery opened, its swiping Built |
| Ride panel, the road as progress bar, state card, escrow moment | Same | Tried |
| Pay card: countdown, test button, wallets | Same; test builds also offer "Try a wallet instead" | Tried |
| Cancel: free, then 50/50 | Same words from the same rules | Tried both |
| Driver late: green full-refund button | Same | Built: needs a driver who stays away |
| Check-in sheet, by itself within 100 m | Same | Tried |
| Arrived: review opens by itself, heads-up about the drop-off | Same | Tried |
| Rides: current, booked, completed; ride's page | Same | Tried |
| Offer more on an open order | Same | Built |
| Appeal as a rider | Same sheet as the driver's | Built |
| Is everything OK? (drifting apart) | Same, dials 112 through the phone app | Built |

### Driving

| iPhone | Android | State |
|---|---|---|
| Slide to go online or offline, licence page once | Same | Tried; the server's "connect a wallet first" too, and a car without checks opening Driving in the Netherlands |
| Your vehicle points the way it's moving, and stays put standing still (`DriveHeading`) | Same | Tried by moving the emulator east: the car turned; standing still Built |
| Staying online in the background | Foreground service with a notification, Android's blue bar | Tried |
| Closing the app ends it | Not on Android (Pieter, 6 November 2026: going online keeps you online even if you close the app): swiped from recents, the service keeps sending the position every 60 s; the notification's Go offline ends it | Tried on Android 8: online for minutes after swiping it away, then offline from the notification |
| Android ends the app by itself: drive mode comes back | `driveWanted`, sticky service | Built: hard to force, and Android may refuse a location service restarted from the background |
| Offer with ring, map, facts; Accept, Decline | Same | Tried |
| Swiped down: waits on Driving and in Current on Drives | Same | Tried |
| Not answering in 5 minutes puts you offline, with the note | Same | Tried |
| Earnings panel, tiles, orders nearby, planned, prices around you | Same | Tried |
| Map tab: closest or highest, range, your vehicle with its heading | Same | Tried; range sheet Built |
| Order sheet: both routes, "A rider chose you", claim | Same | Tried |
| Drive on the map: banner, ETA, voice, follow or whole route, keep screen on | Same, on OSRM | Tried, by moving the emulator's position; voice not heard (no audio here) |
| Refused check-out when too far, Check out, Drive finished, heads-up | Same | Tried |
| Waiting at the pickup, its 10 minutes, "Rider not there" | Same | Tried up to "Stop at the pickup"; the countdown Built |
| Cancel with a reason | Same | Tried |
| Other maps | Google Maps and Waze if there, else any map app | Built: neither is on this emulator |
| Drives: current, agenda by day, completed with day totals | Same | Tried |
| "I can't make it" on a planned drive | Same | Tried |
| My page, Add vehicle with RDW lookup, Edit, photos with Android's photo picker, Vehicle page | Same | Tried; the required three photos through the real picker. The blue check by your name Tried |
| Several vehicles, Drive with this one, removing an extra photo, deleting a vehicle | Same | Built |
| Appeal and impossible drop-off report | Same | Tried |

### Messages

| iPhone | Android | State |
|---|---|---|
| Chat list, chat, rule of 3, end-to-end encryption | Same | Tried: the pretend driver's Node code read our messages and we read its answer |
| Swipe to remove | Same | Tried |
| Hold a chat for its menu | Same | Built |
| Report with the chat's keys | Same | Tried: the report went through, its keys not read back on the panel |
| Block, Blocked people, Unblock | Same | Tried |
| Word filter | Same | Unit tested |

### Wallet and profile

| iPhone | Android | State |
|---|---|---|
| Profile, appearance, colours, standing | Same, with Android's own light or dark bars | Tried; red not looked at |
| Blue check by your name, Driving in the Netherlands row | Same | Tried, before and after verified |
| Wallet: on hold, going out, coming in, history | Same | Tried with one payment going out |
| Connect a wallet: Trust, Phantom, Solflare, MetaMask, Another wallet | Same list, opening exactly that app; Google Play instead of the App Store | See below |
| Another wallet: QR, copy, open | Same | Tried: the app's QR read from a screenshot, the scripted wallet connected on the real relay |
| Phantom, Solflare | Same protocol | Phantom tried with the stand-in (decline, approve, pay). Solflare shares all that code; only its "isn't on this phone" with the Google Play link was run |
| Trust Wallet | Same protocol | "Isn't on this phone" tried. The rest is the WalletConnect above, and its `trust://` link isn't proven |
| MetaMask | Same protocol | Against MetaMask's own libraries in `RelayTest`. Through the app's button only "isn't on this phone" |
| Wallet lock, Request wallet change | Same | Tried up to "Your request is with support" |
| Pay with a wallet | Same | Tried with the stand-in, up to the server taking it on the pretend chain |
| Solana Pay link and QR | Same | Built |

### Other

| iPhone | Android | State |
|---|---|---|
| Room: panel beside the map when wide, pages stop at a width | Same rules; no device checks | Tried at 1800 x 1200 |
| Dark when it's dark outside | Same formulas | Tried, and unit tested against iOS |
| Local notifications | Same | Tried: "New ride", "Your driver is here" |
| Debug wallet log | `adb pull /sdcard/Android/data/eu.drivezzz.app/files/wallet-log.txt` | Tried |

## Not proven, plainly

- **Any real phone.** No real GPS, no hours in a car, no battery or data measurement. The 30 frames a second and the smoothness rules in `CLAUDE.md` were followed by design and not measured.
- **Any real wallet app.** They can't be installed on this emulator image, which has no Play Store. Trust, Phantom, Solflare and MetaMask may behave differently on Android than their documents say, and iOS has the same open item (`docs/todo.md`, item 1).
- **Real money or a real chain.** The stand-in's payment ran on the pretend chain, so the server didn't check a signature. WalletConnect's signing was checked in `RelayTest`, not end to end on devnet: `contract/test/e2e-server.mjs` against a `DEV=1` instance would do that, and needs the same app build.
- **The release build itself**: it has only been built, as it talks to the live server and I keep accounts off that. `qa` is the same build on the test server, and a booking through payment ran on it.
- **Push** on a phone: the code is there and tested against a pretend Google, but there's no Firebase project yet.
- **The driver checks on a real phone and a real ID**: the chip (PACE or BAC, the signature over our challenge, a JPEG 2000 photo), the selfie's head turn and the face match on real faces, and reading a real code through the camera. None of it can run on this emulator. Pieter's POCO and his own ID card would do it.
- **Voice directions** on a speaker. The emulator runs without audio. The words are English, as Android's come from OSRM's fields and not from a service that speaks the phone's language.
- **Tablets and foldables** beyond resizing the emulator.

## Differences worth knowing

- **Notifications without push**: see decision 1. To make up for it, a rider's phone stays awake from ordering on, not only from when a driver is coming as on iOS. That's a notification saying so and some battery.
- **The map's look**: OpenFreeMap's "liberty" in light and "dark" in dark, with shops and 3D buildings taken out. The dark style's roads were too faint to read, so they're lightened in `map/DzMap.kt`. Compare both with what you like on iOS.
- **Pickup and drop-off pins** are drawn by the app, close to Apple's `Marker`.
- **Reinstalling** loses the login, as Android has no Keychain that survives it. A no-login account comes back with Continue, by the phone's id. One with a login logs in.
- **Back button**: pages and sheets follow it, as Android expects.

## Left on the test server and elsewhere

- From 6 November 2026, evening: demo login `dz-review` (`review-test@drivezzz.test`, password in `/root/drivezzz-test-review.txt`) with vehicle RX-123-S, and a third car AD3636 on `dz-4gcyct`. Nothing on the live server.
- Test accounts on the test server: `dz-2eexqt` ("Android Rider", `android-test-1@example.com`, vehicle AN-DR-01), `dz-4yqz6v` ("Reinstall Test"), and "Sim Rider". Two lifted strikes and an appeal on `dz-2eexqt`, a report against the pretend driver, and an impossible drop-off report against Sim Rider.
- `/home/dzbuild/wc/sim-key.json` (a throwaway key for `RelayTest`) and `/home/dzbuild/mm` (MetaMask's libraries) on the server. The live server and its data weren't touched, and I didn't log in to any admin panel.
- `drivezzz_pixel` in `~/.android/avd`.
- On the test server, 6 November 2026: account `dz-4gcyct` agreed to the checks and sent a chauffeurskaart (`CK12345678`, a photo of the emulator's test picture) and KvK `12345678` from the Android app; another session then gave it a pretend pass and a second car, TD3636. Two rides of it with the pretend driver, one paid in SOL with the test button. Its AVD's `config.ini` wasn't changed: cameras and posters were only flags for those runs.

## For README and CLAUDE.md

README has an Android line under Running it since 6 November 2026. CLAUDE.md is left alone, as it holds uncommitted work; its checks rule still says "Not yet: … Android", which is now built (only App Attest isn't). Suggested line:

- CLAUDE.md, under Working here: "`android/` is the same app in Kotlin and Compose, screen for screen: a change to a screen or a rule goes in both. `core/E2E.kt`, `core/NaCl.kt` and `core/MetaMaskConnect.kt` must stay byte-compatible with their Swift twins (`CryptoTest`). Map, directions and search are behind `map/`. New server fields stay optional in `core/Models.kt` too. An FCM token must not reach the server until it speaks FCM."

## Your own phone over Wi-Fi

No cable: Android's wireless debugging, from Android 11 on, with the phone and this Mac on the same Wi-Fi.

1. On the phone: Settings, About phone, tap Build number 7 times. Then Developer options, turn on Wireless debugging.
2. Tap Pair device with pairing code. It shows an address like `phone-ip:37123` and a 6-digit code. That's a one-time step for this Mac.

```bash
adb pair phone-ip:37123 123456
```

3. The Wireless debugging screen shows another address, with another port, to connect to. It changes when wireless debugging restarts, so `adb mdns services` finds the current one.

```bash
adb connect phone-ip:41234
```

```bash
cd android && ./gradlew :app:assembleQa && adb install -r app/build/outputs/apk/qa/app-qa.apk
```

With an emulator running as well, say which device: `adb -s phone-ip:41234 install -r ...`. The `qa` build talks to the test server, which only works on the home network.

## Driver checks

Built on 6 November 2026 in `features/checks/`, screen for screen as `drivezzz/Features/Checks/`, against the same server routes (`server/src/checks.js`). The four steps, the consent page before the first, the pills (To do, Sent, A person checks, Expired, Done), the car's RDW line, the blue check and "Go online" at the bottom once verified; no test buttons, as on iOS.

| iPhone | Android | State |
|---|---|---|
| Driving in the Netherlands: opens from going online (`need_checks`) and from Profile | Same | Tried, both ways |
| Consent page before the first step | Same | Tried: saved on the test server |
| The ID's code read by our own camera, zoomed by the lens's closest focus (`MRZCapture`) | `MrzScanner.kt`: CameraX, ML Kit's text reading, the same frame, light and three bars; zoom from Camera2's `LENS_INFO_MINIMUM_FOCUS_DISTANCE` | The screen Tried on the emulator's camera; reading a real code Built (the emulator can't show one). The parsing (`Mrz.kt`, a port of `MRZ.swift`) has unit tests |
| No dates after a scan, typing in shows them | Same | Tried with "Pretend to scan" |
| "Pretend to scan" in a debug build on a simulator | Same, in a debug build on an emulator | Tried |
| The chip by NFC (NFCPassportReader): PACE or BAC, SOD, DG1, DG15 with its signature over our challenge, DG2's photo | `ChipReader.kt` with JMRTD; JPEG 2000 photos with JJ2000. A sheet says to hold the phone to the ID while Android's reader mode is on | Built: the emulator has no NFC, so only "This phone can't read chips" was seen. Until 7 November 2026 no release build (`live`, `qa`, `release`) could open a chip: R8 had removed Bouncy Castle's algorithms, which JMRTD asks for by name, so PACE and BAC failed and it said the details were wrong. Kept now (`proguard-rules.pro`); only the chip refusing the key says that, and why it failed is in the log (`adb logcat -s ChipReader`) |
| The selfie: front camera, straight, turn one way and the other as the server asked, straight again (`SelfieCapture`, Vision) | `Selfie.kt` with ML Kit's face finder, the same limits (its degrees turned into Vision's radians) | Built: the emulator's camera has no face |
| The face match on the phone, SFace on Core ML, only the score sent | `FaceMatch.kt` (ML Kit's eyes, nose and mouth, the same alignment) and `SFace.kt`: the same network and 16-bit weights in plain Kotlin, as ONNX Runtime would add 33 MB a kind of processor. Model name `sface-2021dec-fp16`, as iOS | `SFaceTest`: cosine 0.999997 against ONNX Runtime on the same input. On real faces Built |
| Chauffeurskaart and permit with the document camera, read on the phone | Our own camera with a frame the document's shape, the photo cut to it, read with ML Kit; the photo picker where there's no camera | Tried: sent to the test server, "Sent" |
| KvK number | Same | Tried: "Sent" |
| App Attest on the face, the scans and the plate | None: see decision 8 | Left out |
| A car's back photo sends what was read on it (`read`) | Same | Built |

Differences: the chip sheet is our own, as Android has no system one; the selfie compares the picture as others see you (not mirrored), as the ID photo is; after the selfie both say what the phone found: a good match says "Your face matches your ID" with "A person confirms it once more" when the server can't take it by itself (always on Android, which has no App Attest yet), and otherwise whether the face changed between the two pictures or didn't match the ID's photo clearly enough (7 November 2026: Android showed every match as if it wasn't one). `tools/sface-weights.py` makes SFace's weight file and the test's reference from OpenCV Zoo's model.

## A test on Google Play

An **internal test** is the way in: up to 100 testers, in their hands within minutes, and it doesn't need the 12 testers and 14 days a new personal account needs for production (that's a closed test). It takes a Play Console account and an upload key in `android/keystore.properties`, then `./gradlew :app:bundleRelease` makes the bundle to upload.

What testers get today, as `release` talks to the live server: riding works, paid in cash or, since 6 November 2026, with real money on Solana's real network (no Android phone has paid with a real wallet yet). Driving a car takes the checks, which an Android phone can now do, but a person always has to look (decision 8). Push is off until Firebase is set up.
