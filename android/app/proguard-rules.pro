# Kotlinx serialization keeps what it needs through its own rules.
# Bouncy Castle: the app's own crypto uses its classes directly, but reading an ID's chip goes through its JCA provider (JMRTD asks
# for "ISO9797Alg3Mac", ECDH, AES-CMAC and the like by name), which finds every algorithm by class name. Without these the release
# build had none of them, and no chip could be opened: PACE and BAC both failed, which showed as "These details don't open the chip".
-keep class org.bouncycastle.jcajce.provider.** { *; }
-keep class org.bouncycastle.jce.provider.** { *; }
-dontwarn org.bouncycastle.**
-keep class org.maplibre.** { *; }
-dontwarn org.maplibre.**
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
# The driver checks: JMRTD and its smart card layer find some classes by name.
-keep class org.jmrtd.** { *; }
-keep class net.sf.scuba.** { *; }
-dontwarn org.jmrtd.**
-dontwarn net.sf.scuba.**
-dontwarn org.ejbca.**
-dontwarn ucar.**
-dontwarn jj2000.**
-dontwarn colorspace.**
-dontwarn icc.**
-dontwarn java.awt.**
-dontwarn javax.imageio.**
